// Tests de los helpers puros del despliegue Docker desde Git.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const {
  sanitizeRepoUrl, buildGitAuthEnv, isInsideBase, validatePort, parseVolumeBind,
} = require('../lib/dockerDeploy');

test('sanitizeRepoUrl: quita credenciales embebidas', () => {
  assert.strictEqual(sanitizeRepoUrl('https://user:tok@github.com/a/b.git'), 'https://github.com/a/b.git');
  assert.strictEqual(sanitizeRepoUrl('https://github.com/a/b.git'), 'https://github.com/a/b.git');
  assert.strictEqual(sanitizeRepoUrl(''), '');
});

test('buildGitAuthEnv: token simple => cabecera Basic con x-access-token', () => {
  const env = buildGitAuthEnv('ghp_ABC123', 'https://github.com/a/b.git');
  assert.strictEqual(env.GIT_CONFIG_COUNT, '1');
  assert.strictEqual(env.GIT_CONFIG_KEY_0, 'http.extraHeader');
  const decoded = Buffer.from(env.GIT_CONFIG_VALUE_0.replace('Authorization: Basic ', ''), 'base64').toString();
  assert.strictEqual(decoded, 'x-access-token:ghp_ABC123');
});

test('buildGitAuthEnv: token user:pass se respeta tal cual', () => {
  const env = buildGitAuthEnv('miuser:mipass', 'https://gitlab.com/a/b.git');
  const decoded = Buffer.from(env.GIT_CONFIG_VALUE_0.replace('Authorization: Basic ', ''), 'base64').toString();
  assert.strictEqual(decoded, 'miuser:mipass');
});

test('buildGitAuthEnv: sin token, URL ssh, o URL con @ => {}', () => {
  assert.deepStrictEqual(buildGitAuthEnv('', 'https://github.com/a/b.git'), {});
  assert.deepStrictEqual(buildGitAuthEnv('tok', 'git@github.com:a/b.git'), {});
  assert.deepStrictEqual(buildGitAuthEnv('tok', 'https://user:x@github.com/a/b.git'), {});
});

test('isInsideBase: permite subrutas, rechaza traversal', () => {
  const base = '/opt/txpl/data/docker-builds/miapp';
  assert.strictEqual(isInsideBase(base, path.join(base, 'backend')), true);
  assert.strictEqual(isInsideBase(base, base), true);
  assert.strictEqual(isInsideBase(base, path.join(base, '../../etc')), false);
  assert.strictEqual(isInsideBase(base, path.join(base, 'a/../../../root')), false);
});

test('validatePort: vacío => null; válido => int; inválido => ok:false', () => {
  assert.deepStrictEqual(validatePort(''), { ok: true, port: null });
  assert.deepStrictEqual(validatePort(undefined), { ok: true, port: null });
  assert.deepStrictEqual(validatePort('8080'), { ok: true, port: 8080 });
  assert.strictEqual(validatePort('abc').ok, false);
  assert.strictEqual(validatePort('0').ok, false);
  assert.strictEqual(validatePort('70000').ok, false);
});

test('parseVolumeBind: ambos, ninguno, o error', () => {
  assert.deepStrictEqual(parseVolumeBind('', ''), { ok: true, bind: null });
  assert.deepStrictEqual(parseVolumeBind('datos', '/var/lib/x'), { ok: true, bind: 'datos:/var/lib/x' });
  assert.strictEqual(parseVolumeBind('datos', '').ok, false);
  assert.strictEqual(parseVolumeBind('datos', 'relativa').ok, false);
  assert.strictEqual(parseVolumeBind('datos', '/x/../y').ok, false);
  assert.strictEqual(parseVolumeBind('nombre inválido', '/x').ok, false);
});

test('crypto: encriptar y desencriptar token de GitHub (AES-256-GCM)', () => {
  const { encryptText, decryptText } = require('../lib/crypto');
  const token = 'ghp_SampleGitHubPersonalAccessToken123456';
  const enc = encryptText(token);
  assert.notStrictEqual(enc, token);
  assert.strictEqual(typeof enc, 'string');
  assert.strictEqual(enc.split(':').length, 3);

  const dec = decryptText(enc);
  assert.strictEqual(dec, token);

  assert.strictEqual(decryptText(null), null);
  assert.strictEqual(decryptText('invalido'), null);
});

