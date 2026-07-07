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

test('constructores de argumentos de setup', () => {
  assert.deepStrictEqual(m.setupEmailAddArgs('u@d.com', 'pass'), ['setup', 'email', 'add', 'u@d.com', 'pass']);
  assert.deepStrictEqual(m.setupEmailDelArgs('u@d.com'), ['setup', 'email', 'del', '-y', 'u@d.com']);
  assert.deepStrictEqual(m.setupEmailUpdateArgs('u@d.com', 'p2'), ['setup', 'email', 'update', 'u@d.com', 'p2']);
  assert.deepStrictEqual(m.setupEmailListArgs(), ['setup', 'email', 'list']);
  assert.deepStrictEqual(m.setupAliasAddArgs('a@d.com', 'b@d.com'), ['setup', 'alias', 'add', 'a@d.com', 'b@d.com']);
  assert.deepStrictEqual(m.setupAliasDelArgs('a@d.com', 'b@d.com'), ['setup', 'alias', 'del', 'a@d.com', 'b@d.com']);
  assert.deepStrictEqual(m.setupDkimArgs('dominio.com'), ['setup', 'config', 'dkim', 'keysize', '2048', 'domain', 'dominio.com']);
});

test('parseEmailList extrae las direcciones', () => {
  const out = m.parseEmailList('* user@dominio.com ( 0 / ~ ) [0%]\n* admin@dominio.com ( 1M / ~ )\n');
  assert.deepStrictEqual(out, [{ address: 'user@dominio.com' }, { address: 'admin@dominio.com' }]);
});

test('parseEmailList tolera ruido y vacío', () => {
  assert.deepStrictEqual(m.parseEmailList(''), []);
  assert.deepStrictEqual(m.parseEmailList('No accounts\n'), []);
});

test('parseAliasList extrae origen y destino', () => {
  const out = m.parseAliasList('* info@dominio.com admin@dominio.com\n* ventas@dominio.com user@dominio.com\n');
  assert.deepStrictEqual(out, [
    { source: 'info@dominio.com', destination: 'admin@dominio.com' },
    { source: 'ventas@dominio.com', destination: 'user@dominio.com' },
  ]);
});

test('buildDnsRecords produce MX/SPF/DKIM/DMARC/PTR', () => {
  const recs = m.buildDnsRecords({ domain: 'dominio.com', hostname: 'mail.dominio.com', serverIp: '1.2.3.4', dkimPublic: 'v=DKIM1; k=rsa; p=ABC', dkimSelector: 'mail' });
  const mx = recs.find((r) => r.type === 'MX');
  assert.strictEqual(mx.value, 'mail.dominio.com'); assert.strictEqual(mx.priority, 10); assert.strictEqual(mx.name, 'dominio.com');
  const a = recs.find((r) => r.type === 'A');
  assert.strictEqual(a.name, 'mail.dominio.com'); assert.strictEqual(a.value, '1.2.3.4');
  const spf = recs.find((r) => r.type === 'TXT' && r.name === 'dominio.com');
  assert.strictEqual(spf.value, 'v=spf1 mx ~all');
  const dkim = recs.find((r) => r.name === 'mail._domainkey.dominio.com');
  assert.strictEqual(dkim.value, 'v=DKIM1; k=rsa; p=ABC');
  const dmarc = recs.find((r) => r.name === '_dmarc.dominio.com');
  assert.match(dmarc.value, /^v=DMARC1;/);
  const ptr = recs.find((r) => r.type === 'PTR');
  assert.strictEqual(ptr.name, '1.2.3.4'); assert.strictEqual(ptr.value, 'mail.dominio.com');
});

test('buildDnsRecords sin DKIM aún: el registro DKIM lleva nota y valor vacío', () => {
  const recs = m.buildDnsRecords({ domain: 'dominio.com', hostname: 'mail.dominio.com', serverIp: '1.2.3.4', dkimPublic: null, dkimSelector: 'mail' });
  const dkim = recs.find((r) => r.name === 'mail._domainkey.dominio.com');
  assert.strictEqual(dkim.value, '');
  assert.match(dkim.note || '', /DKIM/);
});
