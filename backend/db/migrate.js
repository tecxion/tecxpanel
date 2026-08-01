'use strict';

// ============================================================
//  TecXPaneL — Runner de esquema y migraciones
//
//  Aplica en arranque:
//   1) db/schema/*.sql  → definen las tablas (CREATE TABLE IF NOT EXISTS).
//                        Idempotentes: seguros de reejecutar.
//   2) db/migrations/*.sql → ALTER TABLEs históricos numerados.
//                        Se registran en la tabla _migrations; cada uno
//                        se ejecuta una sola vez.
//
//  Caso BD heredada de v1 (sin _migrations): el runner detecta que ya
//  existen tablas no creadas por él y marca todas las migraciones como
//  "ya aplicadas" sin tocar nada, para no reaplicar ALTERs que ya corrieron
//  en el histórico try/catch de la v1.
// ============================================================

const fs = require('fs');
const path = require('path');
const { db } = require('./client');

const SCHEMA_DIR = path.join(__dirname, 'schema');
const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function listSql(dir) {
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => ({ name: f, full: path.join(dir, f) }));
}

// Aplica todos los CREATE TABLE. Idempotente (CREATE ... IF NOT EXISTS).
function applySchema() {
  for (const { name, full } of listSql(SCHEMA_DIR)) {
    const sql = fs.readFileSync(full, 'utf8');
    db.exec(sql);
  }
}

// ¿La BD viene de v1? Heurística: existe la tabla users (creada por la v1)
// ANTES de que se aplique nuestro schema/001_users.sql. La comprobamos
// justo antes de crear _migrations (que está en schema/000).
function isLegacyV1Database() {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='users'"
  ).get();
  return !!row;
}

// Marca todas las migraciones como ya aplicadas sin ejecutarlas.
// Se usa solo cuando detectamos una BD v1 existente.
function markAllMigrationsApplied() {
  for (const { name } of listSql(MIGRATIONS_DIR)) {
    db.prepare('INSERT OR IGNORE INTO _migrations (name) VALUES (?)').run(name);
  }
}

// Aplica migraciones pendientes registrándolas en _migrations.
function applyMigrations(isLegacy) {
  if (isLegacy) {
    // Comprueba si ya habíamos migrado antes a v2 (alguna fila en _migrations).
    const ran = db.prepare('SELECT COUNT(*) AS c FROM _migrations').get();
    if (!ran || !ran.c) {
      console.log('[db] Detectada BD v1 existente: marcando migraciones históricas como aplicadas.');
      markAllMigrationsApplied();
    }
  }
  for (const { name, full } of listSql(MIGRATIONS_DIR)) {
    const already = db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(name);
    if (already) continue;
    const sql = fs.readFileSync(full, 'utf8');
    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(name);
    });
    tx();
    console.log(`[db] Migración aplicada: ${name}`);
  }
}

function initSchema() {
  const legacy = isLegacyV1Database();
  applySchema();
  applyMigrations(legacy);
}

module.exports = { initSchema, applySchema, applyMigrations };
