-- mail_config: fila única (id=1) con la config del contenedor docker-mailserver.
-- Las contraseñas de los buzones NUNCA se guardan aquí: docker-mailserver es la fuente.
CREATE TABLE IF NOT EXISTS mail_config (
  id                INTEGER PRIMARY KEY CHECK (id = 1),
  hostname          TEXT,
  domain            TEXT,
  container_id      TEXT,
  status            TEXT DEFAULT 'not_installed',
  dkim_selector     TEXT DEFAULT 'mail',
  dkim_public       TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  -- Columnas del webmail Roundcube (añadidas históricamente por ALTER).
  webmail_domain    TEXT,
  webmail_port      INTEGER,
  webmail_container TEXT
);
