'use strict';

// ============================================================
//  Test de integración: POST /api/apps/:id/reload (lo usa la
//  herramienta MCP reiniciar_app {modo:'reload'}). Express real +
//  BD temporal; runSafe sustituido para no llamar a pm2 de verdad.
// ============================================================

// La BD debe apuntar a un directorio temporal ANTES de cargar nada del panel.
const fs = require('fs');
const os = require('os');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'txpl-apps-reload-'));
process.env.TXPL_DIR = TMP;
process.env.TXPL_DB = path.join(TMP, 'test.db');

const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const express = require('express');
const helpers = require('../lib/helpers');
const { db, queries } = require('../database');

let server, base, comandos = [];
// La ruta desestructura runSafe al cargarse: se sustituye ANTES de requerirla.
helpers.runSafe = async (cmd, args) => { comandos.push([cmd, ...args]); return { ok: true, stdout: '', stderr: '' }; };

before(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.user = { username: 't' }; next(); });
  app.use('/api/apps', require('../routes/apps'));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server.close(); db.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

test('POST /:id/reload → pm2 reload <pm2_name> y estado running', async () => {
  const id = queries.insertApp.run({
    name: 'miapp', type: 'nodejs', path: path.join(TMP, 'miapp'), start_cmd: null, port: null, domain: null,
    pm2_name: 'txpl-miapp', status: 'stopped', git_repo: null, git_branch: null, webhook_secret: null, git_token: null,
  }).lastInsertRowid;
  const r = await fetch(`${base}/api/apps/${id}/reload`, { method: 'POST' });
  assert.equal(r.status, 200, await r.text());
  assert.deepEqual(comandos, [['pm2', 'reload', 'txpl-miapp']]);
  assert.equal(queries.getApp.get(id).status, 'running');
});
