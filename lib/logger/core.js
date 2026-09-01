'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { monitorEventLoopDelay } = require('node:perf_hooks');

const { loadConfig, thresholdsFor } = require('./config');
const { isEnabled, colorize, DIM, BOLD, RESET } = require('./levels');
const { Events } = require('./eventNames');
const { createContext, childContext, fromInteraction, initStaticFields } = require('./context');
const { startTimer, elapsedMs } = require('./timer');
const { redact } = require('./redact');
const { normalizeError, safeSummary, fingerprint } = require('./errors');
const { CommandStats, ErrorDedup } = require('./stats');
const { renderBoxReport } = require('./reportBox');
const { buildEmbed } = require('./embeds');
const { createWebhookTransport } = require('./webhookTransport');
const {
    buildStartupReport: buildStartupReportRaw,
    buildShutdownReport: buildShutdownReportRaw,
    runHealthChecks,
    fmtDuration,
} = require('./diagnostics');

const BOX_EVENTS = new Set([Events.COMMAND_START, Events.COMMAND_END, Events.COMMAND_ERROR, Events.BUTTON_START, Events.BUTTON_END, Events.BUTTON_ERROR]);

function defaultHandlerName(name) {
    const clean = String(name).replace(/[^a-zA-Z0-9]/g, '');
    return `${clean.charAt(0).toUpperCase()}${clean.slice(1)}Command`;
}

function humanizeMessage(event, context, { status, error } = {}) {
    switch (event) {
        case Events.COMMAND_START:
            return `Command /${context.command}${context.subcommand ? ` ${context.subcommand}` : ''} started`;
        case Events.COMMAND_END:
            return `Command /${context.command} completed ${status === 'success' ? 'successfully' : 'with errors'} in ${Math.round(context.durationMs || 0)}ms`;
        case Events.COMMAND_ERROR:
            return `Command /${context.command} failed: ${error ? safeSummary(error) : 'unknown error'}`;
        case Events.BUTTON_START:
            return `Button "${context.customId}" pressed`;
        case Events.BUTTON_END:
            return `Button "${context.customId}" handled in ${Math.round(context.durationMs || 0)}ms`;
        case Events.BUTTON_ERROR:
            return `Button "${context.customId}" failed: ${error ? safeSummary(error) : 'unknown error'}`;
        case Events.BOT_READY:
            return 'Bot is ready';
        case Events.BOT_SHUTDOWN:
            return 'Bot is shutting down';
        case Events.BOT_CRASH:
            return 'Bot crashed';
        default:
            return event.replace(/_/g, ' ').toLowerCase();
    }
}

function compactContext(record) {
    const bits = [];
    for (const k of ['guildId', 'channelId', 'userId', 'traceId']) {
        if (record[k] !== undefined) bits.push(`${k}=${record[k]}`);
    }
    return bits.join(' ');
}

/**
 * A 3rd positional argument that's an Error is treated as {error: that}, so
 * `logger.error('COMMAND_ERROR', ctx, err)` works exactly as shown in the
 * design doc, while `logger.error('COMMAND_ERROR', ctx, {error, extra})`
 * still works for callers who want more control.
 */
function normalizeCallArgs(maybeOptions) {
    if (maybeOptions instanceof Error) return { error: maybeOptions };
    return maybeOptions || {};
}

/**
 * @param {object} overrides - config overrides, deep-merged over the env-var
 *   defaults (see config.js). `overrides.shardId` sets the static shardId
 *   field. `overrides.sendFn` and `overrides.buildEmbedFn` are a test-only
 *   escape hatch — injecting fakes for both makes the whole pipeline,
 *   including routing and error dedup, unit-testable without discord.js or
 *   network access. Real usage never needs to pass either; discord.js-backed
 *   defaults are used automatically.
 */
