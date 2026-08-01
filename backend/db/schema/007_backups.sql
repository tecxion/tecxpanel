-- backups: catálogo de backups (completos o por recurso) y su estado.
CREATE TABLE IF NOT EXISTS backups (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  filename    TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  size_bytes  INTEGER NOT NULL DEFAULT 0,
  kind        TEXT NOT NULL DEFAULT 'full',
  scope       TEXT NOT NULL DEFAULT '[]',
  origin      TEXT NOT NULL DEFAULT 'manual',
  status      TEXT NOT NULL DEFAULT 'running',
  notes       TEXT
);

-- backup_schedule: programación (fila única id=1).
CREATE TABLE IF NOT EXISTS backup_schedule (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  enabled         INTEGER NOT NULL DEFAULT 0,
  frequency       TEXT NOT NULL DEFAULT 'daily',
  time            TEXT NOT NULL DEFAULT '03:00',
  retention_days  INTEGER NOT NULL DEFAULT 7,
  resources       TEXT NOT NULL DEFAULT '[]'
);
