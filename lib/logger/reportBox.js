'use strict';

const MIN_WIDTH = 39; // matches the doc's example box width

/**
 * Rounded box report, e.g.:
 * ╭─ COMMAND REPORT ─────────────────────╮
 * │ Command   : /ping                    │
 * ╰─────────────────────────────────────╯
 *
 * `rows` is an array of [label, value] pairs. Rows with an undefined/null
 * value are skipped entirely rather than printed as "undefined" — the box
 * only ever shows data that's actually known.
 */
function renderBoxReport(title, rows) {
    const visibleRows = rows.filter(([, value]) => value !== undefined && value !== null && value !== '');
    const labelWidth = Math.max(...visibleRows.map(([label]) => label.length), 0);

    const lines = visibleRows.map(([label, value]) => {
        const paddedLabel = label.padEnd(labelWidth, ' ');
        return `${paddedLabel} : ${value}`;
    });

    // contentWidth is the width of the text area between the two vertical
    // bars (not counting the single space of padding on each side). Every
    // line — top, body rows, bottom — is built to the same total width of
    // contentWidth + 4 (│ + space + content + space + │), so they always
    // line up regardless of title/content length.
    const contentWidth = Math.max(MIN_WIDTH - 4, ...lines.map((l) => l.length), title.length + 2);
    const dashCount = contentWidth - title.length - 1;

    const top = `╭─ ${title} ${'─'.repeat(Math.max(1, dashCount))}╮`;
    const bottom = `╰${'─'.repeat(contentWidth + 2)}╯`;
    const body = lines.map((l) => `│ ${l.padEnd(contentWidth, ' ')} │`);

    return [top, ...body, bottom].join('\n');
}

/**
 * Underlined section report, e.g.:
 * BOT STARTUP DIAGNOSTICS
 * ────────────────────────
 * Version       : 1.0.0
 *
 * Same row-skipping behavior as renderBoxReport.
 */
function renderSectionReport(title, rows) {
    const visibleRows = rows.filter(([, value]) => value !== undefined && value !== null && value !== '');
    const labelWidth = Math.max(...visibleRows.map(([label]) => label.length), 0);

    const lines = visibleRows.map(([label, value]) => `${label.padEnd(labelWidth, ' ')} : ${value}`);
    const underline = '─'.repeat(Math.max(title.length, ...lines.map((l) => l.length), 24));

    return [title, underline, ...lines].join('\n');
}

module.exports = { renderBoxReport, renderSectionReport };
