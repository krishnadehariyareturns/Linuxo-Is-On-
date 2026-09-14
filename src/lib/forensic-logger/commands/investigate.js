'use strict';

const {
    SlashCommandBuilder,
    ContainerBuilder,
    SeparatorSpacingSize,
    MessageFlags,
    PermissionFlagsBits,
} = require('discord.js');
const { summarizeRootCause } = require('../core/summarizer');

const FOOTER_TEXT = '-# For Cause/Fix/Why use prefix investigation traceid:';

function truncate(str, max = 3800) {
    if (!str) return str;
    return str.length > max ? `${str.slice(0, max - 1)}…` : str;
}

/** Wraps a title + body lines + the mandated footer into one Components v2 container. */
function container(title, bodyMarkdown, { accentColor = 0x3498db, footer = FOOTER_TEXT } = {}) {
    const c = new ContainerBuilder()
        .setAccentColor(accentColor)
        .addTextDisplayComponents((t) => t.setContent(truncate(`## ${title}\n\n${bodyMarkdown}`)));
    if (footer) {
        c.addSeparatorComponents((s) => s.setDivider(true).setSpacing(SeparatorSpacingSize.Small))
            .addTextDisplayComponents((t) => t.setContent(footer));
    }
    return c;
}

function replyPayload(builtContainer, { ephemeral = true } = {}) {
    return {
        components: [builtContainer],
        flags: ephemeral ? [MessageFlags.IsComponentsV2, MessageFlags.Ephemeral] : MessageFlags.IsComponentsV2,
    };
}

// ---- subcommand handlers -------------------------------------------------

/** Feature #2 (trace-based investigation) + #1 (forensic timeline) + #10 (AI root-cause summary), all in one. */
async function handleTrace(interaction, logger) {
    const traceId = interaction.options.getString('traceid', true).trim();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const investigation = logger.investigate(traceId);
    if (!investigation) {
        await interaction.editReply(replyPayload(container('Investigation', `No log records found for trace id \`${traceId}\`. It may have aged out of the in-memory window, or never existed.`, { accentColor: 0xf1c40f })));
        return;
    }

    const summary = await summarizeRootCause(investigation, {
        apiKey: logger.config.ai.openrouterApiKey,
        model: logger.config.ai.model,
        referer: logger.config.ai.referer,
        title: 'forensic-logger investigate',
    });

    const timelineLines = investigation.timeline
        .map((t, i) => `${i + 1}. \`+${Math.round(t.deltaMs)}ms\` **${t.level.toUpperCase()}** ${t.event}${t.error ? ` — ${t.error.name}: ${t.error.message}` : ''}`)
        .join('\n');

    const body = [
        `**Trace ID:** \`${traceId}\``,
        `**First seen:** ${investigation.firstSeen} · **Last seen:** ${investigation.lastSeen} · **Occurrences:** ${investigation.occurrenceCount}`,
        investigation.relatedTraceIds.length ? `**Other traces, same signature:** ${investigation.relatedTraceIds.map((id) => `\`${id}\``).join(', ')}` : null,
        investigation.buildContext?.recentlyDeployed ? `⚠️ **Occurred ${Math.round(investigation.buildContext.msSinceBuildStart / 1000)}s after the current build/process started** — likely deploy-related.` : null,
        '',
        `**Cause:** ${summary.cause || 'n/a'}`,
        summary.fix ? `**Suggested fix:** ${summary.fix}` : null,
        summary.why ? `**Why:** ${summary.why}` : null,
        `**Confidence:** ${summary.confidence || 'n/a'}${summary.model ? ` (model: ${summary.model})` : ''}`,
        '',
        '**Timeline:**',
        timelineLines,
    ].filter((l) => l !== null).join('\n');

    await interaction.editReply(replyPayload(container('Investigation Report', body, {
        accentColor: investigation.errorSummary ? 0xe74c3c : 0x2ecc71,
        footer: `-# Trace \`${traceId}\` · use \`/investigate trace\` again anytime to re-run this`,
    })));
}

/** Feature #3 — error grouping + trends. */
async function handleTrends(interaction, logger) {
    const trends = logger.getTrends({ limit: 10 });
    if (!trends.length) {
        await interaction.reply(replyPayload(container('Error Trends', 'No errors recorded yet.', { accentColor: 0x2ecc71 }), { ephemeral: true }));
        return;
    }
    const arrow = { up: '📈', down: '📉', flat: '➖' };
    const body = trends.map((t, i) => `${i + 1}. ${arrow[t.trend]} **${t.name}**${t.command ? ` (/${t.command})` : ''} — ${t.count} total, ${t.distinctTraces} traces, ${t.lastHourCount} in the last hour\n   _${truncate(t.sampleMessage, 150) || 'no message'}_`).join('\n');
    await interaction.reply(replyPayload(container('Error Trends', body, { accentColor: 0xf1c40f })));
}

