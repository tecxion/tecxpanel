'use strict';

// Test de integración: passkeys (WebAuthn) con un autenticador software (ES256, attestation "none").
const fs = require('fs');
const os = require('os');
const path = require('path');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'txpl-passkeys-'));
process.env.TXPL_DIR = TMP;
process.env.TXPL_DB = path.join(TMP, 'test.db');
const ORIGIN = 'https://panel.test';
process.env.TXPL_ORIGIN = ORIGIN;

const test = require('node:test');
const { before, after } = test;
const assert = require('node:assert/strict');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../database');
const createAuthRouter = require('../routes/auth');

const PASSWORD = 'secreta123';
let server, base, jwtTok;
db.prepare("INSERT INTO users (username, password_hash, role) VALUES ('kiko', ?, 'admin')").run(bcrypt.hashSync(PASSWORD, 4));

// ── Autenticador software ─────────────────────────────────────
const sha = (b) => crypto.createHash('sha256').update(b).digest();
const b64u = (b) => Buffer.from(b).toString('base64url');
// CBOR mínimo: enteros, bytes, texto y mapas (lo justo para attestationObject y la clave COSE).
function cbor(v) {
  const head = (major, n) => (n < 24 ? Buffer.from([major << 5 | n]) : Buffer.from([major << 5 | 24, n]));
  if (Buffer.isBuffer(v)) return Buffer.concat([n2(2, v.length), v]);
  if (typeof v === 'string') return Buffer.concat([n2(3, Buffer.byteLength(v)), Buffer.from(v)]);
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  const entries = Object.entries(v);
  return Buffer.concat([n2(5, entries.length), ...entries.flatMap(([k, x]) => [cbor(/^-?\d+$/.test(k) ? Number(k) : k), cbor(x)])]);
  function n2(major, n) { return n < 24 ? head(major, n) : n < 256 ? Buffer.from([major << 5 | 24, n]) : Buffer.from([major << 5 | 25, n >> 8, n & 255]); }
}
function newAuthenticator() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credId = crypto.randomBytes(16);
  const cose = cbor({ 1: 2, 3: -7, '-1': 1, '-2': Buffer.from(jwk.x, 'base64url'), '-3': Buffer.from(jwk.y, 'base64url') });
  const rpHash = sha(new URL(ORIGIN).hostname);
  const clientData = (type, challenge) => Buffer.from(JSON.stringify({ type, challenge, origin: ORIGIN, crossOrigin: false }));
  return {
    id: b64u(credId),
    register(challenge) {
      const authData = Buffer.concat([rpHash, Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), Buffer.from([0, credId.length]), credId, cose]);
      return { id: b64u(credId), rawId: b64u(credId), type: 'public-key', clientExtensionResults: {}, response: {
        clientDataJSON: b64u(clientData('webauthn.create', challenge)),
        attestationObject: b64u(cbor({ fmt: 'none', attStmt: {}, authData })), transports: ['internal'] } };
    },
    assert(challenge, counter = 1, key = privateKey) {
      const authData = Buffer.concat([rpHash, Buffer.from([0x05]), Buffer.from([0, 0, 0, counter])]);
      const cd = clientData('webauthn.get', challenge);
      const signature = crypto.sign('sha256', Buffer.concat([authData, sha(cd)]), key);
      return { id: b64u(credId), rawId: b64u(credId), type: 'public-key', clientExtensionResults: {}, response: {
        clientDataJSON: b64u(cd), authenticatorData: b64u(authData), signature: b64u(signature), userHandle: b64u('1') } };
    },
  };
}

async function call(method, url, body, bearer) {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const r = await fetch(base + url, { method, headers, body: body && JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null), setCookie: r.headers.get('set-cookie') || '' };
}
async function registerPasskey(auth) {
  const o = await call('POST', '/api/auth/passkeys/options', { password: PASSWORD }, jwtTok);
  return call('POST', '/api/auth/passkeys/verify', { challengeId: o.body.challengeId, response: auth.register(o.body.options.challenge), name: 'Mi móvil' }, jwtTok);
}
async function passkeyLogin(auth, extra = {}, counter = 1, key) {
  const o = await call('POST', '/api/auth/passkey/login/options');
  return call('POST', '/api/auth/passkey/login/verify', { challengeId: o.body.challengeId, response: auth.assert(o.body.options.challenge, counter, key), ...extra });
}

