'use strict';

// ============================================================
//  TecXPaneL — Catálogo de aplicaciones (HTTP)
//
//  Lista el catálogo con su estado, instala en el modo elegido
//  (streaming con centinela __TXPL_DONE__), controla y desinstala.
//  JWT ya aplicado por el middleware global de /api.
// ============================================================

const express = require('express');
const { ok, fail, clientIp, wrap } = require('../lib/helpers');
const { CATALOG, getEntry, validateInstallOptions } = require('../lib/catalog');
const engine = require('../lib/catalogEngine');
const { audit } = require('../database');

const router = express.Router();

// Cabeceras + helpers de streaming (patrón plugins/n8n).
function startStream(res) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  return {
    write: (s) => res.write(s),
    done: (code) => res.end(`\n__TXPL_DONE__${code}`),
  };
}

// GET / — catálogo completo + estado de instalación de cada app.
router.get('/', wrap(async (req, res) => {
  const apps = [];
  for (const e of CATALOG) {
    const st = await engine.getInstallStatus(e.id);
    apps.push({
      id: e.id, name: e.name, description: e.description, icon: e.icon,
      modes: e.modes, db: e.db, ...st,
    });
  }
  ok(res, { apps });
}));

// POST /:id/install — body { mode, domain?, ssl? }. Respuesta en streaming.
router.post('/:id/install', wrap(async (req, res) => {
  const entry = getEntry(req.params.id);
  if (!entry) return fail(res, 404, 'App no encontrada en el catálogo.');
  const v = validateInstallOptions(entry, req.body || {});
  if (!v.ok) return fail(res, 400, v.error);

  audit(req.user.username, clientIp(req), 'catalog.install', `${entry.id} (${v.opts.mode})`);
  const { write, done } = startStream(res);
  write(`▶ Instalando ${entry.name} en modo ${v.opts.mode}...\n\n`);
  try {
    const code = await engine.installApp(entry.id, v.opts, write);
    return done(code);
  } catch (e) {
    write(`\n✖ ${e.message}\n`);
    return done(1);
  }
}));

// POST /:id/:action — start | stop | restart.
router.post('/:id/:action', wrap(async (req, res) => {
  const action = req.params.action;
  if (!['start', 'stop', 'restart'].includes(action)) return fail(res, 400, 'Acción no permitida.');
  await engine.controlApp(req.params.id, action);
  audit(req.user.username, clientIp(req), `catalog.${action}`, req.params.id);
  ok(res);
}));

// DELETE /:id — query purgeData=true|false & purgeDb=true|false. Streaming.
router.delete('/:id', wrap(async (req, res) => {
  const purgeData = req.query.purgeData === 'true';
  const purgeDb = req.query.purgeDb === 'true';
  audit(req.user.username, clientIp(req), 'catalog.uninstall',
    `${req.params.id}${purgeData ? ' +datos' : ''}${purgeDb ? ' +db' : ''}`);
  const { write, done } = startStream(res);
  try {
    const code = await engine.uninstallApp(req.params.id, { purgeData, purgeDb }, write);
    return done(code);
  } catch (e) {
    write(`\n✖ ${e.message}\n`);
    return done(1);
  }
}));

module.exports = router;
