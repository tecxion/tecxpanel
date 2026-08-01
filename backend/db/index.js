'use strict';

// ============================================================
//  TecXPaneL — db/index.js
//
//  Punto de entrada de la capa de datos v2.0. Orquesta:
//   1) client.js     → abre la BD, WAL/FK, exporta {db, DB_PATH}.
//   2) migrate.js    → aplica schema/ y migrations/ al arrancar.
//   3) core.js       → seedAdmin + audit.
//   4) queries/index.js → objeto de prepared statements agrupados.
//
//  API pública (idéntica a database.js v1):
//      const { db, queries, seedAdmin, audit, DB_PATH } = require('./database');
//  Siguiendo funcionando sin cambios en los 27 archivos que lo importan.
// ============================================================

const { db, DB_PATH } = require('./client');
const { initSchema } = require('./migrate');
const { seedAdmin, audit } = require('./core');
const queries = require('./queries');

// Aplica el esquema (CREATE TABLE IF NOT EXISTS) y ejecuta migraciones
// pendientes justo al cargar este módulo (cuando server.js hace el require).
// No se hace en client.js porque `db.exec(schema SQL)` necesita `db` creado
// pero sin acaparar memoria de migraciones antes de que el motor arranque.
initSchema();

module.exports = { db, queries, seedAdmin, audit, DB_PATH };