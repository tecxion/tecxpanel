'use strict';

// ============================================================
//  Test de integración: middleware `auth` con tokens de API + rutas
//  /api/auth/tokens. Monta un Express real (puerto 0) contra una BD
//  SQLite temporal y comprueba la lista blanca, la caducidad, la
//  revocación, la auditoría de denegaciones y que el JWT no cambia.
// ============================================================

// La BD debe apuntar a un directorio temporal ANTES de cargar nada del panel.
const fs = require('fs');
const os = require('os');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'txpl-apitokens-'));
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
let server, base, jwtToken, readToken, readTokenId;

const userId = db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('kiko', ?, 'admin')")
  .run(bcrypt.hashSync(PASSWORD, 4)).lastInsertRowid;

// Petición a la API de pruebas. `bearer` va en Authorization si se pasa.
async function call(method, url, bearer, body) {
  const headers = {};
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (body) headers['content-type'] = 'application/json';
  const r = await fetch(base + url, { method, headers, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}

const createToken = (fields) => call('POST', '/api/auth/tokens', jwtToken,
  { name: 'mcp', scope: 'read', days: 30, password: PASSWORD, ...fields });
const deniedRows = () => db.prepare("SELECT * FROM audit_log WHERE action = 'apitoken.denied' ORDER BY id").all();
const tokenRow = (id) => db.prepare('SELECT * FROM api_tokens WHERE id = ?').get(id);

before(async () => {
  const app = express();
  app.use(express.json());
  const { router, auth } = createAuthRouter(SECRET, '1h', (req, res, next) => next());
  app.use('/api/auth', router);
  app.use('/api', auth);
  const pega = (req, res) => res.json({ ok: true });
  app.get('/api/system/stats', pega);
  app.get('/api/apps/:id/env', pega);
  app.post('/api/apps/:id/:action', pega);
  app.use('/api/websites', require('../routes/websites'));
  app.use('/api/apps', require('../routes/apps'));
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  jwtToken = jwt.sign({ uid: userId, username: 'kiko', role: 'admin' }, SECRET, { expiresIn: '1h' });
});

after(() => { server.close(); db.close(); });

test('sin cabecera → 401', async () => {
  const r = await call('GET', '/api/system/stats');
  assert.equal(r.status, 401);
});

test('JWT válido en GET /api/apps/1/env → 200 (el JWT no pasa por la lista blanca)', async () => {
  const r = await call('GET', '/api/apps/1/env', jwtToken);
  assert.equal(r.status, 200);
});

test('POST /api/auth/tokens con JWT y contraseña mala → 403', async () => {
  const r = await createToken({ password: 'mala' });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'La contraseña actual no es correcta');
});

test('POST /api/auth/tokens con días no permitidos → 400', async () => {
  assert.equal((await createToken({ days: 7 })).status, 400);
  assert.equal((await createToken({ days: '30' })).status, 400);
});

test('POST /api/auth/tokens: nombre y ámbito inválidos → 400 (antes que la contraseña)', async () => {
  assert.equal((await createToken({ name: 'a/b', password: 'mala' })).status, 400);
  assert.equal((await createToken({ scope: 'admin', password: 'mala' })).status, 400);
});

test('POST /api/auth/tokens con JWT correcto → 200 y token txpl_', async () => {
  const r = await createToken();
  assert.equal(r.status, 200);
  assert.ok(r.body.token.startsWith('txpl_'));
  assert.ok(Number.isInteger(r.body.id));
  readToken = r.body.token;
  readTokenId = r.body.id;
  assert.equal(tokenRow(readTokenId).last_used_at, null);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'apitoken.create' AND detail = 'mcp'").get());
});

test('GET /api/auth/tokens con JWT → lista de 1 sin token_hash ni token', async () => {
  const r = await call('GET', '/api/auth/tokens', jwtToken);
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 1);
  assert.deepEqual(Object.keys(r.body[0]).sort(), ['created_at', 'expires_at', 'id', 'last_used_at', 'name', 'scope']);
});

test('token read en GET /api/system/stats → 200, actualiza last_used_at y no se audita como denegado', async () => {
  const antes = deniedRows().length;
  const r = await call('GET', '/api/system/stats?x=1', readToken);
  assert.equal(r.status, 200);
  assert.notEqual(tokenRow(readTokenId).last_used_at, null);
  assert.equal(deniedRows().length, antes);
});

