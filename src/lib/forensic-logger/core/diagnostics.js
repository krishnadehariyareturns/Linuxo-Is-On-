'use strict';

const { renderSectionReport } = require('./reportBox');

function fmtSeconds(ms) {
    return `${(ms / 1000).toFixed(2)} s`;
}

function fmtUptime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function fmtDuration(ms) {
    if (typeof ms !== 'number') return undefined;
    return ms < 1000 ? `${Math.round(ms)} ms` : fmtSeconds(ms);
}

/**
 * Runs every registered health check (see core.js's registerHealthCheck),
 * tolerating individual failures so one broken check can't take down the
 * whole startup report. A check may return a boolean or {ok, detail}.
 */
async function runHealthChecks(checks) {
    const results = [];
    for (const { name, check } of checks) {
        try {
            // eslint-disable-next-line no-await-in-loop
            const outcome = await check();
            const ok = outcome !== null && typeof outcome === 'object' ? outcome.ok : Boolean(outcome);
            const detail = outcome !== null && typeof outcome === 'object' ? outcome.detail : undefined;
            results.push({ name, ok, detail });
        } catch (err) {
            results.push({ name, ok: false, detail: err?.message || 'health check threw' });
        }
    }
    return results;
}

/**
 * @param {object} opts
 * @param {object} opts.config
 * @param {object} opts.client - discord.js Client (post-ready)
 * @param {number} opts.commandsLoaded
 * @param {number} opts.eventsLoaded
 * @param {number} opts.webhooksConfigured
 * @param {number} opts.startupDurationMs
 * @param {Array<{name:string, ok:boolean, detail?:string}>} opts.healthResults
 */
function buildStartupReport({ config, client, commandsLoaded, eventsLoaded, webhooksConfigured, startupDurationMs, healthResults = [] }) {
    const allHealthy = healthResults.every((r) => r.ok);
    const health = healthResults.length === 0 ? 'OK' : allHealthy ? 'OK' : 'DEGRADED';

    const rows = [
        ['Version', config.botVersion],
        ['Node', process.version],
        ['Environment', config.environment],
        ['Shard', client?.shard?.ids?.[0] ?? 0],
        ['Commands', `${commandsLoaded} loaded`],
        ['Events', `${eventsLoaded} loaded`],
        ...healthResults.map((r) => [r.name, r.ok ? 'OK' : `FAILED${r.detail ? ` (${r.detail})` : ''}`]),
        ['Webhooks', `${webhooksConfigured} configured`],
        ['Startup time', fmtDuration(startupDurationMs)],
        ['Health', health],
    ];

    const text = renderSectionReport('BOT STARTUP DIAGNOSTICS', rows);
    return {
        text,
        health,
        structured: {
            version: config.botVersion,
            nodeVersion: process.version,
            environment: config.environment,
            shardId: client?.shard?.ids?.[0] ?? 0,
            commandsLoaded,
            eventsLoaded,
            webhooksConfigured,
            startupDurationMs,
            healthResults,
            health,
        },
    };
}

/**
 * @param {object} opts
 * @param {object} opts.statsSnapshot - from CommandStats.snapshot()
 * @param {object} opts.queueStats - from webhookTransport.getStats()
 * @param {number} opts.shutdownDurationMs
 */
function buildShutdownReport({ statsSnapshot, queueStats, shutdownDurationMs }) {
    const totalQueued = Object.values(queueStats || {}).reduce((sum, s) => sum + s.queued, 0);
    const slowest = statsSnapshot.slowestCommand
        ? `/${statsSnapshot.slowestCommand.command} (${fmtDuration(statsSnapshot.slowestCommand.durationMs)})`
        : 'n/a';

    const rows = [
        ['Uptime', fmtUptime(statsSnapshot.uptimeMs)],
        ['Commands executed', statsSnapshot.totalExecuted],
        ['Succeeded', statsSnapshot.totalSucceeded],
        ['Failed', statsSnapshot.totalFailed],
        ['Avg duration', fmtDuration(statsSnapshot.overallAvgDurationMs)],
        ['Slowest command', slowest],
        ['Webhook queue', `${totalQueued} pending at shutdown`],
        ['Shutdown time', fmtDuration(shutdownDurationMs)],
    ];

    const text = renderSectionReport('BOT SHUTDOWN REPORT', rows);
    return { text, structured: { ...statsSnapshot, queueStats, shutdownDurationMs } };
}

module.exports = { buildStartupReport, buildShutdownReport, runHealthChecks, fmtUptime, fmtDuration };
