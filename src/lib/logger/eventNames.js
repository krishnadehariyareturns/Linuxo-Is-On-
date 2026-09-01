'use strict';

/**
 * Stable event names. Nothing dynamic — these get used as literal strings in
 * Discord embeds, JSON logs, routing tables and (if you ever pipe logs into
 * a database) as index keys, so they should never be renamed casually.
 *
 * Sections marked "(extension)" are not in the original design doc but were
 * added to cover things this specific bot does (buttons, guild join/leave)
 * or to close small gaps in the doc's own taxonomy (fatal process exit).
 */
const Events = Object.freeze({
    // ---- Process ----
    BOT_START: 'BOT_START',
    BOT_READY: 'BOT_READY',
    BOT_SHUTDOWN: 'BOT_SHUTDOWN',
    BOT_CRASH: 'BOT_CRASH',
    UNHANDLED_EXCEPTION: 'UNHANDLED_EXCEPTION',
    UNHANDLED_REJECTION: 'UNHANDLED_REJECTION',

    // ---- Discord gateway ----
    GATEWAY_CONNECT: 'GATEWAY_CONNECT',
    GATEWAY_DISCONNECT: 'GATEWAY_DISCONNECT',
    GATEWAY_RECONNECT: 'GATEWAY_RECONNECT',
    GATEWAY_ERROR: 'GATEWAY_ERROR',
    SHARD_READY: 'SHARD_READY',
    SHARD_ERROR: 'SHARD_ERROR',

    // ---- Commands ----
    COMMAND_START: 'COMMAND_START',
    COMMAND_END: 'COMMAND_END',
    COMMAND_ERROR: 'COMMAND_ERROR',
    COMMAND_TIMEOUT: 'COMMAND_TIMEOUT',
    COMMAND_PERMISSION_DENIED: 'COMMAND_PERMISSION_DENIED',
    COMMAND_COOLDOWN: 'COMMAND_COOLDOWN',

    // ---- Discord domain events ----
    // Only fire if you add the matching intents later (MESSAGE_CREATE needs
    // GuildMessages + MessageContent, MEMBER_JOIN needs GuildMembers — both
    // privileged). Defined now so they're ready the moment you wire them up.
    MESSAGE_CREATE: 'MESSAGE_CREATE',
    MESSAGE_DELETE: 'MESSAGE_DELETE',
    MESSAGE_UPDATE: 'MESSAGE_UPDATE',
    MEMBER_JOIN: 'MEMBER_JOIN',
    MEMBER_LEAVE: 'MEMBER_LEAVE',
    ROLE_UPDATE: 'ROLE_UPDATE',
    CHANNEL_UPDATE: 'CHANNEL_UPDATE',
    GUILD_UPDATE: 'GUILD_UPDATE',
    GUILD_JOIN: 'GUILD_JOIN', // (extension) bot added to a new guild
    GUILD_LEAVE: 'GUILD_LEAVE', // (extension) bot removed from a guild

    // ---- Infrastructure ----
    WEBHOOK_SEND: 'WEBHOOK_SEND',
    WEBHOOK_RETRY: 'WEBHOOK_RETRY',
    WEBHOOK_RATE_LIMIT: 'WEBHOOK_RATE_LIMIT',
    WEBHOOK_CIRCUIT_OPEN: 'WEBHOOK_CIRCUIT_OPEN', // (extension)
    WEBHOOK_CIRCUIT_CLOSE: 'WEBHOOK_CIRCUIT_CLOSE', // (extension)
    QUEUE_BACKPRESSURE: 'QUEUE_BACKPRESSURE', // (extension)
    DATABASE_QUERY: 'DATABASE_QUERY',
    DATABASE_ERROR: 'DATABASE_ERROR',
    CACHE_HIT: 'CACHE_HIT',
    CACHE_MISS: 'CACHE_MISS',
    EXTERNAL_API_REQUEST: 'EXTERNAL_API_REQUEST',
    EXTERNAL_API_ERROR: 'EXTERNAL_API_ERROR',

    // ---- Interaction components (extension) ----
    BUTTON_START: 'BUTTON_START',
    BUTTON_END: 'BUTTON_END',
    BUTTON_ERROR: 'BUTTON_ERROR',

    // ---- Performance / reporting (extension) ----
    PERFORMANCE_SNAPSHOT: 'PERFORMANCE_SNAPSHOT',
    SLOW_COMMAND: 'SLOW_COMMAND',
    PERFORMANCE_SUMMARY: 'PERFORMANCE_SUMMARY',
    HEALTH_CHECK: 'HEALTH_CHECK',
    CONFIG_RELOAD: 'CONFIG_RELOAD',
});

/**
 * Events that should be routed to the #bot-security webhook category
 * regardless of their level. Kept as an explicit list (rather than inferred
 * from the name) so routing is a single readable table — see
 * webhookTransport.js.
 */
const SECURITY_EVENTS = new Set([
    Events.COMMAND_PERMISSION_DENIED,
]);

/**
 * Events that should be routed to the #bot-performance webhook category
 * regardless of their level.
 */
const PERFORMANCE_EVENTS = new Set([
    Events.SLOW_COMMAND,
    Events.PERFORMANCE_SNAPSHOT,
    Events.PERFORMANCE_SUMMARY,
]);

module.exports = { Events, SECURITY_EVENTS, PERFORMANCE_EVENTS };
