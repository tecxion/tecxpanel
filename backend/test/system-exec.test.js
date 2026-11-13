'use strict';

// ============================================================
//  Test de integración: POST /api/system/exec (solo tokens `admin`).
//  Express real (puerto 0) + SQLite temporal. Ejecuta comandos reales
//  e inocuos (echo, exit, pwd, sleep, head, printf) en la VM de pruebas.
// ============================================================

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
const { db } = require('../database');
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
  return { status: r.status, body: await r.json().catch(() => null) };
}
const exec = (bearer, body) => call('POST', '/api/system/exec', bearer, body);
const createToken = (fields) => call('POST', '/api/auth/tokens', jwtToken,
  { name: 'mcp', scope: 'read', days: 30, password: PASSWORD, ...fields });
const auditRows = (action) => db.prepare('SELECT * FROM audit_log WHERE action = ? ORDER BY id').all(action);

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
  await call('POST', '/api/auth/ai-admin', jwtToken, { enabled: true, password: PASSWORD });
  adminToken = (await createToken({ name: 'adm', scope: 'admin', days: 7 })).body.token;
  writeToken = (await createToken({ name: 'wr', scope: 'write' })).body.token;
  readToken = (await createToken({ name: 'rd', scope: 'read' })).body.token;
});

after(() => { server.close(); db.close(); });

test('echo hola → ok, code 0, output con hola', async () => {
  const r = await exec(adminToken, { command: 'echo hola' });
  assert.equal(r.status, 200);
  assert.equal(r.body.success, true);
  assert.equal(r.body.ok, true);
  assert.equal(r.body.code, 0);
  assert.match(r.body.output, /hola/);
});

test('exit 3 → ok:false, code 3', async () => {
  const r = await exec(adminToken, { command: 'exit 3' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.code, 3);
});

test('stderr se une a stdout', async () => {
  const r = await exec(adminToken, { command: 'echo out; echo err >&2' });
  assert.match(r.body.output, /out/);
  assert.match(r.body.output, /err/);
});

test('cwd se respeta', async () => {
  const r = await exec(adminToken, { command: 'pwd', cwd: '/tmp' });
  assert.equal(r.body.output.trim(), '/tmp');
});

test('timeout: sleep 5 con timeout_s 1 termina en <3 s, ok:false, code null', async () => {
  const t0 = Date.now();
  const r = await exec(adminToken, { command: 'sleep 5', timeout_s: 1 });
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(r.body.ok, false);
  assert.equal(r.body.code, null);
});

test('timeout mata también a los hijos (no quedan huérfanos)', async () => {
  const marca = `txpl-huerfano-${process.pid}`;
  // `;` impide que bash haga exec del último comando: el sleep es un hijo real.
  await exec(adminToken, { command: `sleep 7.${process.pid % 100} ; true # ${marca}`, timeout_s: 1 });
  const { execFileSync } = require('child_process');
  let vivos = '';
  try { vivos = execFileSync('pgrep', ['-f', `sleep 7.${process.pid % 100}`]).toString(); } catch (_) { /* sin coincidencias */ }
  assert.equal(vivos.trim(), '');
});

test('validación → 400', async () => {
  const malos = [
    {}, { command: '' }, { command: '   ' }, { command: 42 },
    { command: 'x'.repeat(8001) },
    { command: 'true', cwd: 'relativo' },
    { command: 'true', cwd: '/no/existe/jamas' },
    { command: 'true', cwd: '/etc/hostname' }, // existe pero no es directorio (o no existe: 400 igualmente)
    { command: 'true', cwd: 5 },
    { command: 'true', timeout_s: 0 },
    { command: 'true', timeout_s: 111 },
    { command: 'true', timeout_s: 1.5 },
    { command: 'true', timeout_s: '5' },
  ];
  for (const b of malos) assert.equal((await exec(adminToken, b)).status, 400, JSON.stringify(b).slice(0, 60));
});

test('salida grande → últimos 64 KB con aviso de recorte', async () => {
  const r = await exec(adminToken, { command: 'head -c 200000 /dev/zero | tr "\\0" "a"; printf FIN' });
  assert.equal(r.status, 200);
  assert.ok(r.body.output.length <= 65536 + 32);
  assert.ok(r.body.output.startsWith('[…recortado…]'));
  assert.ok(r.body.output.endsWith('FIN'));
});

test('salida no UTF-8 → JSON válido con U+FFFD', async () => {
  const r = await exec(adminToken, { command: "printf '\\xff\\xfe'" });
  assert.equal(r.status, 200);
  assert.match(r.body.output, /�/);
});

test('token read y write → 403; sesión JWT → 403; sin auth → 401', async () => {
  assert.equal((await exec(readToken, { command: 'echo x' })).status, 403);
  assert.equal((await exec(writeToken, { command: 'echo x' })).status, 403);
  const j = await exec(jwtToken, { command: 'echo x' });
  assert.equal(j.status, 403);
  assert.equal(j.body.error, 'Este token no tiene permiso para esta operación');
  assert.equal((await exec(undefined, { command: 'echo x' })).status, 401);
});

test('auditoría system.exec también cuando el comando falla; recorta a 500', async () => {
  const antes = auditRows('system.exec').length;
  await exec(adminToken, { command: 'exit 9 # marca-auditoria' });
  await exec(adminToken, { command: 'echo ' + 'y'.repeat(700) });
  const filas = auditRows('system.exec');
  assert.equal(filas.length, antes + 2);
  assert.equal(filas[antes].detail, 'exit 9 # marca-auditoria');
  assert.match(filas[antes].user, /token:adm/);
  assert.equal(filas[antes + 1].detail.length, 500);
});

test('un 400 no se audita ni ejecuta', async () => {
  const antes = auditRows('system.exec').length;
  await exec(adminToken, { command: '' });
  assert.equal(auditRows('system.exec').length, antes);
});

test('interruptor apagado → 403 aunque el token sea admin', async () => {
  await call('POST', '/api/auth/ai-admin', jwtToken, { enabled: false, password: PASSWORD });
  assert.equal((await exec(adminToken, { command: 'echo x' })).status, 403);
});
