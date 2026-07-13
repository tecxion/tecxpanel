'use strict';

// ============================================================
//  TecXPaneL — Logs (registros)
//
//  Permite ver las últimas líneas de los logs del sistema/Nginx,
//  el log propio de cada sitio web (access/error por dominio),
//  y consultar el registro de auditoría del panel. Los logs de
//  apps PM2 se sirven desde /api/apps/:id/logs (ya existente).
// ============================================================

const fs = require('fs');
const express = require('express');
const { ok, fail, runSafe, wrap } = require('../lib/helpers');
const { LOG_FILES } = require('../lib/validators');
const { siteLogPath, clampLines } = require('../lib/logs');
const { queries } = require('../database');

const router = express.Router();

// GET /api/logs/sources — Fuentes disponibles para la página de logs:
// logs estáticos (lista blanca), apps PM2 y sitios web del panel.
// Definida ANTES de /:type para que "sources" no caiga en la ruta genérica.
router.get('/sources', wrap(async (req, res) => {
  const apps = queries.listApps.all().map((a) => ({ id: a.id, name: a.name, status: a.status }));
  const sites = queries.listWebsites.all().map((w) => ({
    domain: w.domain,
    // ¿Tiene ya log propio? (vhosts creados con la versión nueva)
    hasOwnLog: fs.existsSync(`/var/log/nginx/${w.domain}.access.log`)
            || fs.existsSync(`/var/log/nginx/${w.domain}.error.log`),
  }));
  ok(res, { static: Object.keys(LOG_FILES), apps, sites });
}));

// GET /api/logs/site/:domain?kind=access|error&lines=N — Log propio de un sitio.
// El dominio se valida contra la BD del panel (fuente de la verdad) y la ruta
// se construye con siteLogPath (lista blanca de tipo + regex de dominio).
router.get('/site/:domain', wrap(async (req, res) => {
  const domain = req.params.domain;
  const kind = req.query.kind === 'error' ? 'error' : 'access';
  if (!queries.getWebsiteByDomain.get(domain)) return fail(res, 404, 'Ese sitio no existe en el panel.');
  const file = siteLogPath(domain, kind);
  if (!file) return fail(res, 400, 'Dominio o tipo de log inválido.');
  if (!fs.existsSync(file)) {
    return ok(res, { logs: `Este sitio aún no tiene log propio (${kind}). Los sitios creados antes de esta versión escriben en el log global de Nginx; al recrear el sitio tendrá log por dominio.` });
  }
  const lines = clampLines(req.query.lines);
  const r = await runSafe('tail', ['-n', String(lines), file]);
  ok(res, { logs: r.stdout || r.stderr || 'Log vacío.' });
}));

// GET /api/logs/audit/list — Devuelve el registro de auditoría (máx 500 entradas),
// que guarda cada acción importante hecha desde el panel.
router.get('/audit/list', (req, res) => {
  const rows = queries.getAuditLog.all();
  ok(res, rows);
});

// GET /api/logs/:type?lines=N — Últimas N líneas de un log de la lista blanca.
// :type debe estar en LOG_FILES para no leer ficheros arbitrarios.
router.get('/:type', wrap(async (req, res) => {
  const file = LOG_FILES[req.params.type];
  if (!file) return fail(res, 400, 'Tipo de log no permitido');
  const lines = clampLines(req.query.lines);
  const r = await runSafe('tail', ['-n', String(lines), file]);
  ok(res, { logs: r.stdout || r.stderr || 'Log no disponible' });
}));

module.exports = router;
