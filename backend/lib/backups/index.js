'use strict';
// ============================================================
//  TecXPaneL — lib/backups/index.js — reexporta API plana v1
// ============================================================

const manifest = require('./manifest');
const cron = require('./cron');
const commands = require('./commands');
const engine = require('./engine');
const remote = require('./remote');

module.exports = {
  ...manifest,
  ...cron,
  ...commands,
  commands,
  engine: { createBackup: engine.createBackup, readManifest: engine.readManifest, restoreItem: engine.restoreItem, resolveResourceItems: engine.resolveResourceItems },
  remote,
};