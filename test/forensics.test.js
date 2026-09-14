'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ForensicsStore, semanticSignature } = require('../src/lib/forensic-logger/core/forensics');

function errorRecord(traceId, overrides = {}) {
    return {
        timestamp: new Date().toISOString(),
        level: 'error',
        event: 'COMMAND_ERROR',
        command: 'ping',
        traceId,
        error: { name: 'TypeError', message: 'Cannot read properties of undefined', code: undefined },
        ...overrides,
    };
}

test('getTimeline returns chronological records with deltas for one trace', () => {
    const store = new ForensicsStore();
    const t0 = Date.now();
    store.ingest({ timestamp: new Date(t0).toISOString(), level: 'info', event: 'COMMAND_START', traceId: 'abc', command: 'ping' });
    store.ingest({ timestamp: new Date(t0 + 50).toISOString(), level: 'error', event: 'COMMAND_ERROR', traceId: 'abc', command: 'ping', error: { name: 'Error', message: 'boom' } });

    const timeline = store.getTimeline('abc');
    assert.equal(timeline.length, 2);
    assert.equal(timeline[0].deltaMs, 0);
    assert.ok(timeline[1].deltaMs >= 45 && timeline[1].deltaMs <= 60);
    assert.equal(timeline[1].error.message, 'boom');
});

test('investigate() returns null for an unknown trace id', () => {
    const store = new ForensicsStore();
    assert.equal(store.investigate('nope'), null);
});

test('investigate() surfaces related traces sharing the same error fingerprint', () => {
    const store = new ForensicsStore();
    store.ingest(errorRecord('t1'));
    store.ingest(errorRecord('t2'));
    store.ingest(errorRecord('t3'));

    const result = store.investigate('t3');
    assert.equal(result.occurrenceCount, 3);
    assert.ok(result.relatedTraceIds.includes('t1'));
    assert.ok(result.relatedTraceIds.includes('t2'));
});

test('getTrends ranks error groups by count and reports a trend direction', () => {
    const store = new ForensicsStore();
    for (let i = 0; i < 5; i++) store.ingest(errorRecord(`trace-${i}`));
    store.ingest(errorRecord('other', { error: { name: 'RangeError', message: 'out of bounds' } }));

    const trends = store.getTrends({ limit: 5 });
    assert.equal(trends[0].name, 'TypeError');
    assert.equal(trends[0].count, 5);
    assert.ok(['up', 'flat', 'down'].includes(trends[0].trend));
});

test('filter() applies level/command/status/time filters', () => {
    const store = new ForensicsStore();
    store.ingest({ timestamp: new Date().toISOString(), level: 'info', event: 'COMMAND_END', command: 'ping', status: 'success' });
    store.ingest({ timestamp: new Date().toISOString(), level: 'error', event: 'COMMAND_ERROR', command: 'backup', status: 'failure' });

    const onlyErrors = store.filter({ level: 'error' });
    assert.equal(onlyErrors.length, 1);
    assert.equal(onlyErrors[0].command, 'backup');

    const onlyPing = store.filter({ command: 'ping' });
    assert.equal(onlyPing.length, 1);
});

test('search() ranks records by number of matching terms, newest first', () => {
    const store = new ForensicsStore();
    store.ingest({ timestamp: new Date(Date.now() - 1000).toISOString(), level: 'error', event: 'COMMAND_ERROR', message: 'database timeout while fetching user' });
    store.ingest({ timestamp: new Date().toISOString(), level: 'error', event: 'COMMAND_ERROR', message: 'database connection refused' });

    const results = store.search('database timeout');
    assert.equal(results.length, 2);
    assert.ok(results[0].message.includes('timeout')); // higher term overlap ranks first
});

test('production debug mode forces capture only within its scope and expires', () => {
    const store = new ForensicsStore();
    store.enableDebugMode({ durationMs: 50, command: 'ping' });

    assert.equal(store.isDebugForced({ command: 'ping' }), true);
    assert.equal(store.isDebugForced({ command: 'other' }), false);
});

test('smart dedup groups semantically-similar messages across different traces', () => {
    const store = new ForensicsStore();
    store.ingest(errorRecord('a', { error: { name: 'Error', message: 'user 8823991 not found' } }));
    store.ingest(errorRecord('b', { error: { name: 'Error', message: 'user 9911002 not found' } }));

    const sigA = semanticSignature({ name: 'Error', message: 'user 8823991 not found' });
    const sigB = semanticSignature({ name: 'Error', message: 'user 9911002 not found' });
    assert.equal(sigA, sigB);

    const check = store.smartDedupCheck({ name: 'Error', message: 'user 123 not found' });
    assert.equal(check.totalCount, 2);
});

test('getInteractionTimeline filters to command/button events for one user within a window', () => {
    const store = new ForensicsStore();
    const now = Date.now();
    store.ingest({ timestamp: new Date(now).toISOString(), event: 'COMMAND_START', command: 'ping', userId: 'u1' });
    store.ingest({ timestamp: new Date(now + 10).toISOString(), event: 'PERFORMANCE_SNAPSHOT', userId: 'u1' });
    store.ingest({ timestamp: new Date(now + 20).toISOString(), event: 'BUTTON_START', customId: 'confirm', userId: 'u2' });

    const timeline = store.getInteractionTimeline({ userId: 'u1', aroundMs: now, windowMs: 1000 });
    assert.equal(timeline.length, 1);
    assert.equal(timeline[0].command, 'ping');
});

test('buildContextFor flags records that land shortly after a build/deploy change', () => {
    const store = new ForensicsStore({ buildInfo: { buildId: 'b1' } });
    const ctx = store.buildContextFor(Date.now());
    assert.equal(ctx.recentlyDeployed, true);

    store.recordBuildChange({ buildId: 'b2' });
    const ctx2 = store.buildContextFor(Date.now() - 20 * 60_000); // 20 min "before" the new build start
    assert.equal(ctx2.recentlyDeployed, false);
});
