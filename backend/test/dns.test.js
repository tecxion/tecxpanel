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

test('buildRecordContent por tipo', () => {
  assert.strictEqual(d.buildRecordContent('A', '1.2.3.4'), '1.2.3.4');
  assert.strictEqual(d.buildRecordContent('AAAA', '2001:db8::1'), '2001:db8::1');
  assert.strictEqual(d.buildRecordContent('CNAME', 'destino.ejemplo.com'), 'destino.ejemplo.com.');
  assert.strictEqual(d.buildRecordContent('MX', 'mail.ejemplo.com', 10), '10 mail.ejemplo.com.');
  assert.strictEqual(d.buildRecordContent('TXT', 'v=spf1 mx ~all'), '"v=spf1 mx ~all"');
  assert.strictEqual(d.buildRecordContent('TXT', '"ya-con-comillas"'), '"ya-con-comillas"');
});

test('buildZonePayload', () => {
  const p = d.buildZonePayload({ domain: 'ejemplo.com', ns1: 'ns1.mio.com', ns2: 'ns2.mio.com' });
  assert.strictEqual(p.name, 'ejemplo.com.');
  assert.strictEqual(p.kind, 'Native');
  assert.deepStrictEqual(p.nameservers, ['ns1.mio.com.', 'ns2.mio.com.']);
});

test('buildRrsetPatch REPLACE y DELETE', () => {
  const rep = d.buildRrsetPatch({ name: 'www.ejemplo.com', type: 'A', contents: ['1.2.3.4'], ttl: 3600, changetype: 'REPLACE' });
  assert.deepStrictEqual(rep, { rrsets: [{ name: 'www.ejemplo.com.', type: 'A', ttl: 3600, changetype: 'REPLACE', records: [{ content: '1.2.3.4', disabled: false }] }] });
  const del = d.buildRrsetPatch({ name: 'www.ejemplo.com', type: 'A', contents: [], ttl: 3600, changetype: 'DELETE' });
  assert.strictEqual(del.rrsets[0].changetype, 'DELETE');
  assert.deepStrictEqual(del.rrsets[0].records, []);
});

test('buildGlueRecords', () => {
  const g = d.buildGlueRecords({ ns1: 'ns1.mio.com', ns2: 'ns2.mio.com', serverIp: '1.2.3.4' });
  assert.deepStrictEqual(g, [
    { type: 'A', name: 'ns1.mio.com', value: '1.2.3.4' },
    { type: 'A', name: 'ns2.mio.com', value: '1.2.3.4' },
  ]);
});

test('parseZones', () => {
  const out = d.parseZones([{ id: 'ejemplo.com.', name: 'ejemplo.com.', kind: 'Native' }, { name: 'otro.io.' }]);
  assert.deepStrictEqual(out, [{ name: 'ejemplo.com' }, { name: 'otro.io' }]);
});

test('parseRecords aplana rrsets', () => {
  const zoneJson = { rrsets: [
    { name: 'ejemplo.com.', type: 'A', ttl: 3600, records: [{ content: '1.2.3.4', disabled: false }] },
    { name: 'ejemplo.com.', type: 'MX', ttl: 3600, records: [{ content: '10 mail.ejemplo.com.', disabled: false }] },
  ] };
  const out = d.parseRecords(zoneJson);
  assert.deepStrictEqual(out, [
    { name: 'ejemplo.com', type: 'A', ttl: 3600, content: '1.2.3.4' },
    { name: 'ejemplo.com', type: 'MX', ttl: 3600, content: '10 mail.ejemplo.com.' },
  ]);
});
