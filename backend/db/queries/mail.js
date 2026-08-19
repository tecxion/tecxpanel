'use strict';

// queries/mail.js — config (fila única id=1) de docker-mailserver + webmail.
const { db } = require('../client');

module.exports = {
  getMailConfig: db.prepare('SELECT * FROM mail_config WHERE id = 1'),
  saveMailConfig: db.prepare(`
    INSERT INTO mail_config (id, hostname, domain, container_id, status, dkim_selector, dkim_public, created_at)
    VALUES (1, @hostname, @domain, @container_id, @status, @dkim_selector, @dkim_public, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      hostname = @hostname, domain = @domain, container_id = @container_id,
      status = @status, dkim_selector = @dkim_selector, dkim_public = @dkim_public`),
  clearMailConfig:   db.prepare('DELETE FROM mail_config WHERE id = 1'),
  setMailWebmail:    db.prepare('UPDATE mail_config SET webmail_domain = ?, webmail_port = ?, webmail_container = ? WHERE id = 1'),
  clearMailWebmail:  db.prepare('UPDATE mail_config SET webmail_domain = NULL, webmail_port = NULL, webmail_container = NULL WHERE id = 1'),

  // Relay SMTP saliente (fila única id=1). Contraseña cifrada en password_enc.
  getMailRelay: db.prepare('SELECT * FROM mail_relay WHERE id = 1'),
  saveMailRelay: db.prepare(`
    INSERT INTO mail_relay (id, host, port, username, password_enc, enabled, updated_at)
    VALUES (1, @host, @port, @username, @password_enc, @enabled, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      host = @host, port = @port, username = @username,
      password_enc = @password_enc, enabled = @enabled, updated_at = datetime('now')`),
};
