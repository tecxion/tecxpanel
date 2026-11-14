'use strict';

// Test de integración: dispositivos recordados (cookie HttpOnly rotativa) sobre el router de auth real.
const fs = require('fs');
const os = require('os');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'txpl-devices-'));
process.env.TXPL_DIR = TMP;
process.env.TXPL_DB = path.join(TMP, 'test.db');

const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../database');
const createAuthRouter = require('../routes/auth');
const devices = require('../lib/devices');

const PASSWORD = 'secreta123';
let server, base;
db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('kiko', ?, 'admin')").run(bcrypt.hashSync(PASSWORD, 4));

// Petición con cookie opcional; devuelve también el valor `id.secreto` de la cookie nueva (si la hay).
async function call(method, url, { cookie, body, bearer } = {}) {
  const headers = {};
  if (cookie) headers.cookie = `${devices.COOKIE}=${cookie}`;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (body) headers['content-type'] = 'application/json';
  const r = await fetch(base + url, { method, headers, body: body && JSON.stringify(body) });
  const sc = r.headers.get('set-cookie') || '';
  const m = new RegExp(`${devices.COOKIE}=([^;]*)`).exec(sc);
  return { status: r.status, body: await r.json().catch(() => null), setCookie: sc, cookie: m ? m[1] : null };
}
const login = (remember) => call('POST', '/api/auth/login', { body: { username: 'kiko', password: PASSWORD, remember } });

before(async () => {
  const app = express();
  app.use(express.json());
  const { router } = createAuthRouter('x'.repeat(32), '1h', (req, res, next) => next());
  app.use('/api/auth', router);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); db.close(); });

test('login sin remember no pone cookie; con remember sí, HttpOnly + SameSite=Strict', async () => {
  const a = await login(false);
  assert.equal(a.status, 200); assert.equal(a.cookie, null);
  const b = await login(true);
  assert.match(b.setCookie, /HttpOnly/); assert.match(b.setCookie, /SameSite=Strict/); assert.match(b.setCookie, /Path=\/api\/auth/);
  assert.ok(b.cookie);
  // solo se guarda el hash, nunca el secreto
  const secret = b.cookie.split('.')[1];
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM trusted_devices').all()).includes(secret));
});

test('refresh: sin cookie → 401; con cookie → JWT nuevo y el secreto rota', async () => {
  assert.equal((await call('POST', '/api/auth/refresh')).status, 401);
  const c0 = (await login(true)).cookie;
  const r = await call('POST', '/api/auth/refresh', { cookie: c0 });
  assert.equal(r.status, 200); assert.ok(r.body.token); assert.equal(r.body.user.username, 'kiko');
  assert.notEqual(r.cookie, c0);
  assert.equal(r.cookie.split('.')[0], c0.split('.')[0]); // mismo dispositivo, secreto nuevo
});

test('reusar un secreto viejo fuera de la gracia → 401 y se revocan todos los dispositivos', async () => {
  const c0 = (await login(true)).cookie;
  const c1 = (await call('POST', '/api/auth/refresh', { cookie: c0 })).cookie;
  // dentro de la gracia: c0 aún vale y NO rota
  assert.equal((await call('POST', '/api/auth/refresh', { cookie: c0 })).status, 200);
  db.prepare("UPDATE trusted_devices SET rotated_at = datetime('now','-2 minutes')").run();
  const r = await call('POST', '/api/auth/refresh', { cookie: c0 });
  assert.equal(r.status, 401);
  assert.match(r.setCookie, /Max-Age=0/);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM trusted_devices').get().c, 0);
  assert.equal((await call('POST', '/api/auth/refresh', { cookie: c1 })).status, 401);
});

test('dispositivo caducado → 401', async () => {
  const c = (await login(true)).cookie;
  db.prepare("UPDATE trusted_devices SET expires_at = datetime('now','-1 day')").run();
  assert.equal((await call('POST', '/api/auth/refresh', { cookie: c })).status, 401);
});

test('cookie mal formada o secreto falso → 401', async () => {
  const c = (await login(true)).cookie;
  assert.equal((await call('POST', '/api/auth/refresh', { cookie: 'abc' })).status, 401);
  assert.equal((await call('POST', '/api/auth/refresh', { cookie: `${c.split('.')[0]}.${'A'.repeat(43)}` })).status, 401);
});

test('logout revoca y borra la cookie; lista y revocación por id', async () => {
  db.prepare('DELETE FROM trusted_devices').run();
  const l = await login(true);
  const jwtTok = l.body.token;
  const list = await call('GET', '/api/auth/devices', { bearer: jwtTok, cookie: l.cookie });
  assert.equal(list.body.length, 1); assert.equal(list.body[0].current, true);
  assert.ok(!('secret_hash' in list.body[0]));
  assert.equal((await call('DELETE', `/api/auth/devices/${list.body[0].id}`, { bearer: jwtTok })).status, 200);
  assert.equal((await call('DELETE', '/api/auth/devices/999', { bearer: jwtTok })).status, 404);
  const l2 = await login(true);
  const out = await call('POST', '/api/auth/logout', { cookie: l2.cookie });
  assert.match(out.setCookie, /Max-Age=0/);
  assert.equal((await call('POST', '/api/auth/refresh', { cookie: l2.cookie })).status, 401);
});

test('cambiar la contraseña revoca todos los dispositivos', async () => {
  const l = await login(true);
  const r = await call('POST', '/api/auth/password', { bearer: l.body.token, body: { oldPassword: PASSWORD, newPassword: 'otraclave123' } });
  assert.equal(r.status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM trusted_devices').get().c, 0);
});
