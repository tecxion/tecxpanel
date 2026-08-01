'use strict';

// queries/notify.js — config (fila única id=1) y estado vigilado por monitor.js.
const { db } = require('../client');

module.exports = {
  getNotifyConfig: db.prepare('SELECT * FROM notify_config WHERE id = 1'),
  upsertNotifyConfig: db.prepare(`
    INSERT INTO notify_config (id, telegram_enabled, telegram_token_enc, telegram_chat_id,
      smtp_enabled, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass_enc, smtp_from, smtp_to,
      ev_disk_enabled, ev_disk_threshold, ev_services_enabled, ev_security_enabled, ev_ssl_enabled, updated_at)
    VALUES (1, @telegram_enabled, @telegram_token_enc, @telegram_chat_id,
      @smtp_enabled, @smtp_host, @smtp_port, @smtp_secure, @smtp_user, @smtp_pass_enc, @smtp_from, @smtp_to,
      @ev_disk_enabled, @ev_disk_threshold, @ev_services_enabled, @ev_security_enabled, @ev_ssl_enabled, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      telegram_enabled = excluded.telegram_enabled,
      telegram_token_enc = excluded.telegram_token_enc,
      telegram_chat_id = excluded.telegram_chat_id,
      smtp_enabled = excluded.smtp_enabled,
      smtp_host = excluded.smtp_host,
      smtp_port = excluded.smtp_port,
      smtp_secure = excluded.smtp_secure,
      smtp_user = excluded.smtp_user,
      smtp_pass_enc = excluded.smtp_pass_enc,
      smtp_from = excluded.smtp_from,
      smtp_to = excluded.smtp_to,
      ev_disk_enabled = excluded.ev_disk_enabled,
      ev_disk_threshold = excluded.ev_disk_threshold,
      ev_services_enabled = excluded.ev_services_enabled,
      ev_security_enabled = excluded.ev_security_enabled,
      ev_ssl_enabled = excluded.ev_ssl_enabled,
      updated_at = excluded.updated_at
  `),
  getNotifyState: db.prepare('SELECT * FROM notify_state WHERE key = ?'),
  upsertNotifyState: db.prepare(`
    INSERT INTO notify_state (key, status, pending_status, pending_count, since, notified, updated_at)
    VALUES (@key, @status, @pending_status, @pending_count, @since, @notified, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      status = excluded.status,
      pending_status = excluded.pending_status,
      pending_count = excluded.pending_count,
      since = excluded.since,
      notified = excluded.notified,
      updated_at = excluded.updated_at
  `),
  // ¿Hubo ya un login OK desde esta IP? (para el aviso de "IP nueva")
  hasLoginFromIp: db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'login.ok' AND ip = ?"),
};
