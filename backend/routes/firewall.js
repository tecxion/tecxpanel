'use strict';

const express = require('express');
const { ok, fail, clientIp, runSafe, wrap } = require('../lib/helpers');
const { isPort } = require('../lib/validators');
const { RE_IP_CIDR } = require('../lib/validators');
const { audit } = require('../database');

const router = express.Router();

router.get('/', wrap(async (req, res) => {
  const r = await runSafe('ufw', ['status', 'numbered']);
  const enabled = /Status:\s*active/i.test(r.stdout);
  const rules = [];
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^\[\s*(\d+)\]\s+(.+?)\s{2,}(ALLOW|DENY|REJECT|LIMIT)\s+(?:IN\s+)?(.*)$/i);
    if (m) rules.push({ num: +m[1], to: m[2].trim(), action: m[3].toUpperCase(), from: m[4].trim() });
  }
  ok(res, { enabled, rules });
}));

router.post('/rule', wrap(async (req, res) => {
  const { action = 'allow', port, protocol = 'tcp', from } = req.body || {};
  if (!['allow', 'deny'].includes(action)) return fail(res, 400, 'Acción inválida');
  const portNum = parseInt(port, 10);
  if (!isPort(portNum)) return fail(res, 400, 'Puerto inválido');
  if (protocol && !['tcp', 'udp', ''].includes(protocol)) return fail(res, 400, 'Protocolo inválido');
  if (from && !RE_IP_CIDR.test(from)) return fail(res, 400, 'IP/CIDR de origen inválida');

  let args;
  const portSpec = protocol ? `${portNum}/${protocol}` : String(portNum);
  if (from) args = [action, 'from', from, 'to', 'any', 'port', String(portNum), ...(protocol ? ['proto', protocol] : [])];
  else args = [action, portSpec];

  const r = await runSafe('ufw', args);
  if (!r.ok) return fail(res, 500, r.stderr.split('\n')[0] || 'Error de UFW');
  audit(req.user.username, clientIp(req), 'firewall.add', args.join(' '));
  ok(res);
}));

router.delete('/rule/:num', wrap(async (req, res) => {
  const num = parseInt(req.params.num, 10);
  if (!Number.isInteger(num) || num < 1) return fail(res, 400, 'Número de regla inválido');
  const r = await runSafe('ufw', ['--force', 'delete', String(num)]);
  if (!r.ok) return fail(res, 500, r.stderr.split('\n')[0] || 'Error de UFW');
  audit(req.user.username, clientIp(req), 'firewall.delete', String(num));
  ok(res);
}));

module.exports = router;
