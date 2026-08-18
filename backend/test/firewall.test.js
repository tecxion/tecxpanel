'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const firewall = require('../lib/firewall');

test('parsePortSpec acepta puertos y rangos, pero no entradas ambiguas', () => {
  assert.deepStrictEqual(firewall.parsePortSpec('22'), { value: '22', start: 22, end: 22 });
  assert.deepStrictEqual(firewall.parsePortSpec('8000:8010'), { value: '8000:8010', start: 8000, end: 8010 });
  assert.strictEqual(firewall.parsePortSpec('22abc'), null);
  assert.strictEqual(firewall.parsePortSpec('9000:8000'), null);
  assert.strictEqual(firewall.parsePortSpec('0'), null);
});

test('buildRuleArgs usa arrays seguros y admite acciones UFW', () => {
  assert.deepStrictEqual(firewall.buildRuleArgs({ action: 'limit', port: '22', protocol: 'tcp' }), { ok: true, args: ['limit', '22/tcp'] });
  assert.deepStrictEqual(firewall.buildRuleArgs({ action: 'allow', port: '8000:8010', protocol: '', from: '2001:db8::/32' }), { ok: true, args: ['allow', 'from', '2001:db8::/32', 'to', 'any', 'port', '8000:8010'] });
  assert.strictEqual(firewall.buildRuleArgs({ action: 'exec', port: '22' }).ok, false);
  assert.strictEqual(firewall.buildRuleArgs({ action: 'allow', port: '22', from: 'not-an-ip' }).ok, false);
});

test('parseUfwStatus conserva reglas IPv4/IPv6, estado y políticas', () => {
  const status = [
    'Status: active',
    '',
    'To                         Action      From',
    '--                         ------      ----',
    '[ 1] 22/tcp                   LIMIT       IN    Anywhere',
    '[ 2] 80/tcp (v6)              ALLOW       IN    Anywhere (v6)',
  ].join('\n');
  const verbose = 'Logging: on (low)\nDefault: deny (incoming), allow (outgoing), disabled (routed)';
  const parsed = firewall.parseUfwStatus(status, verbose);
  assert.strictEqual(parsed.enabled, true);
  assert.strictEqual(parsed.rules.length, 2);
  assert.strictEqual(parsed.rules[0].action, 'LIMIT');
  assert.strictEqual(parsed.rules[1].from, 'Anywhere (v6)');
  assert.deepStrictEqual(parsed.defaults, { incoming: 'deny (incoming)', outgoing: 'allow (outgoing)', routed: 'disabled (routed)' });
  assert.strictEqual(parsed.logging, 'on (low)');
});
