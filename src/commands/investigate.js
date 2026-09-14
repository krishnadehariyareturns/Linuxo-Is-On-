'use strict';

// The actual command lives in the vendored forensic-logger package so it
// stays identical to the standalone npm package's copy — see
// src/lib/forensic-logger/README.md for the package on its own.
module.exports = require('../lib/forensic-logger/commands/investigate');
