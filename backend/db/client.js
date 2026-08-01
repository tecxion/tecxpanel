'use strict';

// ============================================================
//  TecXPaneL — Cliente SQLite (better-sqlite3)
//
//  Abre (o crea) el fichero txpl.db, activa WAL y foreign_keys.
//  Es lo único que "toca" el objeto Database; todo el resto del
//  panel consume `db` desde aquí. Ubicarlo aparte facilita un
//  futuro swap a otra lib (node:sqlite nativo, libsql…) sin tocar
//  ni queries ni rutas.
// ============================================================

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const TXPL_DIR = process.env.TXPL_DIR || '/opt/txpl';
const DATA_DIR = path.join(TXPL_DIR, 'data');
const DB_PATH = process.env.TXPL_DB || path.join(DATA_DIR, 'txpl.db');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
// WAL: lecturas y escrituras concurrentes sin bloqueos; los procesos
// externos (ej. reset-password) ven los cambios al instante.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

module.exports = { db, DB_PATH };
