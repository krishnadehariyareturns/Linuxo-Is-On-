'use strict';

const crypto = require('node:crypto');

// HTTP/network codes that are generally safe to retry.
const RETRYABLE_HTTP = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRYABLE_SYSTEM_CODES = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'EPIPE',
]);

function isRetryable(err, httpStatus) {
    if (httpStatus && RETRYABLE_HTTP.has(httpStatus)) return true;
    if (err && RETRYABLE_SYSTEM_CODES.has(err.code)) return true;
    return false;
}

/**
 * Normalize any thrown value into a consistent shape. Accepts real Errors,
 * discord.js DiscordAPIError/HTTPError instances (which carry .status/.code
 * on top of the usual Error fields), and non-Error throws (strings, plain
 * objects) without ever throwing itself.
 */
function normalizeError(err) {
    if (err === null || err === undefined) return null;

    if (!(err instanceof Error)) {
        // Someone threw a string/object/whatever. Don't crash — wrap it.
        return {
            name: 'NonErrorThrown',
            message: typeof err === 'string' ? err : safeStringify(err),
            code: undefined,
            httpStatus: undefined,
            retryable: false,
            stack: undefined,
        };
    }

    // discord.js v14 DiscordAPIError exposes `.code` (Discord's numeric API
    // error code) and `.status` (HTTP status). Older/other error shapes may
    // use `.httpStatus` or nest details under `.rawError`. Check the common
    // spots without assuming any one library is in play.
    const httpStatus = err.status ?? err.httpStatus ?? err.rawError?.status ?? undefined;
    const code = err.code ?? err.rawError?.code ?? undefined;

    return {
        name: err.name || 'Error',
        message: err.message || String(err),
        code,
        httpStatus,
        retryable: isRetryable(err, httpStatus),
        stack: err.stack,
    };
}

function safeStringify(val) {
    try {
        return JSON.stringify(val);
    } catch {
        return String(val);
    }
}

/**
 * A short, single-line summary safe to post to Discord — no stack trace,
 * length-capped. `normalized` is the output of normalizeError().
 */
function safeSummary(normalized, maxLen = 300) {
    if (!normalized) return 'Unknown error';
    const codePart = normalized.code !== undefined ? ` (code ${normalized.code})` : '';
    const statusPart = normalized.httpStatus !== undefined ? ` [HTTP ${normalized.httpStatus}]` : '';
    const summary = `${normalized.name}: ${normalized.message}${codePart}${statusPart}`;
    return summary.length > maxLen ? `${summary.slice(0, maxLen)}…` : summary;
}

function firstStackFrame(stack) {
    if (!stack || typeof stack !== 'string') return '';
    const lines = stack.split('\n');
    // line 0 is "Error: message", line 1 is the first real frame
    const frame = lines[1] || '';
    // Strip absolute filesystem paths down to just "file:line" so
    // fingerprints stay stable across machines/checkouts.
    const match = frame.match(/([^/\\()]+:\d+:\d+)\)?$/);
    return match ? match[1] : frame.trim();
}

/**
 * A short stable hash used to group repeats of "the same" failure for
 * deduplication. Deliberately coarse — same error class + code + command +
 * originating source line, ignoring the specific message text (which can
 * contain variable data like an ID that would otherwise fragment the group).
 */
function fingerprint(normalized, context = {}) {
    if (!normalized) return 'unknown';
    const basis = [
        normalized.name,
        normalized.code ?? '',
        context.command ?? context.event ?? '',
        firstStackFrame(normalized.stack),
    ].join('|');
    return crypto.createHash('sha1').update(basis).digest('hex').slice(0, 10);
}

module.exports = { normalizeError, safeSummary, fingerprint, isRetryable, firstStackFrame };
