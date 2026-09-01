'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createContext, childContext, fromInteraction, initStaticFields } = require('../lib/logger/context');

test('createContext includes static + generated fields set via initStaticFields', () => {
    initStaticFields({ botVersion: '1.0.0', shardId: 2 });
    const ctx = createContext({});
    assert.equal(ctx.botVersion, '1.0.0');
    assert.equal(ctx.shardId, 2);
    assert.ok(ctx.traceId);
    assert.ok(ctx.requestId);
    assert.equal(ctx.nodeVersion, process.version);
});

test('initStaticFields is authoritative regardless of call order with fromInteraction', () => {
    // Simulates the exact bug this design avoids: fromInteraction running
    // before any explicit init must NOT be allowed to permanently lock in
    // botVersion 'unknown' for the rest of the process.
    initStaticFields({ botVersion: '2.0.0' });
    const ctx = fromInteraction(null);
    assert.equal(ctx.botVersion, '2.0.0');
});

test('createContext merges overrides on top of base fields', () => {
    const ctx = createContext({ guildId: 'g1', command: 'ping' });
    assert.equal(ctx.guildId, 'g1');
    assert.equal(ctx.command, 'ping');
});

test('createContext lets an explicit traceId override the generated one', () => {
    const ctx = createContext({ traceId: 'fixed-trace' });
    assert.equal(ctx.traceId, 'fixed-trace');
});

test('childContext preserves the parent traceId', () => {
    const parent = createContext({ command: 'ping' });
    const child = childContext(parent, { event: 'DATABASE_QUERY' });
    assert.equal(child.traceId, parent.traceId);
    assert.equal(child.parentRequestId, parent.requestId);
    assert.notEqual(child.requestId, parent.requestId);
    assert.equal(child.event, 'DATABASE_QUERY');
    assert.equal(child.command, 'ping'); // inherited
});

test('fromInteraction extracts guild/channel/user/command fields', () => {
    const fakeInteraction = {
        guildId: 'g1',
        guild: { name: 'Test Guild' },
        channelId: 'c1',
        user: { id: 'u1', tag: 'user#0001' },
        id: 'i1',
        commandName: 'ping',
        isChatInputCommand: () => true,
        isButton: () => false,
        options: { getSubcommand: () => null },
    };
    const ctx = fromInteraction(fakeInteraction);
    assert.equal(ctx.guildId, 'g1');
    assert.equal(ctx.guildName, 'Test Guild');
    assert.equal(ctx.channelId, 'c1');
    assert.equal(ctx.userId, 'u1');
    assert.equal(ctx.userTag, 'user#0001');
    assert.equal(ctx.interactionId, 'i1');
    assert.equal(ctx.command, 'ping');
});

test('fromInteraction handles DM interactions with null guildId', () => {
    const fakeInteraction = {
        guildId: null,
        guild: null,
        channelId: 'c1',
        user: { id: 'u1', tag: 'user#0001' },
        id: 'i1',
        commandName: 'ping',
        isChatInputCommand: () => true,
        isButton: () => false,
        options: { getSubcommand: () => null },
    };
    const ctx = fromInteraction(fakeInteraction);
    assert.equal(ctx.guildId, undefined);
    assert.equal(ctx.guildName, undefined);
});

test('fromInteraction extracts customId for button interactions', () => {
    const fakeInteraction = {
        guildId: 'g1',
        channelId: 'c1',
        user: { id: 'u1', tag: 'user#0001' },
        id: 'i1',
        customId: 'my_button',
        isChatInputCommand: () => false,
        isButton: () => true,
    };
    const ctx = fromInteraction(fakeInteraction);
    assert.equal(ctx.customId, 'my_button');
    assert.equal(ctx.command, undefined);
});

test('fromInteraction handles a missing interaction gracefully', () => {
    const ctx = fromInteraction(null);
    assert.ok(ctx.traceId);
});
