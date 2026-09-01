'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeError, safeSummary, fingerprint, isRetryable } = require('../lib/logger/errors');

test('normalizes a plain Error', () => {
    const out = normalizeError(new Error('boom'));
    assert.equal(out.name, 'Error');
    assert.equal(out.message, 'boom');
    assert.equal(out.code, undefined);
    assert.ok(out.stack.includes('Error: boom'));
});

test('normalizes a DiscordAPIError-shaped error (status + code)', () => {
    class DiscordAPIError extends Error {
        constructor(message, code, status) {
            super(message);
            this.name = 'DiscordAPIError';
            this.code = code;
            this.status = status;
        }
    }
    const out = normalizeError(new DiscordAPIError('Missing Permissions', 50013, 403));
    assert.equal(out.name, 'DiscordAPIError');
    assert.equal(out.code, 50013);
    assert.equal(out.httpStatus, 403);
    assert.equal(out.retryable, false); // 403 isn't in the retryable set
});

test('marks 429 and 5xx as retryable', () => {
    class ApiError extends Error {
        constructor(status) { super('rate limited'); this.status = status; }
    }
    assert.equal(normalizeError(new ApiError(429)).retryable, true);
    assert.equal(normalizeError(new ApiError(503)).retryable, true);
    assert.equal(normalizeError(new ApiError(404)).retryable, false);
});

test('marks known retryable system error codes', () => {
    const err = new Error('connection reset');
    err.code = 'ECONNRESET';
    assert.equal(isRetryable(err, undefined), true);
});

test('handles non-Error throws without crashing', () => {
    const out = normalizeError('just a string');
    assert.equal(out.name, 'NonErrorThrown');
    assert.equal(out.message, 'just a string');

    const out2 = normalizeError({ weird: 'object' });
    assert.equal(out2.name, 'NonErrorThrown');
    assert.ok(out2.message.includes('weird'));
});

test('handles null/undefined', () => {
    assert.equal(normalizeError(null), null);
    assert.equal(normalizeError(undefined), null);
});

test('safeSummary never includes the stack', () => {
    const normalized = normalizeError(new Error('boom'));
    const summary = safeSummary(normalized);
    assert.ok(!summary.includes('at '), 'summary should not contain stack frame text');
    assert.ok(summary.includes('boom'));
});

test('safeSummary caps length', () => {
    const normalized = normalizeError(new Error('x'.repeat(1000)));
    const summary = safeSummary(normalized, 50);
    assert.ok(summary.length <= 51); // 50 + ellipsis
});

test('fingerprint is stable for the same error shape + command', () => {
    function makeErr() {
        try {
            throw new Error('same failure');
        } catch (e) {
            return e;
        }
    }
    const a = fingerprint(normalizeError(makeErr()), { command: 'ping' });
    const b = fingerprint(normalizeError(makeErr()), { command: 'ping' });
    assert.equal(a, b);
});

test('fingerprint differs across different commands', () => {
    const err = normalizeError(new Error('same failure'));
    const a = fingerprint(err, { command: 'ping' });
    const b = fingerprint(err, { command: 'ban' });
    assert.notEqual(a, b);
});

test('fingerprint handles null normalized error', () => {
    assert.equal(fingerprint(null, {}), 'unknown');
});
