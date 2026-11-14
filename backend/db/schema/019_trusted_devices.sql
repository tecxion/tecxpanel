-- trusted_devices: dispositivos recordados ("Recordar este dispositivo" en el login).
-- La cookie HttpOnly lleva `id.secreto`; aquí solo se guarda el SHA-256 del secreto.
-- El secreto rota en cada uso; prev_hash admite el anterior unos segundos (pestañas en paralelo).
CREATE TABLE IF NOT EXISTS trusted_devices (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  secret_hash  TEXT NOT NULL,
  prev_hash    TEXT,
  rotated_at   TEXT,
  label        TEXT NOT NULL,
  ip           TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT,
  expires_at   TEXT NOT NULL
);
