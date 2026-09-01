'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, deepMerge, thresholdsFor } = require('../lib/logger/config');

test('loadConfig returns sane defaults with no overrides', () => {
    const c = loadConfig();
    assert.equal(typeof c.level, 'string');
    assert.equal(c.webhook.batchSize, 10);
    assert.equal(c.redaction.enabled, true);
});

test('deepMerge overrides a nested key without dropping its siblings', () => {
    const base = { a: { x: 1, y: 2 }, b: 3 };
    const merged = deepMerge(base, { a: { x: 99 } });
    assert.equal(merged.a.x, 99);
    assert.equal(merged.a.y, 2); // sibling preserved
    assert.equal(merged.b, 3);
});

test('deepMerge replaces arrays wholesale rather than merging them', () => {
    const base = { list: [1, 2, 3] };
    const merged = deepMerge(base, { list: [9] });
    assert.deepEqual(merged.list, [9]);
});

test('loadConfig overrides propagate through nested objects', () => {
    const c = loadConfig({ webhook: { categories: { errors: 'https://example.com/hook' } } });
    assert.equal(c.webhook.categories.errors, 'https://example.com/hook');
    assert.equal(c.webhook.categories.logs, ''); // untouched sibling
    assert.equal(c.webhook.retryLimit, 5); // untouched parent sibling
});

test('thresholdsFor falls back to global defaults when no per-command override exists', () => {
    const c = loadConfig();
    const t = thresholdsFor(c, 'nonexistent');
    assert.equal(t.warnMs, c.performance.warnCommandMs);
    assert.equal(t.slowMs, c.performance.slowCommandMs);
});

test('thresholdsFor uses a per-command override when present', () => {
    const c = loadConfig({ performance: { perCommandThresholds: { backup: { warnMs: 5000, slowMs: 15000 } } } });
    const t = thresholdsFor(c, 'backup');
    assert.equal(t.warnMs, 5000);
    assert.equal(t.slowMs, 15000);
});
