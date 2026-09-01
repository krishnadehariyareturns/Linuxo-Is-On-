'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { renderBoxReport, renderSectionReport } = require('../lib/logger/reportBox');

test('renderBoxReport produces a box where every line is the same visible width', () => {
    const box = renderBoxReport('COMMAND REPORT', [
        ['Command', '/ping'],
        ['Status', 'SUCCESS'],
        ['Duration', '42 ms'],
        ['Trace ID', '01J...'],
        ['Guild', 'A Much Longer Guild Name Than Usual'],
        ['User', 'someuser'],
        ['Handler', 'PingCommand'],
    ]);
    const widths = box.split('\n').map((l) => [...l].length);
    assert.ok(widths.every((w) => w === widths[0]), `expected all lines equal width, got ${widths}`);
});

test('renderBoxReport starts with ╭ and ends the box with ╰...╯', () => {
    const box = renderBoxReport('X', [['A', '1']]);
    const lines = box.split('\n');
    assert.ok(lines[0].startsWith('╭'));
    assert.ok(lines[lines.length - 1].startsWith('╰'));
    assert.ok(lines[lines.length - 1].endsWith('╯'));
});

test('renderBoxReport omits rows with undefined/null/empty values', () => {
    const box = renderBoxReport('COMMAND REPORT', [
        ['Command', '/ping'],
        ['API calls', undefined],
        ['Cache', null],
        ['Notes', ''],
    ]);
    assert.ok(!box.includes('API calls'));
    assert.ok(!box.includes('Cache'));
    assert.ok(!box.includes('Notes'));
    assert.ok(box.includes('Command'));
});

test('renderBoxReport handles a title longer than any row content', () => {
    const box = renderBoxReport('A VERY LONG REPORT TITLE INDEED', [['A', '1']]);
    const widths = box.split('\n').map((l) => [...l].length);
    assert.ok(widths.every((w) => w === widths[0]));
});

test('renderSectionReport pairs a title with an underline of matching or greater length', () => {
    const report = renderSectionReport('BOT STARTUP DIAGNOSTICS', [
        ['Version', '1.0.0'],
        ['Node', 'v22'],
    ]);
    const [title, underline] = report.split('\n');
    assert.equal(title, 'BOT STARTUP DIAGNOSTICS');
    assert.ok(underline.length >= title.length);
    assert.ok(/^─+$/.test(underline));
});

test('renderSectionReport omits undefined rows', () => {
    const report = renderSectionReport('TITLE', [
        ['Known', 'value'],
        ['Unknown', undefined],
    ]);
    assert.ok(!report.includes('Unknown'));
});
