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
const { audit } = require('../database');
const { buildRuleArgs, parseUfwStatus, formatUfwError } = require('../lib/firewall');

const router = express.Router();

// GET /api/firewall — Lista el estado del firewall y sus reglas.
// Parsea la salida de "ufw status numbered" con una expresión regular para
// extraer: número de regla, destino, acción (ALLOW/DENY...) y origen.
router.get('/', wrap(async (req, res) => {
  const r = await runSafe('ufw', ['status', 'numbered']);
  if (!r.ok) return fail(res, 503, formatUfwError(r.stderr));
  const verbose = await runSafe('ufw', ['status', 'verbose']);
  const status = parseUfwStatus(r.stdout, verbose.ok ? verbose.stdout : '');
  ok(res, { ...status, available: true });
}));

router.post('/state', wrap(async (req, res) => {
  const action = String(req.body?.action || '').toLowerCase();
  if (!['enable', 'disable'].includes(action)) return fail(res, 400, 'Acción de estado inválida');
  const r = await runSafe('ufw', action === 'enable' ? ['--force', 'enable'] : ['disable']);
  if (!r.ok) return fail(res, 502, formatUfwError(r.stderr));
  audit(req.user.username, clientIp(req), `firewall.${action}`, null);
  ok(res, { output: r.stdout.trim() });
}));

router.post('/reload', wrap(async (req, res) => {
  const r = await runSafe('ufw', ['reload']);
  if (!r.ok) return fail(res, 502, formatUfwError(r.stderr));
  audit(req.user.username, clientIp(req), 'firewall.reload', null);
  ok(res, { output: r.stdout.trim() });
}));

router.post('/preview', wrap(async (req, res) => {
  const built = buildRuleArgs(req.body || {});
  if (!built.ok) return fail(res, 400, built.error);
  const r = await runSafe('ufw', ['--dry-run', ...built.args]);
  if (!r.ok) return fail(res, 422, formatUfwError(r.stderr));
  ok(res, { args: built.args, output: (r.stdout || r.stderr).trim() });
}));

// POST /api/firewall/rule — Añade una regla (permitir/denegar un puerto).
// Valida todo antes de tocar UFW: acción, puerto, protocolo y origen opcional.
router.post('/rule', wrap(async (req, res) => {
  const built = buildRuleArgs(req.body || {});
  if (!built.ok) return fail(res, 400, built.error);
  const r = await runSafe('ufw', built.args);
  if (!r.ok) return fail(res, 502, formatUfwError(r.stderr));
  audit(req.user.username, clientIp(req), 'firewall.add', built.args.join(' '));
  ok(res, { output: (r.stdout || r.stderr).trim() });
}));

// DELETE /api/firewall/rule/:num — Borra la regla número :num.
// UFW numera las reglas; aquí pasamos ese número para eliminarla.
router.delete('/rule/:num', wrap(async (req, res) => {
  const num = Number(req.params.num);
  if (!Number.isInteger(num) || num < 1) return fail(res, 400, 'Número de regla inválido');
  const r = await runSafe('ufw', ['--force', 'delete', String(num)]);
  if (!r.ok) return fail(res, 502, formatUfwError(r.stderr));
  audit(req.user.username, clientIp(req), 'firewall.delete', String(num));
  ok(res, { output: (r.stdout || r.stderr).trim() });
}));

module.exports = router;
