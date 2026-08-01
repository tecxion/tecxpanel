-- apps: aplicaciones (PM2) gestionadas por el panel.
CREATE TABLE IF NOT EXISTS apps (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL UNIQUE,
  type           TEXT NOT NULL DEFAULT 'nodejs',
  path           TEXT,
  start_cmd      TEXT,
  port           INTEGER,
  domain         TEXT,
  pm2_name       TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'stopped',
  git_repo       TEXT,
  git_branch     TEXT,
  webhook_secret TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
