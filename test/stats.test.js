'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RollingWindow, CommandStats, ErrorDedup } = require('../src/lib/logger/stats');

test('RollingWindow computes percentiles correctly on simple data', () => {
    const w = new RollingWindow(100);
    for (let i = 1; i <= 100; i++) w.push(i); // 1..100
    assert.equal(w.percentile(50), 50);
    assert.equal(w.percentile(95), 95);
    assert.equal(w.percentile(99), 99);
    assert.equal(w.percentile(100), 100);
});

test('RollingWindow returns null percentile when empty', () => {
    const w = new RollingWindow(10);
    assert.equal(w.percentile(50), null);
    assert.equal(w.average(), null);
});

test('RollingWindow evicts oldest values once maxSize is exceeded', () => {
    const w = new RollingWindow(3);
    w.push(1); w.push(2); w.push(3); w.push(4); // 1 should be evicted
    assert.equal(w.size, 3);
    assert.equal(w.count, 4);
    assert.ok(!w.values.includes(1));
    assert.ok(w.values.includes(4));
});

test('RollingWindow average is correct', () => {
    const w = new RollingWindow(10);
    [10, 20, 30].forEach((v) => w.push(v));
    assert.equal(w.average(), 20);
});

test('CommandStats records success/failure counts per command', () => {
    const stats = new CommandStats();
    stats.record('ping', { status: 'success', durationMs: 10, traceId: 't1' });
    stats.record('ping', { status: 'success', durationMs: 20, traceId: 't2' });
    stats.record('ping', { status: 'failure', durationMs: 5, traceId: 't3' });
    stats.record('ban', { status: 'success', durationMs: 100, traceId: 't4' });

    const snap = stats.snapshot();
    assert.equal(snap.totalExecuted, 4);
    assert.equal(snap.totalFailed, 1);
    assert.equal(snap.totalSucceeded, 3);
    assert.equal(snap.perCommand.ping.success, 2);
    assert.equal(snap.perCommand.ping.failure, 1);
    assert.equal(snap.perCommand.ban.success, 1);
});

test('CommandStats tracks the slowest command overall', () => {
    const stats = new CommandStats();
    stats.record('ping', { status: 'success', durationMs: 10, traceId: 't1' });
    stats.record('backup', { status: 'success', durationMs: 5000, traceId: 't2' });
    const snap = stats.snapshot();
    assert.equal(snap.slowestCommand.command, 'backup');
    assert.equal(snap.slowestCommand.durationMs, 5000);
});

test('CommandStats.snapshot computes percentiles per command', () => {
    const stats = new CommandStats();
    for (let i = 1; i <= 100; i++) {
        stats.record('ping', { status: 'success', durationMs: i, traceId: `t${i}` });
    }
    const snap = stats.snapshot();
    assert.equal(snap.perCommand.ping.p50, 50);
    assert.equal(snap.perCommand.ping.p99, 99);
});

test('ErrorDedup emits the first occurrence and suppresses repeats within the window', () => {
    const dedup = new ErrorDedup({ windowMs: 60_000 });
    const first = dedup.check('fp1');
    const second = dedup.check('fp1');
    const third = dedup.check('fp1');
    assert.equal(first.shouldEmit, true);
    assert.equal(second.shouldEmit, false);
    assert.equal(second.suppressedCount, 1);
    assert.equal(third.shouldEmit, false);
    assert.equal(third.suppressedCount, 2);
});

test('ErrorDedup treats different fingerprints independently', () => {
    const dedup = new ErrorDedup({ windowMs: 60_000 });
    assert.equal(dedup.check('fp1').shouldEmit, true);
    assert.equal(dedup.check('fp2').shouldEmit, true);
});

test('ErrorDedup re-emits after the window expires', () => {
    const dedup = new ErrorDedup({ windowMs: 10 });
    assert.equal(dedup.check('fp1').shouldEmit, true);
    assert.equal(dedup.check('fp1').shouldEmit, false);
    return new Promise((resolve) => {
        setTimeout(() => {
            assert.equal(dedup.check('fp1').shouldEmit, true);
            resolve();
        }, 30);
    });
});

test('ErrorDedup surfaces previouslySuppressed count when a fresh window starts after suppression', () => {
    const dedup = new ErrorDedup({ windowMs: 10 });
    dedup.check('fp1'); // 1st occurrence, window starts
    dedup.check('fp1'); // suppressed (2nd)
    dedup.check('fp1'); // suppressed (3rd)
    return new Promise((resolve) => {
        setTimeout(() => {
            const result = dedup.check('fp1'); // window expired, fresh occurrence
            assert.equal(result.shouldEmit, true);
            assert.equal(result.previouslySuppressed, 2); // 2 were suppressed before this one
            resolve();
        }, 30);
    });
});

test('ErrorDedup.sweep removes fully expired entries', () => {
    const dedup = new ErrorDedup({ windowMs: 10 });
    dedup.check('fp1');
    return new Promise((resolve) => {
        setTimeout(() => {
            dedup.sweep();
            assert.equal(dedup.seen.has('fp1'), false);
            resolve();
        }, 30);
    });
});
