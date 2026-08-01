-- backup_remote: fila única (id=1) con el destino remoto S3/SFTP ( creds AES-256-GCM ).
CREATE TABLE IF NOT EXISTS backup_remote (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  type             TEXT NOT NULL,
  config_enc       TEXT NOT NULL,
  remote_path      TEXT NOT NULL DEFAULT '',
  encrypt_enabled  INTEGER NOT NULL DEFAULT 0,
  crypt_pass_enc   TEXT,
  auto_upload      INTEGER NOT NULL DEFAULT 0,
  retention_days   INTEGER NOT NULL DEFAULT 30,
  status           TEXT NOT NULL DEFAULT 'unconfigured',
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