function createLogger(overrides = {}) {
    const { sendFn, buildEmbedFn, ...configOverrides } = overrides;
    const buildEmbedImpl = buildEmbedFn || buildEmbed;
    const config = loadConfig(configOverrides);
    initStaticFields({ botVersion: config.botVersion, shardId: overrides.shardId ?? 0 });

    const stats = new CommandStats({ windowSize: config.statsWindowSize });
    const dedup = new ErrorDedup({ windowMs: config.dedup.windowMs });
    const healthChecks = [];
    const contextByInteraction = new WeakMap();

    let fileStream = null;
    if (config.file) {
        try {
            fileStream = fs.createWriteStream(path.resolve(config.file), { flags: 'a' });
            fileStream.on('error', (err) => consoleWrite('warn', `log file write error: ${err.message}`));
        } catch (err) {
            consoleWrite('warn', `failed to open log file "${config.file}": ${err.message}`);
        }
    }

    function consoleWrite(level, message, data) {
        if (!config.console) return;
        const line = `${colorize(level, `[${level.toUpperCase()}]`)} ${DIM}(logger)${RESET} ${message}${data ? ` ${JSON.stringify(data)}` : ''}`;
        (level === 'error' || level === 'fatal' ? console.error : console.log)(line);
    }

    const transport = createWebhookTransport({
        config,
        sendFn,
        onInternalLog: (level, message, data) => consoleWrite(level, message, data),
        onDeliveryFailure: (category, records) => {
            consoleWrite('error', `webhook delivery to "${category}" exhausted retries — falling back to console/file for ${records.length} record(s)`);
            for (const r of records) writeJsonLine(r);
        },
    });

    // ---- durable transports: console (json or pretty) + optional file, always JSON ----
    function writeJsonLine(record) {
        const line = JSON.stringify(record);
        if (config.console && config.json) console.log(line);
        if (fileStream) fileStream.write(`${line}\n`);
    }

    function writePretty(record) {
        if (!config.console || config.json) return;
        if (BOX_EVENTS.has(record.event)) {
            const box = renderBoxReport('COMMAND REPORT', [
                ['Command', record.command ? `/${record.command}` : undefined],
                ['Component', record.customId],
                ['Status', record.status ? record.status.toUpperCase() : undefined],
                ['Duration', fmtDuration(record.durationMs)],
                ['Trace ID', record.traceId],
                ['Guild', record.guildName || record.guildId],
                ['User', record.userTag || record.userId],
                ['Handler', record.handler],
                ['API calls', record.apiCalls],
                ['Cache', record.cacheStatus],
                ['Error', record.error?.name],
                ['Code', record.error?.code],
                ['Retries', record.retryCount],
            ]);
            const painted = record.level === 'error' || record.level === 'fatal' ? colorize('error', box) : record.status === 'success' ? colorize('info', box) : box;
            (record.level === 'error' || record.level === 'fatal' ? console.error : console.log)(painted);
        } else {
            const line = `${colorize(record.level, `[${record.level.toUpperCase()}]`)} ${BOLD}${record.event}${RESET} ${record.message || ''} ${DIM}${compactContext(record)}${RESET}`;
            (record.level === 'error' || record.level === 'fatal' ? console.error : console.log)(line);
        }
    }

    /** The single funnel every public logging call goes through. Never throws. */
    function _emit(level, event, context = {}, options = {}) {
        try {
            if (!isEnabled(config.level, level)) return;

            const normalizedError = options.error !== undefined ? normalizeError(options.error) : null;
            const message = options.message || humanizeMessage(event, context, { status: options.status, error: normalizedError });

            let record = {
                timestamp: new Date().toISOString(),
                level,
                event,
                message,
                ...context,
                ...(options.extra || {}),
            };
            if (options.status) record.status = options.status;
            if (options.retryCount !== undefined) record.retryCount = options.retryCount;
            if (options.category) record.category = options.category;
            if (normalizedError) record.error = normalizedError;

            if (config.redaction.enabled) {
                record = redact(record, { extraKeys: config.redaction.extraKeys, maxStringLength: config.redaction.maxStringLength });
            }

            // Durable sink — always happens, this is the audit trail of record.
            writeJsonLine(record);
            writePretty(record);

            if (event === Events.COMMAND_END || event === Events.COMMAND_ERROR) {
                stats.record(context.command, { status: options.status, durationMs: context.durationMs, traceId: context.traceId });
            }

            if (!config.webhook.enabled) return;

            // Dedup only throttles the Discord-facing surface — console/json
            // above already has the complete record regardless.
            let webhookRecord = record;
            if (normalizedError && (level === 'error' || level === 'fatal')) {
                const fp = fingerprint(normalizedError, context);
                const result = dedup.check(fp);
                if (!result.shouldEmit) return;
                webhookRecord = { ...record, fingerprint: fp };
                if (result.previouslySuppressed > 0) webhookRecord.suppressedCount = result.previouslySuppressed;
            }

            const embed = buildEmbedImpl(webhookRecord);
            transport.route(webhookRecord, embed);
        } catch (err) {
            // The logger must never be the reason a command fails.
            try {
                console.error('[logger] internal error while logging (swallowed):', err);
            } catch {
                /* nothing further we can do */
            }
        }
    }

    const trace = (event, context, options) => _emit('trace', event, context, normalizeCallArgs(options));
    const debug = (event, context, options) => _emit('debug', event, context, normalizeCallArgs(options));
    const info = (event, context, options) => _emit('info', event, context, normalizeCallArgs(options));
    const warn = (event, context, options) => _emit('warn', event, context, normalizeCallArgs(options));
    const error = (event, context, options) => _emit('error', event, context, normalizeCallArgs(options));
    const fatal = (event, context, options) => _emit('fatal', event, context, normalizeCallArgs(options));

    /** Shared by command()/button(): START -> handler -> END|ERROR, with duration + optional slow-threshold escalation. */
    async function runLifecycle({ startEvent, endEvent, errorEvent, context, handler, category, thresholds, slowEvent }) {
        const t = startTimer();
        _emit('info', startEvent, context, { category });
        try {
            const result = await handler(context);
            const durationMs = elapsedMs(t);
            let level = 'info';
            if (thresholds) {
                level = durationMs >= thresholds.warnMs ? 'warn' : 'info';
                if (durationMs >= thresholds.slowMs && slowEvent) {
                    _emit('warn', slowEvent, { ...context, durationMs }, {
                        category: 'performance',
                        message: `/${context.command} took ${Math.round(durationMs)}ms (slow-command threshold ${thresholds.slowMs}ms)`,
                    });
                }
            }
            const metrics = context.metrics || {};
            _emit(level, endEvent, { ...context, durationMs, apiCalls: metrics.apiCalls, cacheStatus: metrics.cache }, { status: 'success', category });
            return result;
        } catch (err) {
            const durationMs = elapsedMs(t);
            _emit('error', errorEvent, { ...context, durationMs }, { status: 'failure', error: err, category: 'errors' });
            throw err; // preserve the original error untouched — the logger never swallows command failures
        }
    }

    /**
     * Wraps a slash-command handler with full lifecycle telemetry. Matches
     * the design doc's `logger.command(name, context, async () => {...})`
     * shape; the handler also optionally receives the enriched context as
     * its first argument for callers who want it (e.g. to log sub-steps
     * with the same traceId via logger.task()).
     *
     * baseContext.interaction (if provided) registers this call's context
     * in a WeakMap so the command's own handler can retrieve it via
     * logger.contextFor(interaction) and set ctx.metrics.apiCalls /
     * ctx.metrics.cache for richer reporting — entirely optional.
     */
    async function command(name, baseContext = {}, handler) {
        const { interaction, ...rest } = baseContext;
        const ctx = createContext({ ...rest, command: name, handler: rest.handler || defaultHandlerName(name), metrics: {} });
        if (interaction) contextByInteraction.set(interaction, ctx);
        try {
            return await runLifecycle({
                startEvent: Events.COMMAND_START,
                endEvent: Events.COMMAND_END,
                errorEvent: Events.COMMAND_ERROR,
                context: ctx,
                handler,
                category: 'logs',
                thresholds: thresholdsFor(config, name),
                slowEvent: Events.SLOW_COMMAND,
            });
        } finally {
            if (interaction) contextByInteraction.delete(interaction);
        }
    }

    /** Same idea as command(), for button/component interactions. */
    async function button(customId, baseContext = {}, handler) {
        const { interaction, ...rest } = baseContext;
        const ctx = createContext({ ...rest, customId, metrics: {} });
        if (interaction) contextByInteraction.set(interaction, ctx);
        try {
            return await runLifecycle({
                startEvent: Events.BUTTON_START,
                endEvent: Events.BUTTON_END,
                errorEvent: Events.BUTTON_ERROR,
                context: ctx,
                handler,
                category: 'logs',
            });
        } finally {
            if (interaction) contextByInteraction.delete(interaction);
        }
    }

    /**
     * Generic instrumentation for non-command async work (DB queries,
     * external API calls) — nothing in this bot uses it yet since there's
     * no database or external API integration, but the taxonomy events
     * (DATABASE_QUERY/DATABASE_ERROR, EXTERNAL_API_REQUEST/_ERROR) are
     * ready the moment one gets added:
     *   await logger.task({ event: Events.DATABASE_QUERY, errorEvent: Events.DATABASE_ERROR, context: logger.childContext(ctx), handler: () => db.query(...) })
     */
    async function task({ event, errorEvent, context, handler, category = 'debug' }) {
        const t = startTimer();
        try {
            const result = await handler(context);
            const durationMs = elapsedMs(t);
            _emit('debug', event, { ...context, durationMs }, { status: 'success', category });
            return result;
        } catch (err) {
            const durationMs = elapsedMs(t);
            _emit('warn', errorEvent, { ...context, durationMs }, { status: 'failure', error: err, category: 'errors' });
            throw err;
        }
    }

    function registerHealthCheck(name, check) {
        healthChecks.push({ name, check });
    }

    async function reportStartup(extra = {}) {
        const healthResults = await runHealthChecks(healthChecks);
        const report = buildStartupReportRaw({ config, healthResults, ...extra });

        if (config.console) console.log(config.json ? JSON.stringify(report.structured) : report.text);
        if (fileStream) fileStream.write(`${JSON.stringify(report.structured)}\n`);
        if (config.webhook.enabled) postTextReport('logs', 'BOT STARTUP DIAGNOSTICS', report.text, report.health === 'OK' ? 'info' : 'warn');

        return report;
    }

    async function reportShutdown(extra = {}) {
        const report = buildShutdownReportRaw({ statsSnapshot: stats.snapshot(), queueStats: transport.getStats(), ...extra });

        if (config.console) console.log(config.json ? JSON.stringify(report.structured) : report.text);
        if (fileStream) fileStream.write(`${JSON.stringify(report.structured)}\n`);
        if (config.webhook.enabled) postTextReport('logs', 'BOT SHUTDOWN REPORT', report.text, 'info');

        return report;
    }

    function postTextReport(category, title, text, level) {
        try {
            // eslint-disable-next-line global-require
            const { EmbedBuilder } = require('discord.js');
            const embed = new EmbedBuilder()
                .setColor(level === 'warn' ? 0xf1c40f : 0x2ecc71)
                .setTitle(title)
                .setDescription(`\`\`\`\n${text.slice(0, 3800)}\n\`\`\``)
                .setTimestamp();
            transport.route({ level, event: title.replace(/\s+/g, '_'), category }, embed);
        } catch (err) {
            consoleWrite('warn', `failed to build diagnostics embed: ${err.message}`);
        }
    }

    // ---- background tasks: webhook flush ticking, dedup sweeping, memory/event-loop-lag sampling, periodic summary ----
    let tickTimer = null;
    let memoryTimer = null;
    let summaryTimer = null;
    let eventLoopDelay = null;

    function startBackgroundTasks() {
        if (!tickTimer) {
            tickTimer = setInterval(() => {
                transport.tick().catch((err) => consoleWrite('error', `webhook tick failed: ${err.message}`));
                dedup.sweep();
            }, Math.max(250, Math.floor(config.webhook.flushIntervalMs / 2)));
            tickTimer.unref?.();
        }

        if (config.performance.includeMemory && !memoryTimer) {
            eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
            eventLoopDelay.enable();
            memoryTimer = setInterval(() => {
                const mem = process.memoryUsage();
                const lagMs = eventLoopDelay.mean / 1e6;
                eventLoopDelay.reset();
                _emit('debug', Events.PERFORMANCE_SNAPSHOT, createContext({
                    heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
                    rssMb: Math.round(mem.rss / 1024 / 1024),
                    eventLoopLagMs: Number.isFinite(lagMs) ? Number(lagMs.toFixed(2)) : undefined,
                }), { category: 'performance' });
            }, config.performance.memorySampleIntervalMs);
            memoryTimer.unref?.();
        }

        if (config.performance.summaryIntervalMs > 0 && !summaryTimer) {
            summaryTimer = setInterval(() => {
                const snap = stats.snapshot();
                _emit('info', Events.PERFORMANCE_SUMMARY, createContext({}), {
                    message: `${snap.totalExecuted} command(s) executed, ${snap.totalFailed} failed, avg ${Math.round(snap.overallAvgDurationMs || 0)}ms`,
                    extra: { summary: snap },
                    category: 'performance',
                });
            }, config.performance.summaryIntervalMs);
            summaryTimer.unref?.();
        }
    }

    function stopBackgroundTasks() {
        if (tickTimer) clearInterval(tickTimer);
        if (memoryTimer) clearInterval(memoryTimer);
        if (summaryTimer) clearInterval(summaryTimer);
        if (eventLoopDelay) eventLoopDelay.disable();
        tickTimer = memoryTimer = summaryTimer = eventLoopDelay = null;
    }

    startBackgroundTasks();

    return {
        trace, debug, info, warn, error, fatal,
        command, button, task,
        fromInteraction: (interaction, contextOverrides) => fromInteraction(interaction, contextOverrides),
        childContext: (parent, contextOverrides) => childContext(parent, contextOverrides),
        contextFor: (interaction) => contextByInteraction.get(interaction),
        registerHealthCheck,
        reportStartup,
        reportShutdown,
        getQueueStats: () => transport.getStats(),
        getStatsSnapshot: () => stats.snapshot(),
        flushAll: (opts) => transport.flushAll(opts),
        stopBackgroundTasks,
        config,
    };
}

module.exports = { createLogger };
