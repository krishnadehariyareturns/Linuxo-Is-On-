'use strict';

const { callOpenRouter, DEFAULT_MODEL } = require('./openrouter');

function fmtTimelineForPrompt(timeline) {
    return timeline.map((t, i) => {
        const bits = [`t+${Math.round(t.deltaMs)}ms`, t.level.toUpperCase(), t.event];
        if (t.command) bits.push(`/${t.command}`);
        if (t.customId) bits.push(`button:${t.customId}`);
        if (t.status) bits.push(`status:${t.status}`);
        if (t.error) bits.push(`ERROR ${t.error.name}: ${t.error.message}${t.error.code ? ` (code ${t.error.code})` : ''}`);
        return `${i + 1}. ${bits.join(' | ')}`;
    }).join('\n');
}

function buildPrompt(investigation) {
    const { traceId, timeline, occurrenceCount, firstSeen, lastSeen, relatedTraceIds, buildContext, interactionTimeline } = investigation;

    const system = [
        'You are a root-cause analysis assistant for a Discord bot\'s operational logs.',
        'You will be given a forensic timeline for one trace id plus surrounding context.',
        'Respond with EXACTLY these sections, in this order, using plain text (no markdown headers):',
        'CAUSE: <one or two sentences on the most likely root cause>',
        'FIX: <concrete, specific suggested fix or mitigation>',
        'WHY: <brief technical reasoning connecting the timeline evidence to your conclusion>',
        'CONFIDENCE: <low, medium, or high>',
        'Never invent facts not supported by the timeline. If the evidence is insufficient, say so plainly in CAUSE and set CONFIDENCE to low.',
    ].join('\n');

    const userLines = [
        `Trace ID: ${traceId}`,
        `First seen: ${firstSeen} — Last seen: ${lastSeen} — Occurrences of this error signature: ${occurrenceCount}`,
        relatedTraceIds.length ? `Other trace ids with the same error signature: ${relatedTraceIds.join(', ')}` : null,
        buildContext ? `Build context: buildId=${buildContext.buildId ?? 'n/a'} deployId=${buildContext.deployId ?? 'n/a'} node=${buildContext.nodeVersion ?? 'n/a'} — ${buildContext.recentlyDeployed ? `this happened only ${Math.round(buildContext.msSinceBuildStart / 1000)}s after the current build/process started` : 'not close to a build/restart'}` : null,
        '',
        'Timeline:',
        fmtTimelineForPrompt(timeline),
        interactionTimeline?.length ? `\nSurrounding user/guild interactions (${interactionTimeline.length}):\n${interactionTimeline.map((e) => `- ${e.timestamp} ${e.event} ${e.command ? `/${e.command}` : e.customId || ''} ${e.status || ''}`).join('\n')}` : null,
    ].filter(Boolean).join('\n');

    return { system, user: userLines };
}

function parseSections(text) {
    const grab = (label) => {
        const re = new RegExp(`${label}:\\s*([\\s\\S]*?)(?=\\n[A-Z]+:|$)`, 'i');
        const m = text.match(re);
        return m ? m[1].trim() : null;
    };
    return {
        cause: grab('CAUSE') || text.trim().slice(0, 500),
        fix: grab('FIX'),
        why: grab('WHY'),
        confidence: (grab('CONFIDENCE') || 'low').toLowerCase(),
    };
}

/**
 * Feature #10 — human-readable root-cause summary. Takes the output of
 * ForensicsStore.investigate(traceId) and an OpenRouter API key, returns a
 * structured { cause, fix, why, confidence, raw, model } summary. Never
 * throws for "no API key configured" — returns a graceful offline fallback
 * instead so /investigate still works (just without the AI narrative).
 */
async function summarizeRootCause(investigation, { apiKey, model = DEFAULT_MODEL, referer, title = 'forensic-logger' } = {}) {
    if (!investigation) {
        return { cause: 'No log records found for that trace id.', fix: null, why: null, confidence: 'low', model: null };
    }

    if (!apiKey) {
        const err = investigation.errorSummary;
        return {
            cause: err
                ? `AI summarization is not configured (no OPENROUTER_API_KEY). Raw error: ${err.name}: ${err.message}`
                : 'AI summarization is not configured (no OPENROUTER_API_KEY), and this trace has no error step — it may still be in progress or completed successfully.',
            fix: 'Set OPENROUTER_API_KEY to enable AI-generated root-cause summaries.',
            why: null,
            confidence: 'low',
            model: null,
            offline: true,
        };
    }

    const { system, user } = buildPrompt(investigation);
    try {
        const { text, model: usedModel } = await callOpenRouter({
            apiKey,
            model,
            referer,
            title,
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: user },
            ],
        });
        return { ...parseSections(text), raw: text, model: usedModel };
    } catch (err) {
        return {
            cause: `AI summarization failed (${err.message}). Falling back to the raw timeline below.`,
            fix: null,
            why: null,
            confidence: 'low',
            model: null,
            offline: true,
        };
    }
}

module.exports = { summarizeRootCause, buildPrompt, parseSections };
