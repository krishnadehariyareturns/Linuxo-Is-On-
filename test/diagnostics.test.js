'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildStartupReport, buildShutdownReport, runHealthChecks } = require('../lib/logger/diagnostics');
const { loadConfig } = require('../lib/logger/config');
const { CommandStats } = require('../lib/logger/stats');

test('runHealthChecks tolerates a throwing check without losing the others', async () => {
    const results = await runHealthChecks([
        { name: 'Good', check: async () => true },
        { name: 'Bad', check: async () => { throw new Error('kaboom'); } },
    ]);
    assert.equal(results.length, 2);
    assert.equal(results[0].ok, true);
    assert.equal(results[1].ok, false);
    assert.ok(results[1].detail.includes('kaboom'));
});

test('runHealthChecks accepts both boolean and {ok, detail} return shapes', async () => {
    const results = await runHealthChecks([
        { name: 'BoolCheck', check: async () => false },
        { name: 'ObjectCheck', check: async () => ({ ok: true, detail: 'all good' }) },
    ]);
    assert.equal(results[0].ok, false);
    assert.equal(results[1].ok, true);
    assert.equal(results[1].detail, 'all good');
});

test('buildStartupReport reports OK health when no checks are registered', () => {
    const config = loadConfig({ botVersion: '1.0.0' });
    const report = buildStartupReport({ config, client: {}, commandsLoaded: 1, eventsLoaded: 1, webhooksConfigured: 0, startupDurationMs: 100, healthResults: [] });
    assert.equal(report.health, 'OK');
});

test('buildStartupReport reports DEGRADED when any health check fails', () => {
    const config = loadConfig({ botVersion: '1.0.0' });
    const report = buildStartupReport({
        config, client: {}, commandsLoaded: 1, eventsLoaded: 1, webhooksConfigured: 0, startupDurationMs: 100,
        healthResults: [{ name: 'Database', ok: false, detail: 'timeout' }],
    });
    assert.equal(report.health, 'DEGRADED');
    assert.ok(report.text.includes('FAILED'));
    assert.ok(report.text.includes('timeout'));
});

test('buildStartupReport reads shard id from client.shard when present', () => {
    const config = loadConfig({ botVersion: '1.0.0' });
    const report = buildStartupReport({
        config, client: { shard: { ids: [3] } }, commandsLoaded: 1, eventsLoaded: 1, webhooksConfigured: 0, startupDurationMs: 100,
    });
    assert.equal(report.structured.shardId, 3);
});

test('buildShutdownReport summarizes stats and pending queue depth', () => {
    const stats = new CommandStats();
    stats.record('ping', { status: 'success', durationMs: 10, traceId: 't1' });
    stats.record('ping', { status: 'failure', durationMs: 20, traceId: 't2' });

    const report = buildShutdownReport({
        statsSnapshot: stats.snapshot(),
        queueStats: { logs: { queued: 3 }, errors: { queued: 1 } },
        shutdownDurationMs: 250,
    });

    assert.ok(report.text.includes('Commands executed : 2'));
    assert.ok(report.text.includes('4 pending at shutdown'));
});

test('buildShutdownReport handles no commands executed gracefully', () => {
    const stats = new CommandStats();
    const report = buildShutdownReport({ statsSnapshot: stats.snapshot(), queueStats: {}, shutdownDurationMs: 50 });
    assert.ok(report.text.includes('Slowest command   : n/a'));
});
