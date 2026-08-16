-- Seguimiento de despliegues Docker largos (ZIP/Git).
CREATE TABLE IF NOT EXISTS docker_jobs (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL,
  container_name  TEXT NOT NULL,
  status          TEXT NOT NULL,
  user_name       TEXT,
  image_tag       TEXT,
  container_id    TEXT,
  log_text        TEXT NOT NULL DEFAULT '',
  error_text      TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_docker_jobs_status ON docker_jobs(status, created_at DESC);
