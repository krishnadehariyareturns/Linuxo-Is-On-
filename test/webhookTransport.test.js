'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../lib/logger/config');
const { createWebhookTransport, categoryFor, resolveCategory, backoffDelay, extractRetryAfterMs } = require('../lib/logger/webhookTransport');

function testConfig(overrides = {}) {
    return loadConfig({
        webhook: {
            batchSize: 10,
            flushIntervalMs: 100_000, // effectively "never due by time" unless a test wants it
            retryLimit: 2,
            retryBaseMs: 1,
            retryCapMs: 5,
            maxQueueSize: 5,
            highWaterMark: 3,
            circuitBreakerThreshold: 2,
            circuitBreakerCooldownMs: 30,
            categories: {
                logs: 'https://example.com/logs',
                errors: 'https://example.com/errors',
                security: 'https://example.com/security',
                performance: '',
                debug: '',
            },
            ...overrides,
        },
    });
}

function record(level, event, extra = {}) {
    return { level, event, timestamp: new Date().toISOString(), message: 'test', ...extra };
}

test('categoryFor routes by level and by explicit event overrides', () => {
    assert.equal(categoryFor(record('info', 'COMMAND_END')), 'logs');
    assert.equal(categoryFor(record('error', 'COMMAND_ERROR')), 'errors');
    assert.equal(categoryFor(record('fatal', 'BOT_CRASH')), 'errors');
    assert.equal(categoryFor(record('warn', 'COMMAND_PERMISSION_DENIED')), 'security');
    assert.equal(categoryFor(record('warn', 'SLOW_COMMAND')), 'performance');
    assert.equal(categoryFor(record('debug', 'CACHE_HIT')), 'debug');
});

test('resolveCategory falls back to logs when the primary category has no URL configured', () => {
    const config = testConfig({ categories: { logs: 'https://example.com/logs', errors: '', security: '', performance: '', debug: '' } });
    const cat = resolveCategory(record('error', 'COMMAND_ERROR'), config);
    assert.equal(cat, 'logs');
});

test('resolveCategory returns null when nothing in the chain is configured', () => {
    const config = testConfig({ categories: { logs: '', errors: '', security: '', performance: '', debug: '' } });
    const cat = resolveCategory(record('info', 'COMMAND_END'), config);
    assert.equal(cat, null);
});

test('route() respects per-category minimum level', () => {
    const config = testConfig();
    const sent = [];
    const transport = createWebhookTransport({ config, sendFn: async (cat, payload) => { sent.push({ cat, payload }); } });

    // errors category minLevel is 'error' by default — a WARN COMMAND_ERROR-ish
    // event still routes to 'errors' by categoryFor, but a plain warn that's
    // not error/fatal never resolves to 'errors' in the first place, so
    // instead test debug-level suppression against the 'logs' floor (info).
    const result = transport.route(record('debug', 'COMMAND_START'), { title: 'x' });
    assert.equal(result, null); // debug < logs' minLevel (info), and debug category has no URL
});

test('enqueued jobs are delivered on tick() and the queue drains on success', async () => {
    const config = testConfig();
    const sent = [];
    const transport = createWebhookTransport({ config, sendFn: async (cat, payload) => { sent.push({ cat, payload }); } });

    transport.route(record('info', 'COMMAND_END'), { title: 'ok' });
    assert.equal(transport.getStats().logs.queued, 1);

    await transport.flush('logs', { force: true });
    assert.equal(transport.getStats().logs.queued, 0);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].cat, 'logs');
    assert.equal(sent[0].payload.embeds.length, 1);
});

test('flush is gated by batchSize when not forced', async () => {
    const config = testConfig({ batchSize: 5, flushIntervalMs: 100_000 });
    const sent = [];
    const transport = createWebhookTransport({ config, sendFn: async () => { sent.push(1); } });

    for (let i = 0; i < 3; i++) transport.route(record('info', 'COMMAND_END'), {});
    await transport.flush('logs'); // not forced, only 3 queued < batchSize 5, and not due by time
    assert.equal(sent.length, 0);
    assert.equal(transport.getStats().logs.queued, 3);

    for (let i = 0; i < 2; i++) transport.route(record('info', 'COMMAND_END'), {}); // now 5 queued, hits batchSize
    await transport.flush('logs');
    assert.equal(sent.length, 1); // one send call carrying all 5 embeds
    assert.equal(transport.getStats().logs.queued, 0);
});

test('batches larger than 10 embeds are split into multiple Discord-sized sends', async () => {
    const config = testConfig({ batchSize: 25, maxQueueSize: 100 });
    const calls = [];
    const transport = createWebhookTransport({ config, sendFn: async (cat, payload) => { calls.push(payload.embeds.length); } });

    for (let i = 0; i < 23; i++) transport.route(record('info', 'COMMAND_END'), {});
    await transport.flush('logs', { force: true });

    assert.deepEqual(calls, [10, 10, 3]);
});

test('retries on failure and eventually succeeds within retryLimit', async () => {
    const config = testConfig({ retryLimit: 3 });
    let attempts = 0;
    const transport = createWebhookTransport({
        config,
        sendFn: async () => {
            attempts++;
            if (attempts < 3) throw new Error('temporary failure');
        },
    });

    transport.route(record('info', 'COMMAND_END'), {});
    await transport.flush('logs', { force: true });

    assert.equal(attempts, 3);
    assert.equal(transport.getStats().logs.queued, 0); // eventually delivered, not stuck
});

