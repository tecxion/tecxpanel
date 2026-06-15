'use strict';

// ============================================================
//  TecXPaneL — Cortafuegos (UFW)
//
//  Gestiona las reglas del firewall UFW (Uncomplicated FireWall),
//  el cortafuegos estándar de Ubuntu. Permite ver, añadir y borrar
//  reglas que abren o cierran puertos.
// ============================================================

const express = require('express');
const { ok, fail, clientIp, runSafe, wrap } = require('../lib/helpers');
const { isPort } = require('../lib/validators');
const { RE_IP_CIDR } = require('../lib/validators');
const { audit } = require('../database');

const router = express.Router();

// GET /api/firewall — Lista el estado del firewall y sus reglas.
// Parsea la salida de "ufw status numbered" con una expresión regular para
// extraer: número de regla, destino, acción (ALLOW/DENY...) y origen.
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

// POST /api/firewall/rule — Añade una regla (permitir/denegar un puerto).
// Valida todo antes de tocar UFW: acción, puerto, protocolo y origen opcional.
router.post('/rule', wrap(async (req, res) => {
  const { action = 'allow', port, protocol = 'tcp', from } = req.body || {};
  if (!['allow', 'deny'].includes(action)) return fail(res, 400, 'Acción inválida');
  const portNum = parseInt(port, 10);
  if (!isPort(portNum)) return fail(res, 400, 'Puerto inválido');
  if (protocol && !['tcp', 'udp', ''].includes(protocol)) return fail(res, 400, 'Protocolo inválido');
  if (from && !RE_IP_CIDR.test(from)) return fail(res, 400, 'IP/CIDR de origen inválida');

  // Montamos los argumentos de UFW. Si hay "from", la regla limita el origen.
  let args;
  const portSpec = protocol ? `${portNum}/${protocol}` : String(portNum);
  if (from) args = [action, 'from', from, 'to', 'any', 'port', String(portNum), ...(protocol ? ['proto', protocol] : [])];
  else args = [action, portSpec];

  const r = await runSafe('ufw', args);
  if (!r.ok) return fail(res, 500, r.stderr.split('\n')[0] || 'Error de UFW');
  audit(req.user.username, clientIp(req), 'firewall.add', args.join(' '));
  ok(res);
}));

// DELETE /api/firewall/rule/:num — Borra la regla número :num.
// UFW numera las reglas; aquí pasamos ese número para eliminarla.
router.delete('/rule/:num', wrap(async (req, res) => {
  const num = parseInt(req.params.num, 10);
  if (!Number.isInteger(num) || num < 1) return fail(res, 400, 'Número de regla inválido');
  const r = await runSafe('ufw', ['--force', 'delete', String(num)]);
  if (!r.ok) return fail(res, 500, r.stderr.split('\n')[0] || 'Error de UFW');
  audit(req.user.username, clientIp(req), 'firewall.delete', String(num));
  ok(res);
}));

module.exports = router;
