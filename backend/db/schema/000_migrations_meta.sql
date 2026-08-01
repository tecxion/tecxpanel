-- Tabla de control del runner de migraciones: registra qué fichero SQL
-- de migrations/ se ha aplicado, para no reaplicarlo en arranques sucesivos.
CREATE TABLE IF NOT EXISTS _migrations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
