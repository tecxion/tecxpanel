'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  generateToken, hashToken, isApiToken, isValidTokenName, expiresAt, isExpired, isAllowed,
  expiryDaysFor,
} = require('../lib/apitokens');

test('generateToken: prefijo, longitud y hash coherente', () => {
  const { token, hash } = generateToken();
  assert.ok(token.startsWith('txpl_') && token.length >= 48);
  assert.strictEqual(hash, hashToken(token));
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notStrictEqual(generateToken().token, token);
});

test('isApiToken: distingue token de API de un JWT', () => {
  assert.ok(isApiToken('txpl_abc'));
  assert.ok(!isApiToken('eyJhbGciOi.x.y'));
  assert.ok(!isApiToken(null));
});

test('isValidTokenName', () => {
  assert.ok(isValidTokenName('Claude Desktop'));
  assert.ok(!isValidTokenName(''));
  assert.ok(!isValidTokenName('a'.repeat(41)));
  assert.ok(!isValidTokenName('<script>'));
});

test('expiresAt / isExpired', () => {
  const now = new Date('2026-11-12T10:00:00Z');
  assert.strictEqual(expiresAt(30, now), '2026-12-12 10:00:00');
  assert.ok(!isExpired({ expires_at: '2026-12-12 10:00:00' }, now));
  assert.ok(isExpired({ expires_at: '2026-11-12 09:59:59' }, now));
});

test('isAllowed: lecturas permitidas', () => {
  for (const p of ['/api/system/stats', '/api/apps', '/api/apps/12/logs',
    '/api/docker/containers/txpl-n8n/logs', '/api/ssl/certificates', '/api/backups'])
    assert.ok(isAllowed('read', 'GET', p), p);
  assert.ok(isAllowed('write', 'GET', '/api/apps'));
});

test('isAllowed: GET con secretos y rutas no listadas, denegados', () => {
  for (const p of ['/api/apps/3/env', '/api/databases/1/password', '/api/databases/1/dump',
    '/api/databases/env/mysql-password', '/api/backups/4/download', '/api/files/list',
    '/api/docker/containers/abc/details', '/api/auth/tokens', '/api/auth/me', '/api/logs/audit/list'])
    assert.ok(!isAllowed('write', 'GET', p), p);
});

test('isAllowed: variantes con truco, denegadas', () => {
  for (const p of ['/api/apps/', '/API/apps', '/api/apps/../auth/me', '/api/apps/1/logs/', '/api/apps/x/logs'])
    assert.ok(!isAllowed('read', 'GET', p), p);
  assert.ok(!isAllowed('read', 'POST', '/api/apps'));
  assert.ok(!isAllowed('write', 'POST', '/api/apps/5/delete'));
  assert.ok(!isAllowed('otro', 'GET', '/api/apps'));
});

test('isAllowed: id de contenedor debe empezar por alfanumérico (sin . ni ..)', () => {
  assert.ok(!isAllowed('read', 'GET', '/api/docker/containers/../logs'));
  assert.ok(!isAllowed('read', 'GET', '/api/docker/containers/./stats'));
  assert.ok(isAllowed('read', 'GET', '/api/docker/containers/web.1_a-b/stats'));
});

test('isAllowed: write permite las 4 acciones de bajo riesgo y read no', () => {
  for (const p of ['/api/apps/5/restart', '/api/apps/5/reload', '/api/docker/containers/web.1/restart',
    '/api/backups', '/api/ssl/ejemplo.com/renew']) {
    assert.ok(isAllowed('write', 'POST', p), p);
    assert.ok(!isAllowed('read', 'POST', p), p);
  }
});

test('isAllowed: write deniega acciones destructivas o de ejecución', () => {
  for (const p of ['/api/apps/5/stop', '/api/apps/5/exec', '/api/docker/containers/x/stop',
    '/api/backups/3/restore', '/api/ssl/issue', '/api/system/exec'])
    assert.ok(!isAllowed('write', 'POST', p), p);
});

test('isAllowed: admin permite cualquier método fuera de /api/auth', () => {
  assert.ok(isAllowed('admin', 'POST', '/api/system/exec'));
  assert.ok(isAllowed('admin', 'DELETE', '/api/websites/3'));
  assert.ok(isAllowed('admin', 'DELETE', '/api/dns/zones/ejemplo.com/records'));
  assert.ok(isAllowed('admin', 'PUT', '/api/apps/2/env'));
  assert.ok(isAllowed('admin', 'GET', '/api/databases'));
});

test('isAllowed: admin nunca alcanza /api/auth ni rutas con truco', () => {
  for (const m of ['GET', 'POST', 'DELETE'])
    for (const p of ['/api/auth', '/api/auth/tokens', '/api/auth/tokens/4', '//api/auth/tokens',
      '/api/x/../auth/tokens', '/api/%61uth/tokens', '/API/auth/tokens', '/api/Auth/tokens', '/api/AUTH', '/api/auth./x',
      '/api/./auth/tokens', '/api/system/../x', '/apix', '/'])
      assert.ok(!isAllowed('admin', m, p), `${m} ${p}`);
});

test('expiryDaysFor: caducidades por ámbito', () => {
  assert.deepStrictEqual(expiryDaysFor('admin'), [7, 30]);
  assert.deepStrictEqual(expiryDaysFor('read'), [30, 90, 365]);
  assert.deepStrictEqual(expiryDaysFor('write'), [30, 90, 365]);
  assert.deepStrictEqual(expiryDaysFor('x'), []);
});
