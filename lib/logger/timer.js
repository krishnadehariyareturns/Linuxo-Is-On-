'use strict';

const { performance } = require('node:perf_hooks');

function startTimer() {
    return performance.now();
}

function elapsedMs(startedAt) {
    return performance.now() - startedAt;
}

module.exports = { startTimer, elapsedMs };
