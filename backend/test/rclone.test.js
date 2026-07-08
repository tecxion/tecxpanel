// backend/test/rclone.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const r = require('../lib/rclone');

test('constantes de nombres de remoto', () => {
  assert.strictEqual(r.RCLONE_REMOTE, 'txpl');
  assert.strictEqual(r.RCLONE_CRYPT, 'txplcrypt');
});

test('buildS3Env produce las variables RCLONE_CONFIG_TXPL_*', () => {
  const env = r.buildS3Env({ endpoint: 'https://s3.eu-west-1.amazonaws.com', region: 'eu-west-1', accessKey: 'AK', secretKey: 'SK' });
  assert.strictEqual(env.RCLONE_CONFIG_TXPL_TYPE, 's3');
  assert.strictEqual(env.RCLONE_CONFIG_TXPL_PROVIDER, 'Other');
  assert.strictEqual(env.RCLONE_CONFIG_TXPL_ENDPOINT, 'https://s3.eu-west-1.amazonaws.com');
  assert.strictEqual(env.RCLONE_CONFIG_TXPL_REGION, 'eu-west-1');
  assert.strictEqual(env.RCLONE_CONFIG_TXPL_ACCESS_KEY_ID, 'AK');
  assert.strictEqual(env.RCLONE_CONFIG_TXPL_SECRET_ACCESS_KEY, 'SK');
  assert.strictEqual(env.RCLONE_CONFIG_TXPL_ENV_AUTH, 'false');
});

test('buildSftpEnv con password', () => {
  const env = r.buildSftpEnv({ host: 'a.b.com', port: 22, user: 'u', password: 'p' });
  assert.strictEqual(env.RCLONE_CONFIG_TXPL_TYPE, 'sftp');
  assert.strictEqual(env.RCLONE_CONFIG_TXPL_HOST, 'a.b.com');
  assert.strictEqual(env.RCLONE_CONFIG_TXPL_PORT, '22');
  assert.strictEqual(env.RCLONE_CONFIG_TXPL_USER, 'u');
  assert.strictEqual(env.RCLONE_CONFIG_TXPL_PASS, 'p');
  assert.strictEqual(env.RCLONE_CONFIG_TXPL_KEY_FILE, undefined);
});

test('buildSftpEnv con keyFile (prioriza clave sobre password)', () => {
  const env = r.buildSftpEnv({ host: 'a.b.com', port: 2222, user: 'u', keyFile: '/tmp/k' });
  assert.strictEqual(env.RCLONE_CONFIG_TXPL_KEY_FILE, '/tmp/k');
  assert.strictEqual(env.RCLONE_CONFIG_TXPL_PASS, undefined);
  assert.strictEqual(env.RCLONE_CONFIG_TXPL_PORT, '2222');
});

test('effectiveRemote', () => {
  assert.strictEqual(r.effectiveRemote(true, 'ruta/x'), 'txplcrypt:');
  assert.strictEqual(r.effectiveRemote(false, 'ruta/x'), 'txpl:ruta/x');
  assert.strictEqual(r.effectiveRemote(false, ''), 'txpl:');
});

test('buildCryptEnv monta txplcrypt sobre txpl:<remotePath>', () => {
  const env = r.buildCryptEnv({ passphraseObscured: 'OBSC', remotePath: 'mi-bucket/dir' });
  assert.strictEqual(env.RCLONE_CONFIG_TXPLCRYPT_TYPE, 'crypt');
  assert.strictEqual(env.RCLONE_CONFIG_TXPLCRYPT_REMOTE, 'txpl:mi-bucket/dir');
  assert.strictEqual(env.RCLONE_CONFIG_TXPLCRYPT_FILENAME_ENCRYPTION, 'standard');
  assert.strictEqual(env.RCLONE_CONFIG_TXPLCRYPT_PASSWORD, 'OBSC');
});

test('copyArgs / lsjsonArgs / deleteArgs / checkRemoteArgs / obscureArgs', () => {
  assert.deepStrictEqual(r.copyArgs('/tmp/a.tar.gz', 'txpl:x'), ['copy', '/tmp/a.tar.gz', 'txpl:x', '--s3-no-check-bucket']);
  assert.deepStrictEqual(r.lsjsonArgs('txpl:x'), ['lsjson', 'txpl:x']);
  assert.deepStrictEqual(r.deleteArgs('txpl:x/a.tar.gz'), ['deletefile', 'txpl:x/a.tar.gz']);
  assert.deepStrictEqual(r.checkRemoteArgs('txpl:x'), ['lsd', 'txpl:x']);
  assert.deepStrictEqual(r.obscureArgs('secreta'), ['obscure', 'secreta']);
});

test('parseLsjson extrae name/size/modTime', () => {
  const j = JSON.stringify([
    { Name: 'backup-a.tar.gz', Size: 1024, ModTime: '2026-07-01T00:00:00Z', IsDir: false },
    { Name: 'sub', Size: -1, ModTime: '2026-07-02T00:00:00Z', IsDir: true },
  ]);
  const out = r.parseLsjson(j);
  assert.deepStrictEqual(out, [{ name: 'backup-a.tar.gz', size: 1024, modTime: '2026-07-01T00:00:00Z' }]);
});

test('parseLsjson tolera basura y vacío', () => {
  assert.deepStrictEqual(r.parseLsjson(''), []);
  assert.deepStrictEqual(r.parseLsjson('no-json'), []);
  assert.deepStrictEqual(r.parseLsjson('[]'), []);
});
