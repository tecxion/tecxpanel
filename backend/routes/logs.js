'use strict';

// ============================================================
//  TecXPaneL — Logs (registros)
//
//  Permite ver las últimas líneas de los logs del sistema/Nginx y
//  consultar el registro de auditoría del panel (quién hizo qué).
// ============================================================

const express = require('express');
const { ok, fail, runSafe, wrap } = require('../lib/helpers');
const { LOG_FILES } = require('../lib/validators');
const { queries } = require('../database');

const router = express.Router();

// GET /api/logs/:type — Muestra las últimas 300 líneas de un log.
// :type debe estar en LOG_FILES (lista blanca) para no leer ficheros arbitrarios.
router.get('/:type', wrap(async (req, res) => {
  const file = LOG_FILES[req.params.type];
  if (!file) return fail(res, 400, 'Tipo de log no permitido');
  const r = await runSafe('tail', ['-n', '300', file]); // "tail" = últimas N líneas
  ok(res, { logs: r.stdout || r.stderr || 'Log no disponible' });
}));

// GET /api/logs/audit/list — Devuelve el registro de auditoría (máx 500 entradas),
// que guarda cada acción importante hecha desde el panel.
router.get('/audit/list', (req, res) => {
  const rows = queries.getAuditLog.all();
  ok(res, rows);
});

module.exports = router;
