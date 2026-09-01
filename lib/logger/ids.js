'use strict';

const crypto = require('node:crypto');

// UUIDv4 via Node's built-in crypto module. Not lexicographically sortable
// like a ULID would be, but zero-dependency and perfectly sufficient for
// correlating log lines by ID — nothing here ever sorts by trace ID.
function newTraceId() {
    return crypto.randomUUID();
}

function newRequestId() {
    return crypto.randomUUID();
}

module.exports = { newTraceId, newRequestId };
