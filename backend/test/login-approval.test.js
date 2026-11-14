'use strict';

// Test de integración: aprobación de logins por Telegram (Telegram simulado con un fetch falso).
const fs = require('fs');
const os = require('os');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'txpl-approval-'));
process.env.TXPL_DIR = TMP;
process.env.TXPL_DB = path.join(TMP, 'test.db');

const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../database');
const createAuthRouter = require('../routes/auth');
const loginApproval = require('../lib/loginApproval');

const PASSWORD = 'secreta123';
let server, base, jwtTok;
db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('kiko', ?, 'admin')").run(bcrypt.hashSync(PASSWORD, 4));
db.prepare("INSERT INTO notify_config (id, telegram_enabled, telegram_token_enc, telegram_chat_id) VALUES (1, 1, '123:ABC', '42')").run();

// fetch falso: las llamadas a api.telegram.org se registran (o fallan); lo demás va al servidor real.
const realFetch = global.fetch;
const sent = [];
let telegramDown = false;
global.fetch = (url, opts) => {
  if (String(url).startsWith('https://api.telegram.org/')) {
    if (telegramDown) return Promise.reject(new Error('sin red'));
    sent.push(JSON.parse(opts.body));
    return Promise.resolve({ ok: true, json: async () => ({ ok: true, result: { message_id: 7 } }) });
  }
  return realFetch(url, opts);
};

async function call(method, url, body, bearer) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const r = await realFetch(base + url, { method, headers, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null), setCookie: r.headers.get('set-cookie') || '' };
}
const login = (extra = {}) => call('POST', '/api/auth/login', { username: 'kiko', password: PASSWORD, ...extra });
const approveIdOf = (msg) => msg.reply_markup.inline_keyboard[0][0].callback_data.slice(3);

before(async () => {
  const app = express();
  app.use(express.json());
  const { router } = createAuthRouter('x'.repeat(32), '1h', (req, res, next) => next());
  app.use('/api/auth', router);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  jwtTok = (await login()).body.token; // interruptor apagado: entra directo
});
after(() => { global.fetch = realFetch; server.close(); db.close(); });

test('con el interruptor apagado el login no pide aprobación', async () => {
  const r = await login({ remember: true });
  assert.ok(r.body.token); assert.equal(sent.filter((m) => m.reply_markup).length, 0); // (el aviso de IP nueva no lleva botones)
});

test('activar exige contraseña correcta', async () => {
  assert.equal((await call('POST', '/api/auth/login-approval', { enabled: true, password: 'mala' }, jwtTok)).status, 403);
  assert.equal((await call('POST', '/api/auth/login-approval', { enabled: true, password: PASSWORD }, jwtTok)).status, 200);
  assert.deepEqual((await call('GET', '/api/auth/login-approval', null, jwtTok)).body, { enabled: true, telegram: true });
});

test('recordar dispositivo → pendiente, mensaje con botones y sin token ni cookie', async () => {
  const r = await login({ remember: true });
  assert.equal(r.body.pending, true); assert.ok(r.body.pollSecret); assert.ok(!r.body.token); assert.equal(r.setCookie, '');
  const msg = sent.at(-1);
  assert.equal(msg.chat_id, '42');
  assert.match(msg.reply_markup.inline_keyboard[0][0].callback_data, /^la:/);
  assert.match(msg.reply_markup.inline_keyboard[0][1].callback_data, /^ld:/);
  assert.ok(!JSON.stringify(msg).includes(r.body.pollSecret)); // el pollSecret nunca viaja por Telegram
});

test('aprobar → el poll entrega el token y la cookie de dispositivo, una sola vez', async () => {
  const r = await login({ remember: true });
  assert.equal((await call('POST', '/api/auth/login/poll', { pollSecret: r.body.pollSecret })).body.status, 'pending');
  assert.ok(loginApproval.decide(approveIdOf(sent.at(-1)), true));
  const p = await call('POST', '/api/auth/login/poll', { pollSecret: r.body.pollSecret });
  assert.equal(p.status, 200); assert.ok(p.body.token); assert.match(p.setCookie, /txpl_dev=\d+\./);
  assert.equal((await call('POST', '/api/auth/login/poll', { pollSecret: r.body.pollSecret })).status, 410);
});

test('denegar → 403 y sin token; aprobar dos veces no sirve', async () => {
  const r = await login({ remember: true });
  const id = approveIdOf(sent.at(-1));
  assert.ok(loginApproval.decide(id, false));
  assert.equal(loginApproval.decide(id, true), null);
  const p = await call('POST', '/api/auth/login/poll', { pollSecret: r.body.pollSecret });
  assert.equal(p.status, 403); assert.ok(!p.body.token);
});

test('caducado → 410; pollSecret inventado → 410; tipo raro → 400', async () => {
  const r = await login({ remember: true });
  const id = approveIdOf(sent.at(-1));
  await new Promise((res) => setTimeout(res, 5));
  // fuerza la caducidad por el único camino público: ID aprobado tras expirar no existe
  const realNow = Date.now;
  Date.now = () => realNow() + 200_000;
  assert.equal(loginApproval.decide(id, true), null);
  assert.equal((await call('POST', '/api/auth/login/poll', { pollSecret: r.body.pollSecret })).status, 410);
  assert.equal((await call('POST', '/api/auth/login/poll', { pollSecret: 'x'.repeat(22) })).status, 410);
  assert.equal((await call('POST', '/api/auth/login/poll', { pollSecret: { a: 1 } })).status, 400);
  Date.now = realNow;
});

test('Telegram caído al enviar → entra igualmente (fail-open) y queda auditado', async () => {
  telegramDown = true;
  const r = await login({ remember: true });
  telegramDown = false;
  assert.ok(r.body.token);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'login.approval.unavailable'").get());
});
