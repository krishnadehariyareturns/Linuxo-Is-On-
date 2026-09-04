require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { Client, Collection, GatewayIntentBits, ActivityType } = require('discord.js');
const { createLogger, Events } = require('./lib/logger');

const processStartedAt = Date.now();
const pkg = require('../package.json');

const client = new Client({
    intents: [GatewayIntentBits.Guilds],
});

client.commands = new Collection();
client.buttons = new Collection();

const logger = createLogger({ botVersion: pkg.version, shardId: 0 });
client.logger = logger;

// Nothing in this bot has a database or cache yet — this is where you'd
// register checks for them once they exist, e.g.:
//   logger.registerHealthCheck('Database', async () => ({ ok: db.isConnected() }));
// The startup report shows "not configured" gracefully when none are registered.

// ---- command + button loading ----
let commandsLoaded = 0;
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter((file) => file.endsWith('.js'));

for (const file of commandFiles) {
    try {
        const command = require(path.join(commandsPath, file));
        client.commands.set(command.data.name, command);
        commandsLoaded++;

        if (command.buttons) {
            for (const [customId, handler] of Object.entries(command.buttons)) {
                client.buttons.set(customId, handler);
            }
        }
    } catch (err) {
        logger.error('COMMAND_LOAD_ERROR', logger.fromInteraction(null, { file }), err);
    }
}

// A hand-counted tally of the client.on(...) registrations below — discord.js
// doesn't expose a clean "how many listeners did I register for lifecycle
// purposes" count, so this is incremented alongside each one.
let eventsLoaded = 0;
function on(eventName, handler) {
    client.on(eventName, handler);
    eventsLoaded++;
}

client.once('ready', async () => {
    client.user.setActivity('ls', { type: ActivityType.Listening });
    logger.info(Events.BOT_READY, logger.fromInteraction(null, { userTag: client.user.tag }));

    const commandsData = client.commands.map((cmd) => cmd.data.toJSON());
    try {
        if (process.env.GUILD_ID) {
            const guild = await client.guilds.fetch(process.env.GUILD_ID);
            await guild.commands.set(commandsData);
            logger.info('COMMAND_REGISTER', logger.fromInteraction(null, { guildId: guild.id, guildName: guild.name, count: commandsData.length }), {
                message: `Registered ${commandsData.length} command(s) to guild ${guild.name}`,
            });
        } else {
            await client.application.commands.set(commandsData);
            logger.info('COMMAND_REGISTER', logger.fromInteraction(null, { count: commandsData.length }), {
                message: `Registered ${commandsData.length} command(s) globally`,
            });
        }
    } catch (err) {
        logger.error('COMMAND_REGISTER_ERROR', logger.fromInteraction(null, {}), err);
    }

    const webhooksConfigured = Object.values(logger.config.webhook.categories).filter(Boolean).length;
    await logger.reportStartup({
        client,
        commandsLoaded,
        eventsLoaded,
        webhooksConfigured,
        startupDurationMs: Date.now() - processStartedAt,
    });
});

client.on('interactionCreate', async (interaction) => {
    if (interaction.isChatInputCommand()) {
        const command = client.commands.get(interaction.commandName);
        if (!command) return;

        const ctx = logger.fromInteraction(interaction);
        try {
            await logger.command(interaction.commandName, { ...ctx, interaction }, async () => {
                await command.execute(interaction);
            });
        } catch (err) {
            // logger.command already logged COMMAND_ERROR with full telemetry
            // and re-threw the original error unchanged — this just preserves
            // the existing user-facing UX.
            const errorPayload = { content: '❌ There was an error executing that command.', ephemeral: true };
            try {
                if (interaction.replied || interaction.deferred) {
                    await interaction.followUp(errorPayload);
                } else {
                    await interaction.reply(errorPayload);
                }
            } catch (replyErr) {
                logger.error('COMMAND_ERROR_REPLY_FAILED', ctx, replyErr);
            }
        }
        return;
    }

    if (interaction.isButton()) {
        const handler = client.buttons.get(interaction.customId);
        if (!handler) return;

        const ctx = logger.fromInteraction(interaction);
        try {
            await logger.button(interaction.customId, { ...ctx, interaction }, async () => {
                await handler(interaction);
            });
        } catch (err) {
            // Buttons didn't have a user-facing error reply before this change
            // either — preserved as-is; the failure is now fully logged by
            // logger.button() itself (BUTTON_ERROR, with telemetry).
        }
    }
});
eventsLoaded++; // interactionCreate, registered above without the on() counter helper

// ---- gateway / shard telemetry — all of these fire under Guilds-only intents; none need privileged intents ----
on('error', (err) => logger.error(Events.GATEWAY_ERROR, logger.fromInteraction(null, {}), err));
on('warn', (info) => logger.warn(Events.GATEWAY_ERROR, logger.fromInteraction(null, {}), { message: info }));
on('shardError', (err, shardId) => logger.error(Events.SHARD_ERROR, logger.fromInteraction(null, { shardId }), err));
on('shardReady', (shardId) => logger.info(Events.SHARD_READY, logger.fromInteraction(null, { shardId })));
on('shardReconnecting', (shardId) => logger.warn(Events.GATEWAY_RECONNECT, logger.fromInteraction(null, { shardId })));
on('shardDisconnect', (event, shardId) => logger.warn(Events.GATEWAY_DISCONNECT, logger.fromInteraction(null, { shardId, code: event?.code })));
on('guildCreate', (guild) => logger.info(Events.GUILD_JOIN, logger.fromInteraction(null, { guildId: guild.id, guildName: guild.name })));
on('guildDelete', (guild) => logger.info(Events.GUILD_LEAVE, logger.fromInteraction(null, { guildId: guild.id, guildName: guild.name })));

// ---- process-level safety net ----
process.on('unhandledRejection', (reason) => {
    logger.error(Events.UNHANDLED_REJECTION, logger.fromInteraction(null, {}), reason instanceof Error ? reason : new Error(String(reason)));
});

process.on('uncaughtException', async (err) => {
    logger.fatal(Events.UNHANDLED_EXCEPTION, logger.fromInteraction(null, {}), err);
    try {
        await logger.flushAll({ timeoutMs: 3000 });
    } finally {
        process.exit(1);
    }
});

async function gracefulShutdown(signal) {
    const shutdownStartedAt = Date.now();
    logger.info(Events.BOT_SHUTDOWN, logger.fromInteraction(null, { signal }));

    const shutdownDurationMs = Date.now() - shutdownStartedAt;
    await logger.reportShutdown({ shutdownDurationMs });
    await logger.flushAll({ timeoutMs: 5000 });
    logger.stopBackgroundTasks();

    try {
        await client.destroy();
    } catch {
        /* already shutting down, nothing more to do */
    }
    process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

client.login(process.env.DISCORD_TOKEN).catch((err) => {
    logger.fatal(Events.BOT_CRASH, logger.fromInteraction(null, {}), err);
    process.exit(1);
});