test('exhausting retries triggers onDeliveryFailure with the original records', async () => {
    const config = testConfig({ retryLimit: 1 });
    const failed = [];
    const transport = createWebhookTransport({
        config,
        sendFn: async () => { throw new Error('always fails'); },
        onDeliveryFailure: (category, records) => failed.push({ category, records }),
    });

    transport.route(record('info', 'COMMAND_END', { traceId: 't1' }), {});
    await transport.flush('logs', { force: true });

    assert.equal(failed.length, 1);
    assert.equal(failed[0].category, 'logs');
    assert.equal(failed[0].records[0].traceId, 't1');
});

test('respects a Discord-provided retry_after instead of blind backoff', async () => {
    const config = testConfig({ retryLimit: 2 });
    const delays = [];
    const internalLogs = [];
    let attempts = 0;
    const transport = createWebhookTransport({
        config,
        sendFn: async () => {
            attempts++;
            if (attempts === 1) {
                const err = new Error('rate limited');
                err.retryAfter = 5; // ms — @discordjs/rest's own field, always already-ms
                throw err;
            }
        },
        onInternalLog: (level, message, data) => internalLogs.push({ level, message, data }),
    });

    transport.route(record('info', 'COMMAND_END'), {});
    await transport.flush('logs', { force: true });

    const retryLog = internalLogs.find((l) => l.message.includes('retrying'));
    assert.ok(retryLog);
    assert.equal(retryLog.data.rateLimited, true);
});

test('circuit breaker opens after consecutiveFailures crosses threshold and blocks further sends', async () => {
    const config = testConfig({ retryLimit: 0, circuitBreakerThreshold: 2, circuitBreakerCooldownMs: 10_000 });
    let callCount = 0;
    const transport = createWebhookTransport({
        config,
        sendFn: async () => { callCount++; throw new Error('down'); },
    });

    transport.route(record('info', 'COMMAND_END'), {});
    await transport.flush('logs', { force: true }); // failure #1
    transport.route(record('info', 'COMMAND_END'), {});
    await transport.flush('logs', { force: true }); // failure #2 -> circuit should open

    assert.equal(transport.getStats().logs.circuitOpen, true);

    const callsBeforeOpen = callCount;
    transport.route(record('info', 'COMMAND_END'), {});
    await transport.flush('logs', { force: true }); // circuit open -> should NOT call sendFn again... but force bypasses circuit intentionally for shutdown flush semantics
    // Note: force=true is used by flushAll for shutdown and intentionally
    // still attempts delivery even with the circuit open (best-effort drain).
    // Test the *non-forced* path actually respects the open circuit instead:
    transport.route(record('info', 'COMMAND_END'), {});
    const beforeNonForced = callCount;
    await transport.flush('logs'); // not forced now
    assert.equal(callCount, beforeNonForced); // no new sendFn call — circuit is open
});

test('circuit closes again after a successful send once cooldown has elapsed', async () => {
    const config = testConfig({ retryLimit: 0, circuitBreakerThreshold: 1, circuitBreakerCooldownMs: 20 });
    let shouldFail = true;
    const transport = createWebhookTransport({
        config,
        sendFn: async () => { if (shouldFail) throw new Error('down'); },
    });

    transport.route(record('info', 'COMMAND_END'), {});
    await transport.flush('logs', { force: true });
    assert.equal(transport.getStats().logs.circuitOpen, true);

    shouldFail = false;
    await new Promise((resolve) => setTimeout(resolve, 30)); // let cooldown elapse
    transport.route(record('info', 'COMMAND_END'), {});
    await transport.flush('logs', { force: true });

    assert.equal(transport.getStats().logs.circuitOpen, false);
});

test('backpressure drops oldest entries once maxQueueSize is exceeded', () => {
    const config = testConfig({ maxQueueSize: 3 });
    const transport = createWebhookTransport({ config, sendFn: async () => {} });

    for (let i = 0; i < 6; i++) transport.route(record('info', 'COMMAND_END', { i }), {});

    const stats = transport.getStats().logs;
    assert.equal(stats.queued, 3);
    assert.equal(stats.dropped, 3);
});

test('flushAll force-drains every category regardless of batch/interval gating', async () => {
    const config = testConfig({ batchSize: 100, flushIntervalMs: 100_000 });
    const sent = [];
    const transport = createWebhookTransport({ config, sendFn: async (cat) => { sent.push(cat); } });

    transport.route(record('info', 'COMMAND_END'), {});
    transport.route(record('error', 'COMMAND_ERROR'), {});
    transport.route(record('warn', 'COMMAND_PERMISSION_DENIED'), {});

    await transport.flushAll({ timeoutMs: 2000 });

    assert.ok(sent.includes('logs'));
    assert.ok(sent.includes('errors'));
    assert.ok(sent.includes('security'));
});

test('backoffDelay grows exponentially and respects the cap', () => {
    const opts = { retryBaseMs: 100, retryCapMs: 1000 };
    const d1 = backoffDelay(1, opts);
    const d2 = backoffDelay(2, opts);
    const d5 = backoffDelay(5, opts);
    assert.ok(d1 >= 100 && d1 <= 120);
    assert.ok(d2 >= 200 && d2 <= 240);
    assert.ok(d5 <= 1200); // capped, plus max 20% jitter on the cap
});

test('extractRetryAfterMs reads several common error shapes', () => {
    assert.equal(extractRetryAfterMs({ retryAfter: 1500 }), 1500); // already ms, used as-is
    assert.equal(extractRetryAfterMs({ retry_after: 2 }), 2000); // seconds -> ms
    assert.equal(extractRetryAfterMs({ rawError: { retry_after: 3 } }), 3000);
    assert.equal(extractRetryAfterMs({ data: { retry_after: 0.5 } }), 500);
    assert.equal(extractRetryAfterMs({}), null);
});
