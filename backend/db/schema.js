'use strict';

// ============================================================
//  TecXPaneL — Aplicación del esquema de la BD
//
//  Ejecuta al arranque los CREATE TABLE IF NOT EXISTS de db/schema/*.sql
//  en orden alfabético. Es idempotente: si las tablas ya existen (BD que ya
//  arrancó antes), no las toca. Si es una BD nueva (fichero vacío recién
//  creado por better-sqlite3), las crea todas.
//
//  Instalación limpia: sin sistema de migraciones ni compatibilidad con
//  BDs heredadas. Cualquier cambio de columnas se hace editando el .sql
//  correspondiente en db/schema/ y arrancando sobre una BD nueva.
// ============================================================

const fs = require('fs');
const path = require('path');
const { db } = require('./client');

const SCHEMA_DIR = path.join(__dirname, 'schema');

function listSql(dir) {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ name: f, full: path.join(dir, f) }));
}

// Columnas añadidas DESPUÉS de la primera versión de su tabla. CREATE TABLE IF NOT
// EXISTS no toca una tabla que ya existe, así que un panel ya instalado se
// quedaría sin ellas. Se añaden aquí si faltan (idempotente, no pierde datos).
// Las BDs nuevas ya las traen del .sql.
const ADDED_COLUMNS = [
  ['websites', 'proxy_port', 'INTEGER'],
  ['websites', 'git_repo', 'TEXT'],
  ['websites', 'git_branch', 'TEXT'],
  ['websites', 'git_token', 'TEXT'],
  ['websites', 'webhook_secret', 'TEXT'],
  ['apps', 'git_token', 'TEXT'],
];

function addMissingColumns() {
  for (const [table, col, def] of ADDED_COLUMNS) {
    const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
  }
}

// El ámbito 'admin' de api_tokens llegó después de 017: CREATE TABLE IF NOT EXISTS
// no cambia un CHECK existente y SQLite no permite alterarlo, así que en un panel
// ya instalado se reconstruye la tabla conservando las filas (idempotente).
function rebuildApiTokensCheck() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='api_tokens'").get();
  if (!row || row.sql.includes("'admin'")) return;
  db.transaction(() => {
    db.exec('ALTER TABLE api_tokens RENAME TO api_tokens_old');
    db.exec(fs.readFileSync(path.join(SCHEMA_DIR, '017_api_tokens.sql'), 'utf8'));
    const cols = 'id, user_id, name, token_hash, scope, created_at, expires_at, last_used_at';
    db.exec(`INSERT INTO api_tokens (${cols}) SELECT ${cols} FROM api_tokens_old`);
    db.exec('DROP TABLE api_tokens_old');
  })();
}

function initSchema() {
  for (const { full } of listSql(SCHEMA_DIR)) {
    db.exec(fs.readFileSync(full, 'utf8'));
  }
  addMissingColumns();
  rebuildApiTokensCheck();
}

module.exports = { initSchema };
