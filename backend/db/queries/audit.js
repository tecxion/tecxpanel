'use strict';

// queries/audit.js — log de auditoría (escrito por db/core.js:audit).
const { db } = require('../client');

module.exports = {
  insertAudit: db.prepare('INSERT INTO audit_log (user, ip, action, detail) VALUES (?, ?, ?, ?)'),
  getAuditLog: db.prepare('SELECT * FROM audit_log ORDER BY ts DESC LIMIT 500'),
};
