'use strict';

const { createLogger } = require('./core/core');
const { Events } = require('./core/eventNames');
const levels = require('./core/levels');
const { ForensicsStore, semanticSignature } = require('./core/forensics');
const { summarizeRootCause, buildPrompt } = require('./core/summarizer');
const { callOpenRouter, DEFAULT_MODEL } = require('./core/openrouter');
const { buildLogComponent, toMessagePayload } = require('./core/components');
const investigateCommand = require('./commands/investigate');

module.exports = {
    // Core logger — same shape as before extraction (createLogger, Events, levels),
    // now returning a component-based (not embed-based) instance with a
    // `.forensics` surface attached.
    createLogger,
    Events,
    levels,

    // Forensics engine, exposed directly for anyone who wants to build their
    // own commands/dashboards on top instead of using the bundled slash command.
    ForensicsStore,
    semanticSignature,

    // AI root-cause summarization.
    summarizeRootCause,
    buildPrompt,
    callOpenRouter,
    DEFAULT_MODEL,

    // Components v2 rendering, in case you want to reuse the same look
    // elsewhere (e.g. a status page bot posting the same style of report).
    buildLogComponent,
    toMessagePayload,

    // Ready-to-register discord.js slash command: { data, execute }.
    // Expects `interaction.client.logger` to be the logger instance
    // returned by createLogger() — see README for wiring instructions.
    investigateCommand,
};
