'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createLogger } = require('../src/lib/logger/core');
const { Events } = require('../src/lib/logger/eventNames');

function fakeEmbed(record) {
    return { __fake: true, record };
}

function makeLogger(overrides = {}) {
    const sent = [];
    const logger = createLogger({
        console: false,
        webhook: {
            enabled: true,
            flushIntervalMs: 0,
            batchSize: 1,
            retryLimit: 0,
            categories: {
                logs: 'https://example.com/logs',
                errors: 'https://example.com/errors',
                security: 'https://example.com/security',
                performance: 'https://example.com/performance',
                debug: 'https://example.com/debug',
            },
        },
        sendFn: async (category, payload) => { sent.push({ category, payload }); },
        buildEmbedFn: fakeEmbed,
        ...overrides,
    });
    return { logger, sent };
}

function recordsIn(sent) {
    return sent.flatMap((s) => s.payload.embeds.map((embed) => ({ category: s.category, ...embed.record })));
}

test('the global level floor suppresses lower-severity calls before anything else happens', async () => {
    const { logger, sent } = makeLogger({ level: 'warn' });
    logger.debug('SOME_DEBUG_EVENT', {});
    logger.info('SOME_INFO_EVENT', {});
    logger.warn('SOME_WARN_EVENT', {});
    await logger.flushAll({ timeoutMs: 1000 });

    const events = recordsIn(sent).map((r) => r.event);
    assert.ok(!events.includes('SOME_DEBUG_EVENT'));
    assert.ok(!events.includes('SOME_INFO_EVENT'));
    assert.ok(events.includes('SOME_WARN_EVENT'));
    logger.stopBackgroundTasks();
});

test('redaction is applied before a record reaches the webhook-facing side', async () => {
    const { logger, sent } = makeLogger();
    logger.info('LOGIN_ATTEMPT', { token: 'super-secret-value', guildId: 'g1' });
    await logger.flushAll({ timeoutMs: 1000 });

    const [record] = recordsIn(sent);
    assert.equal(record.token, '[REDACTED]');
    assert.equal(record.guildId, 'g1');
    logger.stopBackgroundTasks();
});

test('command() returns the handler result and records success stats', async () => {
    const { logger } = makeLogger();
    const result = await logger.command('ping', {}, async () => 'pong');
    assert.equal(result, 'pong');

    const snap = logger.getStatsSnapshot();
    assert.equal(snap.totalExecuted, 1);
    assert.equal(snap.totalSucceeded, 1);
    logger.stopBackgroundTasks();
});

test('command() re-throws the exact original error and records failure stats', async () => {
    const { logger } = makeLogger();
    const originalErr = new Error('boom');

    await assert.rejects(
        logger.command('ping', {}, async () => { throw originalErr; }),
        (err) => err === originalErr,
    );

    const snap = logger.getStatsSnapshot();
    assert.equal(snap.totalFailed, 1);
    logger.stopBackgroundTasks();
});

test('command() emits COMMAND_START then COMMAND_END on success, in order', async () => {
    const { logger, sent } = makeLogger();
    await logger.command('ping', {}, async () => {});
    await logger.flushAll({ timeoutMs: 1000 });

    const events = recordsIn(sent).map((r) => r.event);
    assert.deepEqual(events, [Events.COMMAND_START, Events.COMMAND_END]);
    logger.stopBackgroundTasks();
});

test('command() emits COMMAND_START then COMMAND_ERROR on failure, in order', async () => {
    const { logger, sent } = makeLogger();
    await assert.rejects(logger.command('ping', {}, async () => { throw new Error('x'); }));
    await logger.flushAll({ timeoutMs: 1000 });

    const events = recordsIn(sent).map((r) => r.event);
    assert.deepEqual(events, [Events.COMMAND_START, Events.COMMAND_ERROR]);
    logger.stopBackgroundTasks();
});

test('a command exceeding the slow threshold escalates to warn and emits SLOW_COMMAND to performance', async () => {
    const { logger, sent } = makeLogger({ performance: { warnCommandMs: 1, slowCommandMs: 1 } });
    await logger.command('backup', {}, async () => new Promise((resolve) => setTimeout(resolve, 15)));
    await logger.flushAll({ timeoutMs: 1000 });

    const records = recordsIn(sent);
    const slow = records.find((r) => r.event === Events.SLOW_COMMAND);
    const end = records.find((r) => r.event === Events.COMMAND_END);
    assert.ok(slow, 'expected a SLOW_COMMAND record');
    assert.equal(slow.category, 'performance');
    assert.equal(end.level, 'warn');
    logger.stopBackgroundTasks();
});

