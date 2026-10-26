-- websites: virtual hosts de Nginx gestionados por el panel.
CREATE TABLE IF NOT EXISTS websites (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  domain       TEXT NOT NULL UNIQUE,
  type         TEXT NOT NULL DEFAULT 'html',
  php          INTEGER NOT NULL DEFAULT 0,
  ssl          INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  -- Las dos columnas siguientes se añaden vía migrations/0002-*.sql;
  -- se declaran aquí también para que una BD nueva salga correctamente.
  listen_port  INTEGER,
  php_version  TEXT,
  -- Tipo 'proxy': puerto local al que reenvía Nginx.
  proxy_port     INTEGER,
  -- Origen Git (opcional). git_token va cifrado (AES-256-GCM); webhook_secret
  -- es el secreto de la URL de auto-actualización en cada push.
  git_repo       TEXT,
  git_branch     TEXT,
  git_token      TEXT,
  webhook_secret TEXT
);
