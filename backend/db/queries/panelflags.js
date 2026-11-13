'use strict';

// queries/panelflags.js — interruptores globales del panel (tabla panel_flags).
const { db } = require('../client');

module.exports = {
  getPanelFlag: db.prepare('SELECT value FROM panel_flags WHERE key = ?'),
  setPanelFlag: db.prepare('INSERT INTO panel_flags (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
};
