'use strict';

// Panel ya instalado con el api_tokens antiguo (CHECK read/write): initSchema()
// debe ampliar el CHECK a 'admin' sin perder filas, y ser idempotente.
const fs = require('fs');
const os = require('os');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'txpl-schema-'));
process.env.TXPL_DIR = TMP;
process.env.TXPL_DB = path.join(TMP, 'test.db');

const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

// BD "vieja" creada antes de cargar el panel.
const vieja = new Database(process.env.TXPL_DB);
vieja.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'admin');
  CREATE TABLE api_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
    scope TEXT NOT NULL CHECK (scope IN ('read','write')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL, last_used_at TEXT);
  INSERT INTO users (username, password_hash) VALUES ('kiko', 'x');
  INSERT INTO api_tokens (user_id, name, token_hash, scope, expires_at) VALUES (1, 'viejo', 'h1', 'read', '2099-01-01 00:00:00');
`);
vieja.close();

const { initSchema } = require('../db/schema');
const { db } = require('../db/client');

test('initSchema amplía el CHECK de api_tokens conservando filas (idempotente)', () => {
  initSchema();
  initSchema();
  assert.deepEqual(db.prepare('SELECT name, scope, token_hash FROM api_tokens').all(), [{ name: 'viejo', scope: 'read', token_hash: 'h1' }]);
  db.prepare("INSERT INTO api_tokens (user_id, name, token_hash, scope, expires_at) VALUES (1, 'adm', 'h2', 'admin', '2099-01-01 00:00:00')").run();
  assert.throws(() => db.prepare("INSERT INTO api_tokens (user_id, name, token_hash, scope, expires_at) VALUES (1, 'x', 'h3', 'otro', '2099-01-01')").run());
  assert.throws(() => db.prepare("INSERT INTO api_tokens (user_id, name, token_hash, scope, expires_at) VALUES (1, 'x', 'h1', 'read', '2099-01-01')").run()); // UNIQUE sigue
  assert.equal(db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE name = 'api_tokens_old'").get().c, 0);
  db.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});
