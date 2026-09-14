'use strict';

// Numeric ordering lets us do cheap "is this enabled" comparisons instead of
// string switches everywhere. Higher number = more severe.
const LEVELS = {
    trace: 10,
    debug: 20,
    info: 30,
    warn: 40,
    error: 50,
    fatal: 60,
};

const LEVEL_NAMES = Object.keys(LEVELS);

// ANSI escape codes, used only by the pretty console transport. Kept here
// instead of scattered through core.js so the whole "what does a level look
// like" concept lives in one place.
const COLORS = {
    trace: '\x1b[90m', // grey
    debug: '\x1b[36m', // cyan
    info: '\x1b[32m', // green
    warn: '\x1b[33m', // yellow
    error: '\x1b[31m', // red
    fatal: '\x1b[41m\x1b[97m', // white on red
};
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

function normalizeLevel(level) {
    const name = String(level ?? 'info').toLowerCase();
    return Object.prototype.hasOwnProperty.call(LEVELS, name) ? name : 'info';
}

function levelValue(level) {
    return LEVELS[normalizeLevel(level)];
}

/**
 * Is `candidate` allowed to pass a floor of `configured`?
 * e.g. isEnabled('info', 'debug') === false — debug is below the info floor.
 */
function isEnabled(configured, candidate) {
    return levelValue(candidate) >= levelValue(configured);
}

function colorize(level, text) {
    const c = COLORS[normalizeLevel(level)] || '';
    return `${c}${text}${RESET}`;
}

module.exports = {
    LEVELS,
    LEVEL_NAMES,
    COLORS,
    RESET,
    DIM,
    BOLD,
    normalizeLevel,
    levelValue,
    isEnabled,
    colorize,
};
