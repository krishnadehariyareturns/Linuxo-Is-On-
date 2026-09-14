'use strict';

const os = require('node:os');
const { newTraceId, newRequestId } = require('./ids');

let staticCache = null;

/**
 * Fields that are the same for the whole process lifetime. Set explicitly
 * ONCE by core.js right after config is loaded — deliberately not
 * lazily-cached-on-first-call, because whichever call happened to run first
 * (createContext vs fromInteraction, called from different places) would
 * otherwise silently decide botVersion for the rest of the process.
 */
function initStaticFields({ botVersion, shardId = 0 } = {}) {
    staticCache = {
        botVersion: botVersion || 'unknown',
        nodeVersion: process.version,
        pid: process.pid,
        hostname: os.hostname(),
        shardId,
    };
    return staticCache;
}

function getStaticFields() {
    // Defensive fallback for direct use of this module (e.g. in tests)
    // without going through createLogger()/initStaticFields first.
    if (!staticCache) initStaticFields({});
    return staticCache;
}

/**
 * Build a fresh top-level context, e.g. at the start of a command or a
 * major lifecycle event. Always mints a new traceId unless one is
 * explicitly passed in `overrides`.
 */
function createContext(overrides = {}) {
    const base = {
        ...getStaticFields(),
        traceId: newTraceId(),
        requestId: newRequestId(),
    };
    return { ...base, ...overrides };
}

/**
 * Derive a child context for a sub-operation (a DB query inside a command,
 * say). Keeps the parent's traceId so both show up under the same trace,
 * but gets its own requestId to identify this specific sub-step.
 */
function childContext(parent, overrides = {}) {
    return {
        ...parent,
        ...overrides,
        requestId: newRequestId(),
        traceId: parent?.traceId ?? newTraceId(),
        parentRequestId: parent?.requestId,
    };
}

/**
 * Pull the fields discord.js gives us off a ChatInputCommandInteraction (or
 * a MessageComponentInteraction for buttons) defensively — guildId is null
 * in DMs, etc.
 */
function fromInteraction(interaction, overrides = {}) {
    if (!interaction) return createContext(overrides);

    const fields = {
        guildId: interaction.guildId ?? undefined,
        guildName: interaction.guild?.name ?? undefined,
        channelId: interaction.channelId ?? undefined,
        userId: interaction.user?.id ?? undefined,
        userTag: interaction.user?.tag ?? undefined,
        interactionId: interaction.id ?? undefined,
    };

    if (typeof interaction.isChatInputCommand === 'function' && interaction.isChatInputCommand()) {
        fields.command = interaction.commandName;
        fields.subcommand = interaction.options?.getSubcommand?.(false) ?? undefined;
    } else if (typeof interaction.isButton === 'function' && interaction.isButton()) {
        fields.customId = interaction.customId;
    }

    return createContext({ ...fields, ...overrides });
}

module.exports = { createContext, childContext, fromInteraction, initStaticFields, getStaticFields };
