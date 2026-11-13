-- panel_flags: interruptores globales del panel (clave → valor '1'/'0').
-- Una clave ausente equivale a apagado (p. ej. ai_admin_enabled).
CREATE TABLE IF NOT EXISTS panel_flags (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
