-- api_tokens: credenciales para acceso por API (p. ej. el servidor MCP).
-- Solo se guarda el SHA-256 del token; el valor real se muestra una vez al crearlo.
CREATE TABLE IF NOT EXISTS api_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  scope        TEXT NOT NULL CHECK (scope IN ('read','write','admin')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at   TEXT NOT NULL,
  last_used_at TEXT
);
