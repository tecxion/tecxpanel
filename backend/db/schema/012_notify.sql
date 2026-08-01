-- notify_config: fila única (id=1) con la config de Telegram + SMTP (creds cifradas).
-- notify_state: estado por recurso vigente por el monitor (disco/servicios/contenedores/SSL).
CREATE TABLE IF NOT EXISTS notify_config (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  telegram_enabled    INTEGER NOT NULL DEFAULT 0,
  telegram_token_enc  TEXT,
  telegram_chat_id    TEXT,
  smtp_enabled        INTEGER NOT NULL DEFAULT 0,
  smtp_host           TEXT,
  smtp_port           INTEGER NOT NULL DEFAULT 587,
  smtp_secure         INTEGER NOT NULL DEFAULT 0,
  smtp_user           TEXT,
  smtp_pass_enc       TEXT,
  smtp_from           TEXT,
  smtp_to             TEXT,
  ev_disk_enabled     INTEGER NOT NULL DEFAULT 1,
  ev_disk_threshold   INTEGER NOT NULL DEFAULT 90,
  ev_services_enabled INTEGER NOT NULL DEFAULT 1,
  ev_security_enabled INTEGER NOT NULL DEFAULT 1,
  ev_ssl_enabled      INTEGER NOT NULL DEFAULT 1,
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notify_state (
  key            TEXT PRIMARY KEY,
  status         TEXT NOT NULL,
  pending_status TEXT,
  pending_count  INTEGER NOT NULL DEFAULT 0,
  since          TEXT,
  notified       INTEGER NOT NULL DEFAULT 1,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
