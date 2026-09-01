# Linuxo

Penguin/terminal-themed Discord bot starter.

## Setup

1. `npm install`
2. Copy `.env.example` to `.env` and fill in `DISCORD_TOKEN` (from the [Discord Developer Portal](https://discord.com/developers/applications)). Add `GUILD_ID` too if you want `/startup` to appear instantly instead of waiting on global command propagation (~1 hour).
3. In the Developer Portal's OAuth2 URL Generator: check `bot` + `applications.commands`, and under bot permissions check `Send Messages`, `Embed Links`, `Attach Files`. Use the generated link to invite the bot.
4. `npm start`

No privileged intents needed — the bot only requests `Guilds`.

## What's here

- `/startup` — posts the Linuxo status panel (Components V2). Uptime and latency refresh every 5s for 45s, then freeze.
  - Latency is `client.ws.ping`, which only updates on Discord's heartbeat ack (~every 30-40s), so it can repeat across a couple of refreshes — that's expected.
  - The "Ctrl + C" button deletes the panel message, but only for whoever ran `/startup`. Anyone else who clicks it gets an ephemeral "Oops, Error 404" reply.
- Rich presence set to "Listening to ls" on boot.
- Slash commands auto-register on startup — to your `GUILD_ID` if set, global otherwise.
- A structured logging/telemetry system (`lib/logger/`) instrumenting every command and button automatically — see below.

## Logging & telemetry

Every slash command and button click is wrapped automatically — you don't need to touch `commands/*.js` to get this. It logs to the console always, and optionally to Discord webhooks and/or a local file.

**Setup:** fill in whichever `LOG_WEBHOOK_*` URLs you want in `.env` (create them under a channel's Settings → Integrations → Webhooks). None are required — with all blank, you still get full console logging, just no Discord delivery. See `.env.example` for every option.

**What you get, with zero code changes:**
- `COMMAND_START` / `COMMAND_END` / `COMMAND_ERROR` for every slash command, with duration, trace ID, guild/user, and (on failure) a normalized error — printed as a report box in dev console, JSON in prod.
- The same for buttons (`BUTTON_START`/`BUTTON_END`/`BUTTON_ERROR`).
- A startup diagnostics report and a shutdown report (on `SIGINT`/`SIGTERM`) with command counts, success/failure totals, and p50/p95/p99-style latency stats.
- Automatic secret redaction (tokens, passwords, webhook URLs, etc.) before anything is logged anywhere.
- Slow-command detection, error deduplication (repeats of the same failure get suppressed on Discord, never in the console/JSON record), retry+backoff and a circuit breaker for webhook delivery, and backpressure limits on the internal queue.

**Extension points, for when this bot grows:**
- `logger.registerHealthCheck(name, async () => ({ok, detail}))` — wire up a database/cache/external-service check; it shows up in the startup report automatically. Nothing's registered today since there's no DB/cache yet.
- `logger.task({event, errorEvent, context, handler})` — the same wrapping pattern as commands, for future DB queries or external API calls (`Events.DATABASE_QUERY`/`DATABASE_ERROR`, `EXTERNAL_API_REQUEST`/`_ERROR` are already defined).
- Inside a command handler, `interaction.client.logger.contextFor(interaction)` returns the live context object for that call — set `.metrics.apiCalls` / `.metrics.cache` on it to have those numbers show up in that command's report.
- Message/member events (`MESSAGE_CREATE`, `MEMBER_JOIN`, etc.) are defined in the event taxonomy but not wired up, since they need privileged intents (`GuildMessages`/`MessageContent`, `GuildMembers`) that aren't enabled by default — turn them on in the Developer Portal and in `index.js`'s `intents` array first.

Run `npm test` to run the logger's own test suite (95 tests covering redaction, error handling, the webhook queue/retry/circuit-breaker, and the full logging pipeline).
