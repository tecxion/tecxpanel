'use strict';

// ============================================================
//  Test de integración: POST /api/backups sin lista de recursos.
//  Express real (puerto 0) + BD SQLite temporal; auth falsa y
//  engine.createBackup y run/runSafe sustituidos para no ejecutar
//  mysqldump/tar ni tocar el crontab real.
// ============================================================

// La BD debe apuntar a un directorio temporal ANTES de cargar nada del panel.
const fs = require('fs');
const os = require('os');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'txpl-backups-route-'));
process.env.TXPL_DIR = TMP;
process.env.TXPL_DB = path.join(TMP, 'test.db');

const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const express = require('express');
const engine = require('../lib/backupEngine');
const helpers = require('../lib/helpers');

let server, base, llamadas = [], comandos = [];
engine.createBackup = async (opts) => { llamadas.push(opts); return null; };
// La ruta desestructura run/runSafe al cargarse: se sustituyen ANTES de requerirla.
helpers.runSafe = async (cmd, args) => { comandos.push([cmd, ...args]); return { ok: true, stdout: '' }; };
helpers.run = async (cmd, args) => { comandos.push([cmd, ...args]); return ''; };

const post = async (body, url = '/api/backups') => {
  const r = await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, text: await r.text() };
};

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { username: 't' }; next(); });
  app.use('/api/backups', require('../routes/backups'));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('kind:"full" sin resources respalda todo (llega al motor)', async () => {
  llamadas = [];
  const r = await post({ kind: 'full' });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.text.endsWith('__TXPL_DONE__0'));
  assert.equal(llamadas.length, 1);
  assert.equal(llamadas[0].kind, 'full');
  assert.deepEqual(llamadas[0].items, [{ class: 'panel', name: 'panel' }]);
});

test('una petición no completa sin recursos sigue dando 400', async () => {
  llamadas = [];
  const r = await post({ kind: 'partial', resources: [] });
  assert.equal(r.status, 400);
  assert.equal(llamadas.length, 0);
});

test('/schedule no depende de kind: desactivar responde 200 y reescribe el crontab', async () => {
  comandos = [];
  const r = await post({ enabled: 0 }, '/api/backups/schedule');
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(comandos.map((c) => c.slice(0, 2)), [['crontab', '-l'], ['crontab', comandos[1][1]]]);
});

test('/schedule activado sin recursos sigue dando 400 (no respalda todo)', async () => {
  const r = await post({ enabled: 1, resources: [] }, '/api/backups/schedule');
  assert.equal(r.status, 400);
  assert.match(r.text, /Selecciona al menos un recurso/);
});