test('a fast command stays at info level with no SLOW_COMMAND event', async () => {
    const { logger, sent } = makeLogger({ performance: { warnCommandMs: 5000, slowCommandMs: 10000 } });
    await logger.command('ping', {}, async () => {});
    await logger.flushAll({ timeoutMs: 1000 });

    const records = recordsIn(sent);
    assert.ok(!records.some((r) => r.event === Events.SLOW_COMMAND));
    assert.equal(records.find((r) => r.event === Events.COMMAND_END).level, 'info');
    logger.stopBackgroundTasks();
});

test('button() wraps a component handler with its own lifecycle events', async () => {
    const { logger, sent } = makeLogger();
    const result = await logger.button('confirm_btn', {}, async () => 'handled');
    assert.equal(result, 'handled');
    await logger.flushAll({ timeoutMs: 1000 });

    const events = recordsIn(sent).map((r) => r.event);
    assert.deepEqual(events, [Events.BUTTON_START, Events.BUTTON_END]);
    logger.stopBackgroundTasks();
});

test('contextFor(interaction) exposes a mutable metrics object that flows into COMMAND_END', async () => {
    const { logger, sent } = makeLogger();
    const fakeInteraction = {};

    await logger.command('stats', { interaction: fakeInteraction }, async () => {
        const ctx = logger.contextFor(fakeInteraction);
        assert.ok(ctx, 'expected contextFor to return the registered context during execution');
        ctx.metrics.apiCalls = 3;
        ctx.metrics.cache = 'HIT';
    });

    // Registration is cleaned up once the command finishes.
    assert.equal(logger.contextFor(fakeInteraction), undefined);

    await logger.flushAll({ timeoutMs: 1000 });
    const end = recordsIn(sent).find((r) => r.event === Events.COMMAND_END);
    assert.equal(end.apiCalls, 3);
    assert.equal(end.cacheStatus, 'HIT');
    logger.stopBackgroundTasks();
});

test('repeated identical errors within the dedup window are suppressed on the webhook side', async () => {
    const { logger, sent } = makeLogger({ dedup: { windowMs: 60_000 } });
    const err = new Error('recurring failure');

    logger.error('COMMAND_ERROR', { command: 'ping' }, err);
    logger.error('COMMAND_ERROR', { command: 'ping' }, err);
    logger.error('COMMAND_ERROR', { command: 'ping' }, err);
    await logger.flushAll({ timeoutMs: 1000 });

    const errorSends = sent.filter((s) => s.category === 'errors');
    assert.equal(errorSends.length, 1, 'only the first occurrence should reach the webhook side');
    logger.stopBackgroundTasks();
});

test('logger.error accepts a bare Error as the 3rd positional argument (design-doc call shape)', async () => {
    const { logger, sent } = makeLogger();
    logger.error(Events.COMMAND_ERROR, { command: 'ping' }, new Error('boom'));
    await logger.flushAll({ timeoutMs: 1000 });

    const [record] = recordsIn(sent);
    assert.equal(record.error.name, 'Error');
    assert.equal(record.error.message, 'boom');
    logger.stopBackgroundTasks();
});

test('an internal logging failure (e.g. a broken buildEmbedFn) never throws out to the caller', () => {
    const { logger } = makeLogger({ buildEmbedFn: () => { throw new Error('embed builder exploded'); } });
    assert.doesNotThrow(() => logger.info('SOME_EVENT', {}));
    logger.stopBackgroundTasks();
});

test('reportStartup produces a readable report and reflects registered health checks', async () => {
    const { logger } = makeLogger({ webhook: { enabled: false } });
    logger.registerHealthCheck('TestCheck', async () => ({ ok: false, detail: 'unavailable' }));

    const report = await logger.reportStartup({ client: {}, commandsLoaded: 1, eventsLoaded: 5, webhooksConfigured: 0, startupDurationMs: 100 });
    assert.ok(report.text.includes('BOT STARTUP DIAGNOSTICS'));
    assert.equal(report.health, 'DEGRADED');
    logger.stopBackgroundTasks();
});

test('reportShutdown reflects commands actually executed on this logger instance', async () => {
    const { logger } = makeLogger({ webhook: { enabled: false } });
    await logger.command('ping', {}, async () => {});
    const report = await logger.reportShutdown({ shutdownDurationMs: 50 });
    assert.ok(report.text.includes('Commands executed : 1'));
    logger.stopBackgroundTasks();
});
