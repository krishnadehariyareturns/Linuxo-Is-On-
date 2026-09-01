'use strict';

const { createLogger } = require('./core');
const { Events } = require('./eventNames');
const levels = require('./levels');

module.exports = { createLogger, Events, levels };
