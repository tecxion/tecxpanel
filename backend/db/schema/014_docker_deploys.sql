-- docker_deploys: despliegues Docker desde Git (para re-desplegar sin volver a pedir datos).
-- git_token_enc y los envs sensibles cifrados con AES-256-GCM.
CREATE TABLE IF NOT EXISTS docker_deploys (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  container_name  TEXT NOT NULL UNIQUE,
  raw_repo_url    TEXT NOT NULL,
  git_branch      TEXT NOT NULL DEFAULT 'main',
  git_token_enc   TEXT,
  template        TEXT NOT NULL DEFAULT 'dockerfile',
  container_port  INTEGER,
  host_port       INTEGER,
  domain          TEXT,
  ssl             INTEGER NOT NULL DEFAULT 0,
  volume_name     TEXT,
  volume_path     TEXT,
  envs            TEXT,
  sub_dir         TEXT,
  dockerfile_path TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
