// backend/test/mail.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const m = require('../lib/mail');

test('constantes y puertos', () => {
  assert.strictEqual(m.MAIL_CONTAINER, 'txpl-mail');
  assert.strictEqual(m.MAIL_IMAGE, 'ghcr.io/docker-mailserver/docker-mailserver');
  assert.strictEqual(m.MAIL_TAG, 'latest');
  assert.deepStrictEqual(m.MAIL_PORTS, [25, 465, 587, 143, 993]);
});

test('isValidEmail', () => {
  for (const a of ['user@example.com', 'a.b-c@sub.dominio.io']) assert.strictEqual(m.isValidEmail(a), true, a);
  for (const a of ['', 'nope', 'a@b', 'a b@c.com', 'x@y.com\n', 42, 'a@@b.com']) assert.strictEqual(m.isValidEmail(a), false, JSON.stringify(a));
});

test('isValidMailDomain', () => {
  for (const d of ['example.com', 'mail.sub.dominio.io']) assert.strictEqual(m.isValidMailDomain(d), true, d);
  for (const d of ['', 'no dominio', 'x', '-bad.com', 'a.b\n', 42]) assert.strictEqual(m.isValidMailDomain(d), false, JSON.stringify(d));
});

test('isValidMailPassword', () => {
  assert.strictEqual(m.isValidMailPassword('secreta123'), true);
  for (const p of ['', 'corta', 'con espacio', 'salto\nlinea', 42]) assert.strictEqual(m.isValidMailPassword(p), false, JSON.stringify(p));
});

test('buildMailContainerConfig: imagen, hostname, puertos, volúmenes y SSL', () => {
  const c = m.buildMailContainerConfig({ hostname: 'mail.dominio.com', letsencryptDir: '/etc/letsencrypt' });
  assert.strictEqual(c.Image, 'ghcr.io/docker-mailserver/docker-mailserver:latest');
  assert.strictEqual(c.Hostname, 'mail.dominio.com');
  assert.ok(c.Env.includes('SSL_TYPE=letsencrypt'));
  assert.deepStrictEqual(c.HostConfig.RestartPolicy, { Name: 'unless-stopped' });
  for (const p of ['25/tcp', '465/tcp', '587/tcp', '143/tcp', '993/tcp']) {
    assert.ok(c.ExposedPorts[p], `expuesto ${p}`);
    assert.deepStrictEqual(c.HostConfig.PortBindings[p], [{ HostPort: p.split('/')[0] }]);
  }
  assert.ok(c.HostConfig.Binds.includes('/etc/letsencrypt:/etc/letsencrypt:ro'));
  assert.ok(c.HostConfig.Binds.some((b) => b.endsWith(':/var/mail')));
  assert.ok(c.HostConfig.Binds.some((b) => b.endsWith(':/tmp/docker-mailserver')));
});

test('buildMailContainerConfig: letsencryptDir por defecto', () => {
  const c = m.buildMailContainerConfig({ hostname: 'mail.x.com' });
  assert.ok(c.HostConfig.Binds.includes('/etc/letsencrypt:/etc/letsencrypt:ro'));
});
