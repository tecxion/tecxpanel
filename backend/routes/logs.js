'use strict';

const express = require('express');
const { ok, fail, runSafe, wrap } = require('../lib/helpers');
const { LOG_FILES } = require('../lib/validators');
const { queries } = require('../database');

const router = express.Router();

router.get('/:type', wrap(async (req, res) => {
  const file = LOG_FILES[req.params.type];
  if (!file) return fail(res, 400, 'Tipo de log no permitido');
  const r = await runSafe('tail', ['-n', '300', file]);
  ok(res, { logs: r.stdout || r.stderr || 'Log no disponible' });
}));

router.get('/audit/list', (req, res) => {
  const rows = queries.getAuditLog.all();
  ok(res, rows);
});

module.exports = router;
