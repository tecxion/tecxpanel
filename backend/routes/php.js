'use strict';

// ============================================================
//  TecXPaneL — Seguridad PHP (php2shell)
//  GET  /api/php/status  → ramas instaladas, versión, parcheada, endurecida
//  POST /api/php/harden  → aplica mitigaciones en FPM
//  POST /api/php/patch   → apt --only-upgrade de PHP (streaming)
// ============================================================

const express = require('express');
const { ok, clientIp, wrap } = require('../lib/helpers');
const { streamStart, streamWrite, streamEnd } = require('../lib/common/streaming');
const engine = require('../lib/php/engine');
const { audit } = require('../database');

const router = express.Router();

router.get('/status', wrap(async (req, res) => ok(res, { branches: await engine.check() })));

router.post('/harden', wrap(async (req, res) => {
  const branches = await engine.harden();
  audit(req.user.username, clientIp(req), 'php.harden', branches.join(','));
  ok(res, { success: true, branches });
}));

router.post('/patch', wrap(async (req, res) => {
  audit(req.user.username, clientIp(req), 'php.patch', '');
  streamStart(res);
  const code = await engine.patch((l) => streamWrite(res, l));
  streamEnd(res, code);
}));

module.exports = router;
