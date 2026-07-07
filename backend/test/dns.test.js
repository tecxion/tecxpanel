const { test } = require('node:test');
const assert = require('node:assert');
const d = require('../lib/dns');

test('SUPPORTED_TYPES y canonical', () => {
  assert.deepStrictEqual(d.SUPPORTED_TYPES, ['A', 'AAAA', 'CNAME', 'MX', 'TXT']);
  assert.strictEqual(d.canonical('ejemplo.com'), 'ejemplo.com.');
  assert.strictEqual(d.canonical('ejemplo.com.'), 'ejemplo.com.');
  assert.strictEqual(d.canonical('www.ejemplo.com'), 'www.ejemplo.com.');
});

test('isValidDnsDomain', () => {
  for (const x of ['ejemplo.com', 'sub.ejemplo.io']) assert.strictEqual(d.isValidDnsDomain(x), true, x);
  for (const x of ['', 'x', 'ejemplo', '-mal.com', 'a b.com', 'a.com.', 42]) assert.strictEqual(d.isValidDnsDomain(x), false, JSON.stringify(x));
});

test('isValidIpv4 / isValidIpv6', () => {
  assert.strictEqual(d.isValidIpv4('1.2.3.4'), true);
  assert.strictEqual(d.isValidIpv4('999.1.1.1'), false);
  assert.strictEqual(d.isValidIpv4('::1'), false);
  assert.strictEqual(d.isValidIpv6('2001:db8::1'), true);
  assert.strictEqual(d.isValidIpv6('1.2.3.4'), false);
});

test('isValidRecord por tipo', () => {
  assert.strictEqual(d.isValidRecord('A', '1.2.3.4'), true);
  assert.strictEqual(d.isValidRecord('A', 'no-ip'), false);
  assert.strictEqual(d.isValidRecord('AAAA', '2001:db8::1'), true);
  assert.strictEqual(d.isValidRecord('AAAA', '1.2.3.4'), false);
  assert.strictEqual(d.isValidRecord('CNAME', 'destino.ejemplo.com'), true);
  assert.strictEqual(d.isValidRecord('CNAME', 'no dominio'), false);
  assert.strictEqual(d.isValidRecord('MX', 'mail.ejemplo.com'), true);
  assert.strictEqual(d.isValidRecord('TXT', 'v=spf1 mx ~all'), true);
  assert.strictEqual(d.isValidRecord('TXT', ''), false);
  assert.strictEqual(d.isValidRecord('TXT', 'con\nsalto'), false);
  assert.strictEqual(d.isValidRecord('OTRO', 'x'), false);
});

test('isValidPriority', () => {
  assert.strictEqual(d.isValidPriority(10), true);
  assert.strictEqual(d.isValidPriority(0), true);
  assert.strictEqual(d.isValidPriority(65535), true);
  assert.strictEqual(d.isValidPriority(-1), false);
  assert.strictEqual(d.isValidPriority(70000), false);
  assert.strictEqual(d.isValidPriority('10'), false);
});
