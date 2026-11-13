'use strict';

// ============================================================
//  Test de integración: POST /api/system/exec (solo tokens admin).
//  Express real (puerto 0) + BD SQLite temporal, con el router de
//  auth y el de sistema montados como en server.js.
// ============================================================

// La BD debe apuntar a un directorio temporal ANTES de cargar nada del panel.
const fs = require('fs');
const os = require('os');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'txpl-sysexec-'));
process.env.TXPL_DIR = TMP;
process.env.TXPL_DB = path.join(TMP, 'test.db');

const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { db, queries } = require('../database');
const createAuthRouter = require('../routes/auth');

const SECRET = 'x'.repeat(32);
const PASSWORD = 'secreta123';
let server, base, jwtToken, adminToken, writeToken, readToken;

const userId = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('kiko', ?, 'admin')")
  .run(bcrypt.hashSync(PASSWORD, 4)).lastInsertRowid;

async function call(method, url, bearer, body) {
  const headers = {};
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (body) headers['content-type'] = 'application/json';
  const r = await fetch(base + url, { method, headers, body: body && JSON.stringify(body) });
  const text = await r.text();
  return { status: r.status, text, body: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

const exec = (body, bearer = adminToken) => call('POST', '/api/system/exec', bearer, body);
async function createToken(scope) {
  const r = await call('POST', '/api/auth/tokens', jwtToken, { name: scope, scope, days: 30, password: PASSWORD });
  assert.equal(r.status, 200, `crear token ${scope}`);
  return r.body.token;
}
const execRows = () => db.prepare("SELECT * FROM audit_log WHERE action = 'system.exec' ORDER BY id").all();

before(async () => {
  const app = express();
  app.use(express.json());
  const { router, auth } = createAuthRouter(SECRET, '1h', (req, res, next) => next());
  app.use('/api/auth', router);
  app.use('/api', auth);
  app.use('/api/system', require('../routes/system'));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  jwtToken = jwt.sign({ uid: userId, username: 'kiko', role: 'admin' }, SECRET, { expiresIn: '1h' });
  queries.setPanelFlag.run('ai_admin_enabled', '1');
  adminToken = await createToken('admin');
  writeToken = await createToken('write');
  readToken = await createToken('read');
});

after(() => { server.close(); db.close(); });

test('token admin: echo hola → ok:true, code 0 y salida', async () => {
  const r = await exec({ command: 'echo hola' });
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.code, 0);
  assert.match(r.body.output, /hola/);
});

test('exit 3 → ok:false, code 3', async () => {
  const r = await exec({ command: 'exit 3' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.code, 3);
});

test('cwd /tmp → pwd devuelve /tmp', async () => {
  const r = await exec({ command: 'pwd', cwd: '/tmp' });
  assert.equal(r.body.output.trim(), '/tmp');
});

const { execFileSync } = require('child_process');
// pgrep sale con 1 si no encuentra nada.
const vivos = (patron) => { try { return execFileSync('pgrep', ['-f', patron]).toString().trim(); } catch { return ''; } };

test('timeout mata el grupo entero: sleep 5.31; true con timeout_s 1 → ok:false, sin hijos vivos', async () => {
  const t0 = Date.now();
  const r = await exec({ command: 'sleep 5.31; true', timeout_s: 1 });
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.code, null);
  assert.match(r.body.output, /\[cortado por timeout de 1 s\]$/);
  assert.equal(vivos('sleep 5.31'), '');
});

test('timeout con trap TERM → ok:false en menos de 3 s', async () => {
  const t0 = Date.now();
  const r = await exec({ command: 'trap "" TERM; sleep 3.17; true', timeout_s: 1 });
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(r.body.ok, false);
  assert.equal(vivos('sleep 3.17'), '');
});

test('validaciones → 400', async () => {
  const casos = [
    {}, { command: '' }, { command: '   ' }, { command: 5 }, { command: 'a'.repeat(8001) },
    { command: 'pwd', cwd: 'tmp' }, { command: 'pwd', cwd: '/no/existe/txpl' }, { command: 'pwd', cwd: 3 },
    { command: 'pwd', timeout_s: 0 }, { command: 'pwd', timeout_s: 111 }, { command: 'pwd', timeout_s: '5' }, { command: 'pwd', timeout_s: 1.5 },
  ];
  for (const c of casos) assert.equal((await exec(c)).status, 400, JSON.stringify(c).slice(0, 80));
});

test('salida de 20 MB → el comando termina bien y se devuelven los últimos 64 KB', async () => {
  const r = await exec({ command: "head -c 20000000 /dev/zero | tr '\\0' a; echo FIN" });
  assert.equal(r.body.ok, true);
  assert.equal(r.body.code, 0);
  assert.ok(r.body.output.length <= 65536);
  assert.match(r.body.output, /aFIN\n$/);
});

test('salida no UTF-8 → JSON válido con U+FFFD', async () => {
  const r = await exec({ command: "printf '\\xff\\xfe'" });
  assert.equal(r.status, 200);
  assert.ok(r.body);
  assert.ok(r.body.output.includes('�'));
});

test('tokens write y read → 403; sesión JWT → 403; sin auth → 401', async () => {
  assert.equal((await exec({ command: 'echo x' }, writeToken)).status, 403);
  assert.equal((await exec({ command: 'echo x' }, readToken)).status, 403);
  const j = await exec({ command: 'echo x' }, jwtToken);
  assert.equal(j.status, 403);
  assert.equal(j.body.error, 'Solo un token de control total puede ejecutar comandos');
  assert.equal((await call('POST', '/api/system/exec', null, { command: 'echo x' })).status, 401);
});

test('auditoría: system.exec con el comando (≤500), también si falla, sin el token', async () => {
  const antes = execRows().length;
  await exec({ command: 'exit 7 # auditado' });
  await exec({ command: `echo ${'b'.repeat(700)}` });
  const filas = execRows().slice(antes);
  assert.equal(filas.length, 2);
  assert.equal(filas[0].detail, 'exit 7 # auditado');
  assert.equal(filas[0].user, 'kiko (token:admin)');
  assert.equal(filas[1].detail.length, 500);
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM audit_log').all()).includes(adminToken));
});
