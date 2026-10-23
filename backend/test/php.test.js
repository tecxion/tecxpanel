'use strict';

const test = require('node:test');
const assert = require('node:assert');
const php = require('../lib/php');
const nginx = require('../lib/nginx');

test('parsePhpVersion extrae rama y parche', () => {
  assert.deepStrictEqual(php.parsePhpVersion('PHP 8.3.6 (fpm-fcgi) (built: x)'), { branch: '8.3', patch: 6, full: '8.3.6' });
  assert.strictEqual(php.parsePhpVersion('basura'), null);
});

test('isFixedUpstream respeta el parche mínimo por rama', () => {
  assert.strictEqual(php.isFixedUpstream('PHP 8.3.36'), true);
  assert.strictEqual(php.isFixedUpstream('PHP 8.3.35'), false);
  assert.strictEqual(php.isFixedUpstream('PHP 8.5.12'), true);
  assert.strictEqual(php.isFixedUpstream('PHP 7.4.33'), false); // rama sin parche por apt
});

test('hardeningIniPath solo admite ramas X.Y', () => {
  assert.ok(php.RE_BRANCH.test('8.3'));
  assert.ok(!php.RE_BRANCH.test('../../etc'));
});

test('vhost PHP: los guards van ANTES del location ~ .php$ y bloquean PHP en subidas', () => {
  for (const conf of [nginx.buildSite('x.com', 'php', 3000, { phpVersion: '8.3' }), nginx.buildPhpFpmSite(8081, '/r', '/s')]) {
    const guard = conf.indexOf('phtml|phar');
    const exec = conf.indexOf('location ~ \\.php$');
    assert.ok(guard > -1 && exec > guard, 'guard debe preceder a la ejecución PHP');
    assert.ok(conf.includes('wp-content/uploads'));
    assert.ok(conf.includes('(?!well-known)'));
  }
});

test('vhost html protege dotfiles pero no añade reglas PHP', () => {
  const conf = nginx.buildSite('x.com', 'html', 3000);
  assert.ok(conf.includes('(?!well-known)'));
  assert.ok(!conf.includes('fastcgi'));
});
