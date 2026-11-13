'use strict';

// queries/panelflags.js — prepared statements de la tabla panel_flags
// (interruptores globales del panel; ver schema/018_panel_flags.sql).
const { db } = require('../client');

module.exports = {
  getPanelFlag: db.prepare('SELECT value FROM panel_flags WHERE key = ?'),
  setPanelFlag: db.prepare('INSERT INTO panel_flags (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
};
