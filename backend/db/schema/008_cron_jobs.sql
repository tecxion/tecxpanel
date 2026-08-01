-- cron_jobs: tareas programadas gestionadas (fuente de la verdad para el crontab de root).
CREATE TABLE IF NOT EXISTS cron_jobs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  command    TEXT NOT NULL,
  minute     TEXT NOT NULL DEFAULT '*',
  hour       TEXT NOT NULL DEFAULT '*',
  dom        TEXT NOT NULL DEFAULT '*',
  month      TEXT NOT NULL DEFAULT '*',
  dow        TEXT NOT NULL DEFAULT '*',
  enabled    INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
