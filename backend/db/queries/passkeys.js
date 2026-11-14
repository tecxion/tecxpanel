'use strict';

// queries/passkeys.js — prepared statements de webauthn_credentials.
const { db } = require('../client');

module.exports = {
  insertPasskey:    db.prepare('INSERT INTO webauthn_credentials (user_id, credential_id, public_key, counter, transports, name) VALUES (?, ?, ?, ?, ?, ?)'),
  listPasskeys:     db.prepare('SELECT id, name, credential_id, transports, created_at, last_used_at FROM webauthn_credentials WHERE user_id = ? ORDER BY id DESC'),
  getPasskeyByCred: db.prepare('SELECT c.*, u.username, u.role FROM webauthn_credentials c JOIN users u ON u.id = c.user_id WHERE c.credential_id = ?'),
  usePasskey:       db.prepare("UPDATE webauthn_credentials SET counter = ?, last_used_at = datetime('now') WHERE id = ?"),
  deletePasskey:    db.prepare('DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?'),
};
