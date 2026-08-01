'use strict';

// ============================================================
//  TecXPaneL — lib/common/index.js
//
//  Reexporta la API plana de helpers (v1 compatible):
//    const { ok, fail, clientIp, run, runSafe, wrap } = require('../lib/helpers');
//
//  Los módulos nuevos pueden pedir sub-módulos:
//    const { run, runSafe } = require('../lib/common/run');
// ============================================================

const { ok, fail, clientIp, wrap } = require('./http');
const { run, runSafe } = require('./run');
const { streamStart, streamWrite, streamEnd, DONE_MARKER } = require('./streaming');

module.exports = { ok, fail, clientIp, run, runSafe, wrap, streamStart, streamWrite, streamEnd, DONE_MARKER };