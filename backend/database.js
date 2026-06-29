// ============================================================
//  TecXPaneL — Capa de datos (SQLite)
//  /opt/txpl/backend/database.js
//
//  Toda la información del panel (usuarios, sitios, apps, BDs,
//  auditoría) se guarda en una única base de datos SQLite: un
//  fichero (.db) en TXPL_DIR/data/txpl.db, sin servidor aparte.
//
//  Usamos better-sqlite3 porque es SÍNCRONO: las consultas
//  devuelven el resultado directamente (sin callbacks ni await),
//  lo que simplifica mucho el código. El fichero se respalda con
//  txpl-backup.sh.
// ============================================================

'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const TXPL_DIR = process.env.TXPL_DIR || '/opt/txpl';
const DATA_DIR = path.join(TXPL_DIR, 'data');
const DB_PATH = process.env.TXPL_DB || path.join(DATA_DIR, 'txpl.db');

// Asegura que existe la carpeta de datos antes de abrir la BD.
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
// WAL (Write-Ahead Logging): permite leer y escribir a la vez sin bloqueos,
// y hace que un proceso externo (ej. el comando reset-password) vea los
// cambios al instante.
db.pragma('journal_mode = WAL');
// Activa las claves foráneas (relaciones entre tablas).
db.pragma('foreign_keys = ON');

// ── Esquema ───────────────────────────────────────────────────
db.exec(`
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

  CREATE TABLE IF NOT EXISTS websites (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    domain     TEXT NOT NULL UNIQUE,
    type       TEXT NOT NULL DEFAULT 'html',
    php        INTEGER NOT NULL DEFAULT 0,
    ssl        INTEGER NOT NULL DEFAULT 0,
    status     TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

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

  CREATE TABLE IF NOT EXISTS databases (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    type        TEXT NOT NULL DEFAULT 'mysql',
    db_user     TEXT NOT NULL,
    db_password TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'active',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id     INTEGER PRIMARY KEY AUTOINCREMENT,
    ts     TEXT NOT NULL DEFAULT (datetime('now')),
    user   TEXT,
    ip     TEXT,
    action TEXT NOT NULL,
    detail TEXT
  );
`);

// ── Migraciones para BDs creadas con versiones anteriores ─────
// ALTER TABLE lanza si la columna ya existe → se ignora con try/catch.
try { db.exec("ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0"); } catch (_) { /* ya existe */ }
try { db.exec("ALTER TABLE websites ADD COLUMN listen_port INTEGER"); } catch (_) {}
try { db.exec("ALTER TABLE websites ADD COLUMN php_version TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE apps ADD COLUMN git_repo TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE apps ADD COLUMN git_branch TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE apps ADD COLUMN webhook_secret TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE users ADD COLUMN email TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE users ADD COLUMN security_question TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE users ADD COLUMN security_answer_hash TEXT"); } catch (_) {}

// ── Seed del usuario admin desde el .env ──────────────────────
// La contraseña NUNCA se guarda en claro: se almacena el hash bcrypt.
function seedAdmin() {
  const username = process.env.ADMIN_USER || 'admin';
  const plain = process.env.ADMIN_PASS;
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);

  const email = process.env.ADMIN_EMAIL || 'admin@localhost.local';
  const securityQuestion = process.env.SECURITY_QUESTION || '¿Nombre de tu primera mascota?';
  const securityAnswer = process.env.SECURITY_ANSWER || 'admin';
  const securityAnswerHash = bcrypt.hashSync(securityAnswer.toLowerCase().trim(), 12);

  if (!existing) {
    if (!plain) {
      throw new Error(
        'ADMIN_PASS no está definido en el .env y no hay usuario admin en la BD. ' +
        'Define ADMIN_PASS antes del primer arranque.'
      );
    }
    const hash = bcrypt.hashSync(plain, 12);
    db.prepare('INSERT INTO users (username, password_hash, role, email, security_question, security_answer_hash) VALUES (?, ?, ?, ?, ?, ?)')
      .run(username, hash, 'admin', email, securityQuestion, securityAnswerHash);
    console.log(`[db] Usuario admin "${username}" creado con datos de recuperación.`);
  } else {
    // Si ya existe pero no tiene datos de recuperación (ej: tras actualización), rellenarlos
    const user = db.prepare('SELECT email, security_question, security_answer_hash FROM users WHERE username = ?').get(username);
    if (user && (!user.email || !user.security_question || !user.security_answer_hash)) {
      db.prepare('UPDATE users SET email = COALESCE(email, ?), security_question = COALESCE(security_question, ?), security_answer_hash = COALESCE(security_answer_hash, ?) WHERE username = ?')
        .run(email, securityQuestion, securityAnswerHash, username);
      console.log(`[db] Datos de recuperación asignados al admin "${username}" existente.`);
    }

    if (plain && process.env.TXPL_RESET_ADMIN_PASS === '1') {
      // Permite rotar la contraseña poniendo TXPL_RESET_ADMIN_PASS=1 una vez.
      const hash = bcrypt.hashSync(plain, 12);
      db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(hash, username);
      console.log(`[db] Contraseña del admin "${username}" actualizada.`);

      // También actualizamos los datos de recuperación si el administrador realiza un reset de credenciales
      if (process.env.ADMIN_EMAIL || process.env.SECURITY_QUESTION || process.env.SECURITY_ANSWER) {
        db.prepare('UPDATE users SET email = ?, security_question = ?, security_answer_hash = ? WHERE username = ?')
          .run(email, securityQuestion, securityAnswerHash, username);
        console.log(`[db] Datos de recuperación del admin "${username}" actualizados (reset).`);
      }
    }
  }
}

