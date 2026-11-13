'use strict';

// ============================================================
//  Test de integración: POST /api/backups (crear backup).
//  Express real (puerto 0) + SQLite temporal; el motor `createBackup` va
//  stubeado (no se ejecuta ningún dump). Comprueba qué recursos y qué `kind`
//  llegan al motor: sin `resources` => TODO; con `resources` explícito (aunque
//  vacío o inválido) NUNCA se convierte en "todo".
// ============================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'txpl-bkroute-'));
process.env.TXPL_DIR = TMP;
process.env.TXPL_DB = path.join(TMP, 'test.db');

const test = require('node:test');
const { before, after, beforeEach } = test;
const assert = require('node:assert/strict');
const express = require('express');
const { db } = require('../database');
const engine = require('../lib/backupEngine');

let server, base, llamadas;

db.prepare("INSERT INTO databases (name, type, db_user, db_password) VALUES ('midb', 'mysql', 'u', 'p')").run();
db.prepare("INSERT INTO databases (name, type, db_user, db_password) VALUES ('pgdb', 'postgresql', 'u', 'p')").run();
db.prepare("INSERT INTO websites (domain) VALUES ('a.com')").run();
db.prepare("INSERT INTO apps (name, path, pm2_name) VALUES ('miapp', '/tmp/miapp', 'miapp')").run();
const TODO = [
  { class: 'db-mysql', name: 'midb' }, { class: 'db-pg', name: 'pgdb' },
  { class: 'site', name: 'a.com' }, { class: 'app', name: 'miapp' }, { class: 'panel', name: 'panel' },
];

const post = async (body) => {
  const r = await fetch(`${base}/api/backups`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, text: await r.text() };
};

before(async () => {
  engine.createBackup = async (args) => { llamadas.push(args); return { filename: 'x.tar.gz' }; };
  const app = express();
  app.use(express.json());
  app.use('/api/backups', require('../routes/backups'));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(() => { llamadas = []; });
after(() => { server.close(); db.close(); });

const orden = (items) => [...items].sort((a, b) => (a.class + a.name).localeCompare(b.class + b.name));

test('{kind:"full"} y {} respaldan la lista COMPLETA de recursos', async () => {
  for (const body of [{ kind: 'full' }, {}]) {
    llamadas = [];
    const r = await post(body);
    assert.equal(r.status, 200);
    assert.equal(llamadas.length, 1);
    assert.deepEqual(orden(llamadas[0].items), orden(TODO));
    assert.equal(llamadas[0].kind, 'full');
  }
});

test('resources explícito inválido o vacío -> 400 y nunca se convierte en "todo"', async () => {
  for (const resources of [null, [], 'x', {}, [{}]]) {
    const r = await post({ kind: 'full', resources });
    assert.equal(r.status, 400, JSON.stringify(resources));
    assert.match(r.text, /No hay recursos válidos/);
  }
  assert.equal(llamadas.length, 0);
});

test('un recurso concreto respalda solo ese; sin nombre válido -> 400', async () => {
  const r = await post({ kind: 'resource', resources: [{ class: 'panel', name: 'panel' }] });
  assert.equal(r.status, 200);
  assert.deepEqual(llamadas[0].items, [{ class: 'panel', name: 'panel' }]);
  assert.equal(llamadas[0].kind, 'resource');
  assert.equal((await post({ resources: [{ class: 'panel' }] })).status, 400);
});

test('sitio inexistente -> 400', async () => {
  const r = await post({ resources: [{ class: 'site', name: 'no-existe.com' }] });
  assert.equal(r.status, 400);
  assert.equal(llamadas.length, 0);
});

test('kind solo admite "full" o "resource": un objeto o texto raro llega como "full"', async () => {
  for (const kind of [{ evil: 1 }, 'x', 5, null]) {
    llamadas = [];
    assert.equal((await post({ kind })).status, 200);
    assert.equal(llamadas[0].kind, 'full', JSON.stringify(kind));
  }
});
