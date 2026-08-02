'use strict';

// ============================================================
//  TecXPaneL — db/index.js
//
//  Punto de entrada de la capa de datos v2.0. Orquesta:
//   1) client.js     → abre la BD, WAL/FK, exporta {db, DB_PATH}.
//   2) schema.js     → aplica schema/*.sql al arrancar (sin migrations).
//   3) core.js       → seedAdmin + audit.
//   4) queries/index.js → objeto de prepared statements agrupados.
//
//  API pública (idéntica a database.js v1):
//      const { db, queries, seedAdmin, audit, DB_PATH } = require('./database');
//  Siguiendo funcionando sin cambios en los 27 archivos que lo importan.
// ============================================================

const { db, DB_PATH } = require('./client');
const { initSchema } = require('./schema');

// Aplica el esquema (CREATE TABLE IF NOT EXISTS de db/schema/*.sql) al
// cargar este módulo (cuando server.js hace el require). Sin sistema de
// migraciones: sobre una BD nueva crea todas las tablas; sobre una BD ya
// creada, no toca nada (idempotente).
initSchema();

const { seedAdmin, audit } = require('./core');
const queries = require('./queries');

module.exports = { db, queries, seedAdmin, audit, DB_PATH };