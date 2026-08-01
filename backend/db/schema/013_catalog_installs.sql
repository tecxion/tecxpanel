-- catalog_installs: instalaciones del catálogo one-click (WordPress, Ghost, etc.).
-- Solo se inserta una fila al confirmarse el éxito de la instalación.
CREATE TABLE IF NOT EXISTS catalog_installs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id     TEXT NOT NULL UNIQUE,
  mode       TEXT NOT NULL,
  domain     TEXT,
  port       INTEGER,
  ref        TEXT,
  db_name    TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
