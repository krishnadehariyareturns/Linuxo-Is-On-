'use strict';

// discord.js is required lazily inside buildEmbed() rather than at module
// load, so this file (and anything that requires it, like core.js) can
// still be loaded and partially tested in environments without discord.js
// installed — actually constructing an embed is the only thing that needs it.
const { safeSummary } = require('./errors');

const COLOR_BY_LEVEL = {
    trace: 0x95a5a6,
    debug: 0x3498db,
    info: 0x2ecc71,
    warn: 0xf1c40f,
    error: 0xe74c3c,
    fatal: 0x992d22,
};

const FIELD_VALUE_MAX = 1024;
const FIELD_NAME_MAX = 256;
const DESCRIPTION_MAX = 4096;
const TITLE_MAX = 256;
const MAX_FIELDS = 25;

function truncate(str, max) {
    if (str === undefined || str === null) return str;
    const s = String(str);
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function fmtDuration(ms) {
    if (typeof ms !== 'number') return undefined;
    return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(2)} s`;
}

function colorFor(record) {
    if (record.status === 'failure') return COLOR_BY_LEVEL.error;
    if (record.status === 'success') return COLOR_BY_LEVEL.info;
    return COLOR_BY_LEVEL[record.level] ?? COLOR_BY_LEVEL.info;
}

/**
 * The ordered set of "interesting" context fields we'll surface as embed
 * fields, if present on the record. Order matches the design doc's example
 * layout (Command, Status, Duration, Trace ID, Guild, User, Handler, ...).
 */
const FIELD_DEFS = [
    ['command', 'Command', (v, r) => (r.subcommand ? `/${v} ${r.subcommand}` : `/${v}`)],
    ['status', 'Status', (v) => v.toUpperCase()],
    ['durationMs', 'Duration', (v) => fmtDuration(v)],
    ['traceId', 'Trace ID', (v) => v],
    ['guildName', 'Guild', (v, r) => v || r.guildId],
    ['userTag', 'User', (v, r) => v || r.userId],
    ['handler', 'Handler', (v) => v],
    ['customId', 'Component', (v) => v],
    ['httpStatus', 'HTTP Status', (v) => v],
    ['retryCount', 'Retries', (v) => v],
    ['cacheStatus', 'Cache', (v) => v],
    ['apiCalls', 'API calls', (v) => v],
    ['suppressedCount', 'Repeated', (v) => `${v}x in the last window`],
];

/**
 * Build a single Discord embed from a fully-assembled log record (envelope
 * + context + normalized error, already redacted). Never includes a stack
 * trace — that stays in console/JSON/file logs only.
 */
function buildEmbed(record) {
    // eslint-disable-next-line global-require
    const { EmbedBuilder } = require('discord.js');
    const statusTag = record.status ? `[${record.status.toUpperCase()}] ` : '';
    const title = truncate(`${statusTag}[${record.level.toUpperCase()}] ${record.event}`, TITLE_MAX);

    const embed = new EmbedBuilder()
        .setColor(colorFor(record))
        .setTitle(title)
        .setTimestamp(record.timestamp ? new Date(record.timestamp) : new Date());

    if (record.message) {
        embed.setDescription(truncate(record.message, DESCRIPTION_MAX));
    }

    const fields = [];
    for (const [key, label, format] of FIELD_DEFS) {
        const raw = record[key];
        if (raw === undefined || raw === null || raw === '') continue;
        const value = format(raw, record);
        if (value === undefined || value === null || value === '') continue;
        fields.push({
            name: truncate(label, FIELD_NAME_MAX),
            value: truncate(value, FIELD_VALUE_MAX),
            inline: true,
        });
    }

    if (record.error) {
        fields.push({
            name: 'Error',
            value: truncate(safeSummary(record.error), FIELD_VALUE_MAX),
            inline: false,
        });
    }

    if (fields.length) {
        embed.addFields(fields.slice(0, MAX_FIELDS));
    }

    const footerBits = [record.requestId ? `req:${String(record.requestId).slice(0, 8)}` : null, record.botVersion ? `v${record.botVersion}` : null]
        .filter(Boolean)
        .join(' · ');
    if (footerBits) embed.setFooter({ text: truncate(footerBits, FIELD_NAME_MAX) });

    return embed;
}

module.exports = { buildEmbed, colorFor, fmtDuration, COLOR_BY_LEVEL };
