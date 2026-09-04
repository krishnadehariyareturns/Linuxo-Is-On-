'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { redact, keyMatches } = require('../src/lib/logger/redact');

test('redacts known sensitive keys at top level', () => {
    const out = redact({ token: 'abc123', username: 'bob' });
    assert.equal(out.token, '[REDACTED]');
    assert.equal(out.username, 'bob');
});

test('redacts sensitive keys regardless of casing/separators', () => {
    const out = redact({
        Authorization: 'Bearer xyz',
        API_KEY: 'k-1',
        webhookUrl: 'https://discord.com/api/webhooks/x/y',
        clientSecret: 's3cr3t',
    });
    assert.equal(out.Authorization, '[REDACTED]');
    assert.equal(out.API_KEY, '[REDACTED]');
    assert.equal(out.webhookUrl, '[REDACTED]');
    assert.equal(out.clientSecret, '[REDACTED]');
});

test('redacts nested keys recursively', () => {
    const out = redact({
        context: { request: { headers: { cookie: 'session=abc' } } },
    });
    assert.equal(out.context.request.headers.cookie, '[REDACTED]');
});

test('redacts inside arrays', () => {
    const out = redact({ items: [{ password: 'p1' }, { password: 'p2' }] });
    assert.equal(out.items[0].password, '[REDACTED]');
    assert.equal(out.items[1].password, '[REDACTED]');
});

test('leaves non-sensitive data untouched', () => {
    const input = { guildId: '123', command: 'ping', durationMs: 42, count: 3, ok: true };
    const out = redact(input);
    assert.deepEqual(out, input);
});

test('handles circular references without throwing or hanging', () => {
    const obj = { name: 'x' };
    obj.self = obj;
    const out = redact(obj);
    assert.equal(out.name, 'x');
    assert.equal(out.self, '[Circular]');
});

test('caps excessive nesting depth instead of recursing forever', () => {
    let obj = { leaf: true };
    for (let i = 0; i < 20; i++) obj = { child: obj };
    const out = redact(obj);
    // Just needs to terminate and produce something — walk the result to
    // confirm a [MaxDepth] marker shows up somewhere in the chain.
    let cursor = out;
    let sawMarker = false;
    for (let i = 0; i < 25 && cursor && typeof cursor === 'object'; i++) {
        if (cursor.child === '[MaxDepth]') { sawMarker = true; break; }
        cursor = cursor.child;
    }
    assert.ok(sawMarker, 'expected a [MaxDepth] marker somewhere in the walked chain');
});

test('truncates long strings when maxStringLength is set', () => {
    const longStr = 'x'.repeat(1000);
    const out = redact({ message: longStr }, { maxStringLength: 50 });
    assert.ok(out.message.length < 1000);
    assert.ok(out.message.startsWith('x'.repeat(50)));
    assert.ok(out.message.includes('+950 chars'));
});

test('does not truncate short strings', () => {
    const out = redact({ message: 'hello' }, { maxStringLength: 50 });
    assert.equal(out.message, 'hello');
});

test('supports extra custom sensitive keys', () => {
    const out = redact({ myCustomSecret: 'x' }, { extraKeys: ['myCustomSecret'] });
    assert.equal(out.myCustomSecret, '[REDACTED]');
});

test('handles Error instances without exposing extra internals', () => {
    const err = new Error('boom');
    const out = redact({ err });
    assert.equal(out.err.name, 'Error');
    assert.equal(out.err.message, 'boom');
    assert.equal(out.err.stack, undefined);
});

test('handles null and undefined gracefully', () => {
    const out = redact({ a: null, b: undefined, token: null });
    assert.equal(out.a, null);
    assert.equal(out.b, undefined);
    // Even a null token value should still be marked redacted, since the key
    // itself is sensitive regardless of what's currently in it.
    assert.equal(out.token, '[REDACTED]');
});

test('keyMatches is case/separator insensitive', () => {
    assert.ok(keyMatches('API_KEY', ['apikey']));
    assert.ok(keyMatches('apiKey', ['apikey']));
    assert.ok(keyMatches('Authorization', ['auth']));
    assert.ok(!keyMatches('username', ['apikey', 'token']));
});
