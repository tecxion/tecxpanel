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
  php_version  TEXT
);
