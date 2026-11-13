-- panel_flags: interruptores globales del panel (clave → valor de texto).
-- Ausente = apagado. Hoy solo `ai_admin_enabled` ('1' / '0'): permite usar
-- tokens de API de ámbito `admin` (control total).
CREATE TABLE IF NOT EXISTS panel_flags (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