/** Feature #9 — search/query system. */
async function handleSearch(interaction, logger) {
    const query = interaction.options.getString('query', true);
    const results = logger.searchLogs(query, { limit: 15 });
    if (!results.length) {
        await interaction.reply(replyPayload(container('Log Search', `No matches for \`${query}\`.`, { accentColor: 0xf1c40f }), { ephemeral: true }));
        return;
    }
    const body = results.map((r, i) => `${i + 1}. \`${r.timestamp}\` **${r.level.toUpperCase()}** ${r.event}${r.traceId ? ` — trace \`${r.traceId}\`` : ''}\n   ${truncate(r.message, 150) || ''}`).join('\n');
    await interaction.reply(replyPayload(container(`Search: "${query}"`, body)));
}

/** Feature #4 — relevant-log filtering. */
async function handleLogs(interaction, logger) {
    const level = interaction.options.getString('level') || undefined;
    const command = interaction.options.getString('command') || undefined;
    const status = interaction.options.getString('status') || undefined;
    const minutes = interaction.options.getInteger('minutes') || 30;

    const results = logger.filterLogs({ level, command, status, sinceMs: Date.now() - minutes * 60_000, limit: 15 });
    if (!results.length) {
        await interaction.reply(replyPayload(container('Filtered Logs', 'No matching log records in that window.', { accentColor: 0xf1c40f }), { ephemeral: true }));
        return;
    }
    const body = results.map((r, i) => `${i + 1}. \`${r.timestamp}\` **${r.level.toUpperCase()}** ${r.event}${r.command ? ` /${r.command}` : ''}${r.status ? ` (${r.status})` : ''} — trace \`${r.traceId || 'n/a'}\``).join('\n');
    await interaction.reply(replyPayload(container(`Logs — last ${minutes}m`, body)));
}

/** Feature #5 — production debug mode. */
async function handleDebug(interaction, logger) {
    const minutes = interaction.options.getInteger('minutes') || 10;
    const command = interaction.options.getString('command') || undefined;
    const user = interaction.options.getUser('user') || undefined;

    logger.enableDebugMode({ durationMs: minutes * 60_000, command, userId: user?.id });
    const scopeBits = [command ? `command \`/${command}\`` : null, user ? `user ${user.tag}` : null].filter(Boolean);
    const scope = scopeBits.length ? scopeBits.join(' + ') : 'all commands';
    await interaction.reply(replyPayload(container('Debug Mode Enabled', `Verbose (trace-level) capture forced for **${scope}** for the next **${minutes} minute(s)**, regardless of the configured production log level.`, { accentColor: 0x3498db }), { ephemeral: true }));
}

/** Feature #8 — Discord interaction timeline. */
async function handleTimeline(interaction, logger) {
    const user = interaction.options.getUser('user');
    const minutes = interaction.options.getInteger('minutes') || 15;
    const events = logger.getInteractionTimeline({ userId: user?.id, guildId: interaction.guildId, aroundMs: Date.now(), windowMs: minutes * 60_000 });

    if (!events.length) {
        await interaction.reply(replyPayload(container('Interaction Timeline', 'No command/button activity in that window.', { accentColor: 0xf1c40f }), { ephemeral: true }));
        return;
    }
    const body = events.map((e, i) => `${i + 1}. \`${e.timestamp}\` ${e.event}${e.command ? ` /${e.command}` : ''}${e.customId ? ` \`${e.customId}\`` : ''}${e.status ? ` (${e.status})` : ''} — trace \`${e.traceId || 'n/a'}\``).join('\n');
    await interaction.reply(replyPayload(container(`Interaction Timeline${user ? ` — ${user.tag}` : ''}`, body)));
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('investigate')
        .setDescription('Forensic log investigation tools')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
        .addSubcommand((sub) => sub.setName('trace')
            .setDescription('Investigate one trace id (AI root-cause summary + full timeline)')
            .addStringOption((opt) => opt.setName('traceid').setDescription('The trace id from a log notification').setRequired(true)))
        .addSubcommand((sub) => sub.setName('trends')
            .setDescription('Show recurring error groups and whether they are trending up or down'))
        .addSubcommand((sub) => sub.setName('search')
            .setDescription('Free-text search across recent log records')
            .addStringOption((opt) => opt.setName('query').setDescription('Text to search for').setRequired(true)))
        .addSubcommand((sub) => sub.setName('logs')
            .setDescription('Filter recent log records')
            .addStringOption((opt) => opt.setName('level').setDescription('Minimum level').addChoices(
                { name: 'trace', value: 'trace' }, { name: 'debug', value: 'debug' }, { name: 'info', value: 'info' },
                { name: 'warn', value: 'warn' }, { name: 'error', value: 'error' }, { name: 'fatal', value: 'fatal' },
            ))
            .addStringOption((opt) => opt.setName('command').setDescription('Filter by command name'))
            .addStringOption((opt) => opt.setName('status').setDescription('Filter by status').addChoices({ name: 'success', value: 'success' }, { name: 'failure', value: 'failure' }))
            .addIntegerOption((opt) => opt.setName('minutes').setDescription('How far back to look (default 30)')))
        .addSubcommand((sub) => sub.setName('debug')
            .setDescription('Temporarily force verbose logging, scoped to a command and/or user')
            .addIntegerOption((opt) => opt.setName('minutes').setDescription('Duration in minutes (default 10)'))
            .addStringOption((opt) => opt.setName('command').setDescription('Scope to one command name'))
            .addUserOption((opt) => opt.setName('user').setDescription('Scope to one user')))
        .addSubcommand((sub) => sub.setName('timeline')
            .setDescription('Recent command/button interaction timeline')
            .addUserOption((opt) => opt.setName('user').setDescription('Filter to one user'))
            .addIntegerOption((opt) => opt.setName('minutes').setDescription('Window size in minutes (default 15)'))),

    async execute(interaction) {
        const logger = interaction.client.logger;
        const sub = interaction.options.getSubcommand();
        if (sub === 'trace') return handleTrace(interaction, logger);
        if (sub === 'trends') return handleTrends(interaction, logger);
        if (sub === 'search') return handleSearch(interaction, logger);
        if (sub === 'logs') return handleLogs(interaction, logger);
        if (sub === 'debug') return handleDebug(interaction, logger);
        if (sub === 'timeline') return handleTimeline(interaction, logger);
        return interaction.reply({ content: 'Unknown subcommand.', ephemeral: true });
    },
};