before(async () => {
  const app = express();
  app.use(express.json());
  const { router } = createAuthRouter('x'.repeat(32), '1h', (req, res, next) => next());
  app.use('/api/auth', router);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  jwtTok = (await call('POST', '/api/auth/login', { username: 'kiko', password: PASSWORD })).body.token;
});
after(() => { server.close(); db.close(); });

const authn = newAuthenticator();

test('alta de passkey: contraseña mala → 403; buena → registrada, sin exponer credential_id', async () => {
  assert.equal((await call('POST', '/api/auth/passkeys/options', { password: 'mala' }, jwtTok)).status, 403);
  assert.equal((await registerPasskey(authn)).status, 200);
  const list = await call('GET', '/api/auth/passkeys', null, jwtTok);
  assert.equal(list.body.length, 1); assert.equal(list.body[0].name, 'Mi móvil');
  assert.ok(!JSON.stringify(list.body).includes(authn.id));
});

test('login con passkey: devuelve token sin contraseña; el contador se actualiza', async () => {
  const r = await passkeyLogin(authn, {}, 5);
  assert.equal(r.status, 200); assert.ok(r.body.token); assert.equal(r.body.user.username, 'kiko');
  assert.equal(db.prepare('SELECT counter FROM webauthn_credentials').get().counter, 5);
});

test('login con passkey + remember → cookie de dispositivo', async () => {
  const r = await passkeyLogin(authn, { remember: true }, 6);
  assert.match(r.setCookie, /txpl_dev=\d+\./);
});

test('reto de un solo uso: repetir la misma respuesta → 401', async () => {
  const o = await call('POST', '/api/auth/passkey/login/options');
  const body = { challengeId: o.body.challengeId, response: authn.assert(o.body.options.challenge, 7) };
  assert.equal((await call('POST', '/api/auth/passkey/login/verify', body)).status, 200);
  assert.equal((await call('POST', '/api/auth/passkey/login/verify', body)).status, 401);
});

test('firma con otra clave, credencial desconocida o reto ajeno → 401', async () => {
  const otra = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
  assert.equal((await passkeyLogin(authn, {}, 8, otra)).status, 401);
  assert.equal((await passkeyLogin(newAuthenticator())).status, 401);
  const o = await call('POST', '/api/auth/passkey/login/options');
  assert.equal((await call('POST', '/api/auth/passkey/login/verify', { challengeId: 'inventado', response: authn.assert(o.body.options.challenge) })).status, 401);
  assert.equal((await call('POST', '/api/auth/passkey/login/verify', { challengeId: o.body.challengeId, response: { id: { x: 1 } } })).status, 401);
});

test('un reto de login no vale para registrar (tipos distintos)', async () => {
  const o = await call('POST', '/api/auth/passkey/login/options');
  const a2 = newAuthenticator();
  const r = await call('POST', '/api/auth/passkeys/verify', { challengeId: o.body.challengeId, response: a2.register(o.body.options.challenge) }, jwtTok);
  assert.equal(r.status, 400);
});

test('baja: exige contraseña; después la passkey ya no entra', async () => {
  const id = (await call('GET', '/api/auth/passkeys', null, jwtTok)).body[0].id;
  assert.equal((await call('DELETE', `/api/auth/passkeys/${id}`, { password: 'mala' }, jwtTok)).status, 403);
  assert.equal((await call('DELETE', `/api/auth/passkeys/${id}`, { password: PASSWORD }, jwtTok)).status, 200);
  assert.notEqual((await passkeyLogin(authn, {}, 9)).status, 200); // 401, o 429 si el bloqueo por intentos ya saltó
});