test('token read en GET /api/apps/1/env → 403 y fila apitoken.denied sin query ni token', async () => {
  const r = await call('GET', '/api/apps/1/env?secreto=1', readToken);
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'Este token no tiene permiso para esta operación');
  const fila = deniedRows().at(-1);
  assert.equal(fila.user, 'kiko (token:mcp)');
  assert.equal(fila.detail, 'GET /api/apps/1/env');
  const todo = JSON.stringify(db.prepare('SELECT * FROM audit_log').all());
  assert.ok(!todo.includes('txpl_') && !todo.includes(tokenRow(readTokenId).token_hash));
});

test('token read en POST /api/apps/1/restart → 403', async () => {
  assert.equal((await call('POST', '/api/apps/1/restart', readToken)).status, 403);
});

test('token read en GET /api/auth/tokens → 403', async () => {
  assert.equal((await call('GET', '/api/auth/tokens', readToken)).status, 403);
});

test('token read en GET /api/auth/me → 403 (ruta del propio router de auth)', async () => {
  const r = await call('GET', '/api/auth/me', readToken);
  assert.equal(r.status, 403);
  assert.equal(deniedRows().at(-1).detail, 'GET /api/auth/me');
});

test('token read en POST /api/auth/password → 403 sin tocar la contraseña', async () => {
  const hashAntes = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId).password_hash;
  const r = await call('POST', '/api/auth/password', readToken, { oldPassword: PASSWORD, newPassword: 'otraclave123' });
  assert.equal(r.status, 403);
  assert.equal(db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId).password_hash, hashAntes);
});

test('token válido en ruta fuera de lista NO actualiza last_used_at', async () => {
  const { id, token } = (await createToken({ name: 'nuevo' })).body;
  assert.equal((await call('GET', '/api/apps/1/env', token)).status, 403);
  assert.equal(tokenRow(id).last_used_at, null);
});

test('token caducado → 401', async () => {
  const { id, token } = (await createToken({ name: 'caduca' })).body;
  db.prepare("UPDATE api_tokens SET expires_at = '2000-01-01 00:00:00' WHERE id = ?").run(id);
  const r = await call('GET', '/api/system/stats', token);
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'No autorizado');
});

test('token revocado con DELETE → 401 en su siguiente uso', async () => {
  const { id, token } = (await createToken({ name: 'revocar' })).body;
  assert.equal((await call('GET', '/api/system/stats', token)).status, 200);
  const r = await call('DELETE', `/api/auth/tokens/${id}`, jwtToken);
  assert.equal(r.status, 200);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'apitoken.revoke' AND detail = 'revocar'").get());
  assert.equal((await call('GET', '/api/system/stats', token)).status, 401);
  assert.equal((await call('DELETE', `/api/auth/tokens/${id}`, jwtToken)).status, 404);
});

test('token inventado txpl_noexiste → 401', async () => {
  const r = await call('GET', '/api/system/stats', 'txpl_noexiste');
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'No autorizado');
});

test('GET /api/websites: webhook_secret solo con JWT, nunca con token de API', async () => {
  db.prepare("INSERT INTO websites (domain, type, webhook_secret) VALUES ('ej.com', 'html', 'secreto-webhook')").run();
  const conJwt = await call('GET', '/api/websites', jwtToken);
  assert.equal(conJwt.status, 200);
  assert.equal(conJwt.body[0].webhook_secret, 'secreto-webhook');
  const conToken = await call('GET', '/api/websites', readToken);
  assert.equal(conToken.status, 200);
  assert.equal(conToken.body[0].domain, 'ej.com');
  assert.ok(!('webhook_secret' in conToken.body[0]));
});

test('git_repo con credenciales: un token de API nunca las recibe; el webhook_secret tampoco', async () => {
  const repo = 'https://user:ghp_SECRET@github.com/o/r.git';
  db.prepare("INSERT INTO websites (domain, type, git_repo, webhook_secret) VALUES ('git.com', 'html', ?, 'wh-web')").run(repo);
  db.prepare("INSERT INTO apps (name, pm2_name, git_repo, webhook_secret) VALUES ('appgit', 'appgit', ?, 'wh-app')").run(repo);
  for (const url of ['/api/websites', '/api/apps']) {
    const t = await call('GET', url, readToken);
    assert.equal(t.status, 200);
    const txt = JSON.stringify(t.body);
    assert.ok(!txt.includes('ghp_SECRET') && !txt.includes('user:'), url);
    assert.ok(txt.includes('https://github.com/o/r.git'), url);
    assert.ok(!txt.includes('wh-web') && !txt.includes('wh-app'), url);
    const j = await call('GET', url, jwtToken); // con sesión todo sigue igual
    assert.ok(JSON.stringify(j.body).includes('wh-' + (url.endsWith('apps') ? 'app' : 'web')), url);
  }
});
