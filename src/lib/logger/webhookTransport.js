'use strict';

const { SECURITY_EVENTS, PERFORMANCE_EVENTS } = require('./eventNames');
const { isEnabled } = require('./levels');

const CATEGORIES = ['logs', 'errors', 'security', 'performance', 'debug'];

// If a record's primary category has no webhook URL configured, try the
// next one in its chain before giving up on Discord delivery entirely.
// `debug` and `logs` don't fall back further — debug being unconfigured is
// usually intentional (verbose/dev-only), and `logs` is already the base.
const FALLBACK_CHAIN = {
    errors: ['errors', 'logs'],
    security: ['security', 'logs'],
    performance: ['performance', 'logs'],
    debug: ['debug'],
    logs: ['logs'],
};

const DISCORD_EMBEDS_PER_MESSAGE = 10;

function categoryFor(record) {
    if (SECURITY_EVENTS.has(record.event)) return 'security';
    if (PERFORMANCE_EVENTS.has(record.event)) return 'performance';
    if (record.level === 'error' || record.level === 'fatal') return 'errors';
    if (record.level === 'debug' || record.level === 'trace') return 'debug';
    return 'logs';
}

function resolveCategory(record, config) {
    const primary = record.category || categoryFor(record);
    const chain = FALLBACK_CHAIN[primary] || [primary];
    for (const cat of chain) {
        if (config.webhook.categories[cat]) return cat;
    }
    return null;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(attempt, { retryBaseMs, retryCapMs }) {
    const exp = Math.min(retryCapMs, retryBaseMs * 2 ** (attempt - 1));
    const jitter = Math.random() * exp * 0.2;
    return Math.round(exp + jitter);
}

/**
 * Defensive extraction of a Discord-provided retry_after (ms), if present.
 * Keyed off *which* field matched rather than guessed from magnitude:
 * `.retryAfter` is @discordjs/rest's own convenience field and is already
 * milliseconds; `retry_after` (snake_case, possibly nested under a raw
 * error body) is Discord's raw API field and is always in seconds per
 * Discord's own API docs.
 */
function extractRetryAfterMs(err) {
    if (typeof err?.retryAfter === 'number' && Number.isFinite(err.retryAfter)) {
        return err.retryAfter;
    }
    const secondsCandidates = [err?.retry_after, err?.rawError?.retry_after, err?.data?.retry_after];
    for (const c of secondsCandidates) {
        if (typeof c === 'number' && Number.isFinite(c)) return Math.round(c * 1000);
    }
    return null;
}

function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

/**
 * Default production sendFn: lazily creates one discord.js WebhookClient per
 * configured category and posts embeds through it. Only required at the
 * point of actually sending, so this file has no top-level dependency on
 * discord.js and can be fully unit-tested with a fake sendFn.
 */
function createDefaultSendFn(config) {
    const clients = new Map();
    function clientFor(category) {
        if (clients.has(category)) return clients.get(category);
        const url = config.webhook.categories[category];
        if (!url) return null;
        // eslint-disable-next-line global-require
        const { WebhookClient } = require('discord.js');
        const client = new WebhookClient({ url });
        clients.set(category, client);
        return client;
    }
    return async function send(category, payload) {
        const client = clientFor(category);
        if (!client) throw new Error(`No webhook URL configured for category "${category}"`);
        await client.send(payload);
    };
}

/**
 * @param {object} opts
 * @param {object} opts.config - full logger config (see config.js)
 * @param {function} [opts.sendFn] - async (category, {embeds}) => void. Defaults to a real discord.js WebhookClient sender. Inject a fake for tests.
 * @param {function} [opts.onInternalLog] - (level, message, data) => void. Called for the transport's OWN lifecycle events (retries, circuit state, backpressure) — console-only, never re-enters the webhook queue.
 * @param {function} [opts.onDeliveryFailure] - (category, records) => void. Called when a batch exhausts all retries, so the caller can dump it to console/file as a fallback.
 */
function createWebhookTransport({ config, sendFn, onInternalLog, onDeliveryFailure } = {}) {
    const send = sendFn || createDefaultSendFn(config);
    const log = onInternalLog || (() => {});
    const deliveryFailure = onDeliveryFailure || (() => {});

    const state = {};
    for (const cat of CATEGORIES) {
        state[cat] = {
            queue: [],
            consecutiveFailures: 0,
            circuitOpenUntil: 0,
            droppedCount: 0,
            highWaterWarned: false,
            lastBackpressureWarnAt: 0,
        };
    }

    function isCircuitOpen(cat) {
        return state[cat].circuitOpenUntil > Date.now();
    }

    /** Route one record (+ its prebuilt embed) into the right category's queue, if it clears that category's min level and a webhook URL is actually configured for it (after fallback). */
    function route(record, embed) {
        if (!config.webhook.enabled) return null;
        const category = resolveCategory(record, config);
        if (!category) return null;
        if (!isEnabled(config.webhook.minLevels[category], record.level)) return null;

        enqueue(category, { embed, record, addedAt: Date.now() });
        return category;
    }

    function enqueue(category, job) {
        const s = state[category];
        s.queue.push(job);

        if (s.queue.length > config.webhook.maxQueueSize) {
            s.queue.shift();
            s.droppedCount++;
            const now = Date.now();
            if (now - s.lastBackpressureWarnAt > 10_000) {
                s.lastBackpressureWarnAt = now;
                log('warn', `webhook queue for "${category}" exceeded maxQueueSize; dropping oldest entries`, {
                    category,
                    maxQueueSize: config.webhook.maxQueueSize,
                    droppedCount: s.droppedCount,
                });
            }
        }

        if (s.queue.length >= config.webhook.highWaterMark && !s.highWaterWarned) {
            s.highWaterWarned = true;
            log('warn', `webhook queue for "${category}" crossed high-water mark`, {
                category,
                queued: s.queue.length,
                highWaterMark: config.webhook.highWaterMark,
            });
        } else if (s.queue.length < config.webhook.highWaterMark / 2) {
            s.highWaterWarned = false;
        }
    }

    /** Attempt delivery of one chunk (<=10 embeds) with retry+backoff. Resolves {ok:boolean}. */
    async function sendChunkWithRetry(category, jobs) {
        const s = state[category];
        const maxAttempts = config.webhook.retryLimit;
        let attempt = 0;

        while (attempt <= maxAttempts) {
            try {
                await send(category, { embeds: jobs.map((j) => j.embed) });
                s.consecutiveFailures = 0;
                if (s.circuitOpenUntil) {
                    s.circuitOpenUntil = 0;
                    log('info', `webhook circuit closed for "${category}"`, { category });
                }
                log('debug', `delivered ${jobs.length} record(s) to "${category}"`, { category, count: jobs.length });
                return { ok: true };
            } catch (err) {
                attempt++;
                const isLast = attempt > maxAttempts;
                if (!isLast) {
                    const retryAfter = extractRetryAfterMs(err);
                    const delay = retryAfter ?? backoffDelay(attempt, config.webhook);
                    log('warn', `webhook send to "${category}" failed, retrying`, {
                        category,
                        attempt,
                        maxAttempts,
                        delayMs: delay,
                        rateLimited: retryAfter !== null,
                        error: err?.message,
                    });
                    // eslint-disable-next-line no-await-in-loop
                    await sleep(delay);
                    continue;
                }

                s.consecutiveFailures++;
                log('error', `webhook send to "${category}" failed after ${maxAttempts} retries`, {
                    category,
                    error: err?.message,
                    consecutiveFailures: s.consecutiveFailures,
                });

                if (s.consecutiveFailures >= config.webhook.circuitBreakerThreshold && !isCircuitOpen(category)) {
                    s.circuitOpenUntil = Date.now() + config.webhook.circuitBreakerCooldownMs;
                    log('error', `webhook circuit opened for "${category}" after repeated failures`, {
                        category,
                        cooldownMs: config.webhook.circuitBreakerCooldownMs,
                    });
                }

                deliveryFailure(category, jobs.map((j) => j.record));
                return { ok: false };
            }
        }
        return { ok: false };
    }

    /** Flush one category: pull up to batchSize jobs, split into <=10-embed chunks (Discord's hard limit), send each. `force` bypasses the batch-size/interval gating (used at shutdown). */
    async function flush(category, { force = false } = {}) {
        const s = state[category];
        if (!s.queue.length) return;
        if (isCircuitOpen(category) && !force) return;

        // "Due by time" is based on how long the OLDEST queued item has been
        // waiting, not on when we last flushed — that way a freshly-arrived
        // item after a long idle period isn't treated as instantly overdue.
        const oldestAge = Date.now() - s.queue[0].addedAt;
        const dueByTime = oldestAge >= config.webhook.flushIntervalMs;
        const dueBySize = s.queue.length >= config.webhook.batchSize;
        if (!force && !dueByTime && !dueBySize) return;

        const takeCount = force ? s.queue.length : config.webhook.batchSize;
        const batch = s.queue.splice(0, takeCount);

        for (const jobs of chunk(batch, DISCORD_EMBEDS_PER_MESSAGE)) {
            // eslint-disable-next-line no-await-in-loop
            await sendChunkWithRetry(category, jobs);
        }
    }

    /** Called on an interval by core.js to drive normal batching. */
    async function tick() {
        await Promise.all(CATEGORIES.map((cat) => flush(cat)));
    }

    /** Best-effort drain of everything queued, bounded by timeoutMs — used at graceful shutdown so in-flight logs aren't silently lost. */
    async function flushAll({ timeoutMs = 5000 } = {}) {
        const work = Promise.all(CATEGORIES.map((cat) => flush(cat, { force: true })));
        const timeout = sleep(timeoutMs).then(() => 'timeout');
        return Promise.race([work.then(() => 'done'), timeout]);
    }

    function getStats() {
        const out = {};
        for (const cat of CATEGORIES) {
            const s = state[cat];
            out[cat] = {
                queued: s.queue.length,
                circuitOpen: isCircuitOpen(cat),
                consecutiveFailures: s.consecutiveFailures,
                dropped: s.droppedCount,
                configured: Boolean(config.webhook.categories[cat]),
            };
        }
        return out;
    }

    return { route, tick, flush, flushAll, getStats, CATEGORIES };
}

module.exports = { createWebhookTransport, categoryFor, resolveCategory, backoffDelay, extractRetryAfterMs, CATEGORIES };
