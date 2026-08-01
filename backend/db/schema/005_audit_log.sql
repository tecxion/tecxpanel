-- audit_log: traza de acciones mutantes. El helper audit() escribe aquí.
CREATE TABLE IF NOT EXISTS audit_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     TEXT NOT NULL DEFAULT (datetime('now')),
  user   TEXT,
  ip     TEXT,
  action TEXT NOT NULL,
  detail TEXT
);
