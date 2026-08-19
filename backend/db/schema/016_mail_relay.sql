-- mail_relay: fila única (id=1) con el relay/smarthost SMTP para el envío saliente.
-- Se usa cuando el proveedor bloquea el puerto 25 y el correo debe salir a través
-- de otro servicio (Brevo/SendGrid/Mailgun/SES/Gmail…). La contraseña se guarda
-- cifrada (AES-256-GCM); nunca en claro. Es opcional: sin relay, envío directo.
CREATE TABLE IF NOT EXISTS mail_relay (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  host         TEXT,
  port         INTEGER DEFAULT 587,
  username     TEXT,
  password_enc TEXT,
  enabled      INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
