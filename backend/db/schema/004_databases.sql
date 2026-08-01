-- databases: bases de datos MySQL/PostgreSQL gestionadas (credenciales AES-256-GCM).
CREATE TABLE IF NOT EXISTS databases (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  type        TEXT NOT NULL DEFAULT 'mysql',
  db_user     TEXT NOT NULL,
  db_password TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
