'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const d = require('../lib/mail/diagnose');

test('classifyPort25: abierto=ok, bloqueado=error', () => {
  assert.strictEqual(d.classifyPort25(true).level, 'ok');
  const bad = d.classifyPort25(false);
  assert.strictEqual(bad.level, 'error');
  assert.match(bad.fix, /relay/i);
});

test('classifyDnsA: sin A=error, otra IP=warn, coincide=ok', () => {
  assert.strictEqual(d.classifyDnsA([], '1.2.3.4').level, 'error');
  assert.strictEqual(d.classifyDnsA(['5.6.7.8'], '1.2.3.4').level, 'warn');
  assert.strictEqual(d.classifyDnsA(['1.2.3.4'], '1.2.3.4').level, 'ok');
  // Sin serverIp conocido, cualquier A resuelto se acepta.
  assert.strictEqual(d.classifyDnsA(['9.9.9.9'], '').level, 'ok');
});

test('classifyPtr: sin PTR=warn, no coincide=warn, coincide=ok (normaliza)', () => {
  assert.strictEqual(d.classifyPtr([], 'mail.x.com').level, 'warn');
  assert.strictEqual(d.classifyPtr(['otro.host'], 'mail.x.com').level, 'warn');
  assert.strictEqual(d.classifyPtr(['MAIL.X.COM.'], 'mail.x.com').level, 'ok');
});

test('classifyMx: sin MX=error, otro host=warn, coincide=ok (normaliza punto/mayúsculas)', () => {
  assert.strictEqual(d.classifyMx([], 'mail.x.com').level, 'error');
  assert.strictEqual(d.classifyMx(['aspmx.l.google.com'], 'mail.x.com').level, 'warn');
  assert.strictEqual(d.classifyMx(['MAIL.X.COM.'], 'mail.x.com').level, 'ok');
});

test('classifySpf: detecta v=spf1', () => {
  assert.strictEqual(d.classifySpf(['v=spf1 mx ~all']).level, 'ok');
  assert.strictEqual(d.classifySpf(['algo sin relación']).level, 'warn');
  assert.strictEqual(d.classifySpf([]).level, 'warn');
});

test('classifyDkim: detecta v=DKIM1 o p= (incluido TXT troceado)', () => {
  assert.strictEqual(d.classifyDkim([['v=DKIM1; k=rsa; ', 'p=MIGfMA0...']]).level, 'ok');
  assert.strictEqual(d.classifyDkim(['p=MIGfMA0GCSq...']).level, 'ok');
  assert.strictEqual(d.classifyDkim([]).level, 'warn');
});

test('classifyDmarc: detecta v=DMARC1', () => {
  assert.strictEqual(d.classifyDmarc(['v=DMARC1; p=none']).level, 'ok');
  assert.strictEqual(d.classifyDmarc([]).level, 'warn');
});

test('classifyDnsbl: alguna lista=error, ninguna=ok', () => {
  assert.strictEqual(d.classifyDnsbl([{ list: 'zen', listed: false }]).level, 'ok');
  assert.strictEqual(d.classifyDnsbl([{ list: 'zen', listed: true }, { list: 'spamcop', listed: false }]).level, 'error');
  assert.strictEqual(d.classifyDnsbl([]).level, 'ok');
});

test('overallLevel: devuelve el peor', () => {
  assert.strictEqual(d.overallLevel([{ level: 'ok' }, { level: 'warn' }, { level: 'ok' }]), 'warn');
  assert.strictEqual(d.overallLevel([{ level: 'ok' }, { level: 'error' }, { level: 'warn' }]), 'error');
  assert.strictEqual(d.overallLevel([{ level: 'ok' }, { level: 'ok' }]), 'ok');
  assert.strictEqual(d.overallLevel([]), 'ok');
});

test('dnsblQuery: invierte la IPv4 y añade la lista', () => {
  assert.strictEqual(d.dnsblQuery('1.2.3.4', 'zen.spamhaus.org'), '4.3.2.1.zen.spamhaus.org');
});

test('dnsblListed: 127.0.0.x = listada; 127.255.255.x = error (no listada)', () => {
  assert.strictEqual(d.dnsblListed(['127.0.0.2']), true);   // SBL
  assert.strictEqual(d.dnsblListed(['127.0.0.11']), true);  // PBL
  assert.strictEqual(d.dnsblListed(['127.255.255.254']), false); // consulta desde resolver público
  assert.strictEqual(d.dnsblListed(['127.255.255.252']), false);
  assert.strictEqual(d.dnsblListed([]), false);
});

test('joinTxt: une registros troceados y respeta los ya completos', () => {
  assert.deepStrictEqual(d.joinTxt([['ab', 'cd'], 'ef']), ['abcd', 'ef']);
  assert.deepStrictEqual(d.joinTxt([]), []);
});
