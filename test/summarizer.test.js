'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeRootCause, buildPrompt, parseSections } = require('../src/lib/forensic-logger/core/summarizer');

const sampleInvestigation = {
    traceId: 'trace-1',
    timeline: [
        { deltaMs: 0, level: 'info', event: 'COMMAND_START', command: 'backup', status: undefined, error: null },
        { deltaMs: 120, level: 'error', event: 'COMMAND_ERROR', command: 'backup', status: 'failure', error: { name: 'Error', message: 'ENOSPC: no space left on device' } },
    ],
    errorSummary: { name: 'Error', message: 'ENOSPC: no space left on device' },
    occurrenceCount: 4,
    firstSeen: '2026-01-01T00:00:00.000Z',
    lastSeen: '2026-01-01T00:05:00.000Z',
    relatedTraceIds: ['trace-0'],
    buildContext: { buildId: 'b1', deployId: 'd1', nodeVersion: 'v20', msSinceBuildStart: 5000, recentlyDeployed: true },
    interactionTimeline: [],
};

test('buildPrompt includes the trace id, timeline, and build context', () => {
    const { system, user } = buildPrompt(sampleInvestigation);
    assert.ok(system.includes('CAUSE:'));
    assert.ok(user.includes('trace-1'));
    assert.ok(user.includes('ENOSPC'));
    assert.ok(user.includes('recently deployed') || user.includes('after the current build/process started'));
});

test('parseSections extracts CAUSE/FIX/WHY/CONFIDENCE from a well-formed AI reply', () => {
    const text = 'CAUSE: Disk ran out of space during backup.\nFIX: Increase volume size or prune old backups.\nWHY: The ENOSPC error occurred 120ms into the backup command.\nCONFIDENCE: high';
    const sections = parseSections(text);
    assert.equal(sections.cause, 'Disk ran out of space during backup.');
    assert.equal(sections.confidence, 'high');
    assert.ok(sections.fix.includes('volume size'));
});

test('summarizeRootCause returns a graceful offline fallback when no API key is configured', async () => {
    const result = await summarizeRootCause(sampleInvestigation, { apiKey: '' });
    assert.equal(result.offline, true);
    assert.ok(result.cause.includes('ENOSPC'));
});

test('summarizeRootCause handles a missing investigation (unknown trace id) without throwing', async () => {
    const result = await summarizeRootCause(null, { apiKey: 'k' });
    assert.ok(result.cause.includes('No log records'));
});

test('summarizeRootCause calls OpenRouter and parses the response when an API key is present', async () => {
    const fakeFetch = async () => ({
        ok: true,
        json: async () => ({
            model: 'openrouter/free',
            choices: [{ message: { content: 'CAUSE: Disk full.\nFIX: Free up space.\nWHY: ENOSPC seen in timeline.\nCONFIDENCE: medium' } }],
        }),
    });

    // Monkey-patch global fetch just for this test's callOpenRouter call.
    const originalFetch = global.fetch;
    global.fetch = fakeFetch;
    try {
        const result = await summarizeRootCause(sampleInvestigation, { apiKey: 'test-key' });
        assert.equal(result.cause, 'Disk full.');
        assert.equal(result.confidence, 'medium');
        assert.equal(result.model, 'openrouter/free');
    } finally {
        global.fetch = originalFetch;
    }
});
