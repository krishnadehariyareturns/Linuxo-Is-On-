'use strict';

// Substring match against the lowercased key. "webhookUrl", "WEBHOOK_URL",
// "clientSecret" etc. all match one of these regardless of casing/separators.
const DEFAULT_SENSITIVE_KEYS = [
    'token',
    'authorization',
    'auth',
    'cookie',
    'password',
    'passwd',
    'secret',
    'apikey',
    'api_key',
    'webhookurl',
    'webhook_url',
    'privatekey',
    'private_key',
];

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 8;

function keyMatches(key, sensitiveKeys) {
    const flat = String(key).toLowerCase().replace(/[\s_-]/g, '');
    return sensitiveKeys.some((s) => flat.includes(s.replace(/[\s_-]/g, '')));
}

function truncateString(str, maxLen) {
    if (typeof str !== 'string' || !maxLen || str.length <= maxLen) return str;
    return `${str.slice(0, maxLen)}…(+${str.length - maxLen} chars)`;
}

/**
 * Recursively redact sensitive keys from a value. Handles circular
 * references, arrays, Error instances, Dates, and depth limits so a
 * pathological or accidentally-circular context object can never hang the
 * process or throw out of the logger.
 */
function redact(value, options = {}) {
    const sensitiveKeys = [...DEFAULT_SENSITIVE_KEYS, ...(options.extraKeys || [])];
    const maxStringLength = options.maxStringLength || 0;
    const seen = new WeakSet();

    function walk(val, depth, keyHint) {
        if (val === null || val === undefined) return val;

        if (typeof val === 'string') {
            return truncateString(val, maxStringLength);
        }

        if (typeof val === 'function') return '[Function]';
        if (typeof val === 'symbol') return val.toString();
        if (typeof val !== 'object') return val; // number, boolean, bigint

        if (val instanceof Date) return val.toISOString();
        if (val instanceof RegExp) return val.toString();

        if (depth >= MAX_DEPTH) return '[MaxDepth]';

        if (seen.has(val)) return '[Circular]';
        seen.add(val);

        if (val instanceof Error) {
            // Errors are normalized separately by errors.js before they ever
            // reach here in practice, but if a raw Error slips through, don't
            // let it serialize into "{}" — Error's own properties are almost
            // all non-enumerable.
            return {
                name: val.name,
                message: truncateString(val.message, maxStringLength),
            };
        }

        if (Array.isArray(val)) {
            return val.map((item) => walk(item, depth + 1));
        }

        const out = {};
        for (const [k, v] of Object.entries(val)) {
            if (keyMatches(k, sensitiveKeys)) {
                out[k] = REDACTED;
                continue;
            }
            out[k] = walk(v, depth + 1, k);
        }
        return out;
    }

    return walk(value, 0);
}

module.exports = { redact, DEFAULT_SENSITIVE_KEYS, keyMatches };
