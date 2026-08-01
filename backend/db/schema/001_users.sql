-- users: usuarios del panel (admin por defecto). Un único usuario admin en v1.
-- v2.0 (Fase 2 - RBAC) añadirá aquí las columnas de roles/permisos vía migrations separadas.
CREATE TABLE IF NOT EXISTS users (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  username             TEXT NOT NULL UNIQUE,
  password_hash        TEXT NOT NULL,
  role                 TEXT NOT NULL DEFAULT 'admin',
  totp_secret          TEXT,
  totp_enabled         INTEGER NOT NULL DEFAULT 0,
  created_at           TEXT NOT NULL DEFAULT (datetime('now')),
  email                TEXT,
  security_question    TEXT,
  security_answer_hash TEXT
);