// ── Consultas preparadas (prepared statements) ────────────────
// Una "prepared statement" es una consulta SQL compilada una sola vez y
// reutilizada muchas. Tiene dos grandes ventajas:
//   1) Velocidad: SQLite no re-analiza el SQL en cada llamada.
//   2) Seguridad: los valores van como PARÁMETROS (?, @nombre), nunca
//      concatenados, lo que evita la inyección SQL.
// Se ejecutan con .get() (una fila), .all() (varias) o .run() (insert/update).
const queries = {
  // users
  getUserByName: db.prepare('SELECT * FROM users WHERE username = ?'),
  getUserById:   db.prepare('SELECT id, username, role, totp_secret, totp_enabled FROM users WHERE id = ?'),
  getUserFullById: db.prepare('SELECT * FROM users WHERE id = ?'),
  setPassword:   db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
  setTotpSecret: db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?'),
  enableTotp:    db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?'),
  disableTotp:   db.prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?'),
  getRecovery:   db.prepare('SELECT email, security_question FROM users WHERE id = ?'),
  setRecovery:   db.prepare('UPDATE users SET email = ?, security_question = ?, security_answer_hash = ? WHERE id = ?'),
  setRecoveryNoAnswer: db.prepare('UPDATE users SET email = ?, security_question = ? WHERE id = ?'),

  // websites
  listWebsites:  db.prepare('SELECT * FROM websites ORDER BY created_at DESC'),
  getWebsite:    db.prepare('SELECT * FROM websites WHERE id = ?'),
  getWebsiteByDomain: db.prepare('SELECT * FROM websites WHERE domain = ?'),
  insertWebsite: db.prepare('INSERT INTO websites (domain, type, php, ssl, status, listen_port, php_version) VALUES (@domain, @type, @php, @ssl, @status, @listen_port, @php_version)'),
  getMaxListenPort: db.prepare('SELECT MAX(listen_port) as maxPort FROM websites'),
  setWebsiteSsl: db.prepare('UPDATE websites SET ssl = 1 WHERE id = ?'),
  deleteWebsite: db.prepare('DELETE FROM websites WHERE id = ?'),

  // apps
  listApps:   db.prepare('SELECT * FROM apps ORDER BY created_at DESC'),
  getApp:     db.prepare('SELECT * FROM apps WHERE id = ?'),
  getAppByName: db.prepare('SELECT * FROM apps WHERE name = ?'),
  getAppByWebhookSecret: db.prepare('SELECT * FROM apps WHERE webhook_secret = ?'),
  insertApp:  db.prepare('INSERT INTO apps (name, type, path, start_cmd, port, domain, pm2_name, status, git_repo, git_branch, webhook_secret) VALUES (@name, @type, @path, @start_cmd, @port, @domain, @pm2_name, @status, @git_repo, @git_branch, @webhook_secret)'),
  setAppStatus: db.prepare('UPDATE apps SET status = ? WHERE id = ?'),
  setAppConfig: db.prepare('UPDATE apps SET type = ?, start_cmd = ? WHERE id = ?'),
  setAppDeployConfig: db.prepare('UPDATE apps SET type = ?, start_cmd = ?, port = ?, domain = ? WHERE id = ?'),
  setAppGitConfig: db.prepare('UPDATE apps SET git_repo = ?, git_branch = ? WHERE id = ?'),
  deleteApp:  db.prepare('DELETE FROM apps WHERE id = ?'),

  // databases
  listDatabases:  db.prepare('SELECT * FROM databases ORDER BY created_at DESC'),
  getDatabase:    db.prepare('SELECT * FROM databases WHERE id = ?'),
  getDatabaseByName: db.prepare('SELECT * FROM databases WHERE name = ?'),
  insertDatabase: db.prepare('INSERT INTO databases (name, type, db_user, db_password, status) VALUES (@name, @type, @db_user, @db_password, @status)'),
  deleteDatabase: db.prepare('DELETE FROM databases WHERE id = ?'),

  // audit
  insertAudit: db.prepare('INSERT INTO audit_log (user, ip, action, detail) VALUES (?, ?, ?, ?)'),
  getAuditLog: db.prepare('SELECT * FROM audit_log ORDER BY ts DESC LIMIT 500'),
};

function audit(user, ip, action, detail) {
  try {
    queries.insertAudit.run(user || null, ip || null, action, detail || null);
  } catch (_) { /* el log de auditoría nunca debe tumbar una petición */ }
}

module.exports = { db, queries, seedAdmin, audit, DB_PATH };
