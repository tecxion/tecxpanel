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

function initSchema() {
  for (const { full } of listSql(SCHEMA_DIR)) {
    db.exec(fs.readFileSync(full, 'utf8'));
  }
}

module.exports = { initSchema };
