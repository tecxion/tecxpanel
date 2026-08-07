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

// GET /api/logs/site/:domain?kind=access|error&lines=N&fallback=global
// Log propio de un sitio. El dominio se valida contra la BD del panel (fuente
// de la verdad) y la ruta se construye con siteLogPath (whitelist de tipo +
// regex de dominio). Si el sitio no tiene log propio (versión antigua) y se
// pasa fallback=global, devuelve las últimas N líneas del log GLOBAL de nginx
// con un aviso. Es honesto: sin cambiar el log_format de nginx no se puede
// filtrar por dominio en el log global (el formato combined no lleva $host).
router.get('/site/:domain', wrap(async (req, res) => {
  const domain = req.params.domain;
  const kind = req.query.kind === 'error' ? 'error' : 'access';
  const lines = clampLines(req.query.lines);
  if (!queries.getWebsiteByDomain.get(domain)) return fail(res, 404, 'Ese sitio no existe en el panel.');
  const file = siteLogPath(domain, kind);
  if (!file) return fail(res, 400, 'Dominio o tipo de log inválido.');
  if (fs.existsSync(file)) {
    const r = await runSafe('tail', ['-n', String(lines), file]);
    return ok(res, { logs: r.stdout || r.stderr || 'Log vacío.', source: 'own' });
  }
  // Fallback opcional al log global de nginx (sin filtrar por dominio).
  if (req.query.fallback === 'global') {
    const globalFile = LOG_FILES[kind === 'error' ? 'nginx_error' : 'nginx_access'];
    if (fs.existsSync(globalFile)) {
      const r = await runSafe('tail', ['-n', String(lines), globalFile]);
      const banner = `# Log global de nginx (${kind}). Este sitio no tiene log propio; recréalo desde Sitios para tener uno por dominio.\n`;
      return ok(res, { logs: banner + (r.stdout || r.stderr || ''), source: 'global' });
    }
  }
  ok(res, {
    logs: `Este sitio aún no tiene log propio (${kind}). Los sitios creados antes de esta versión escriben en el log global de Nginx; al recrear el sitio tendrá log por dominio.`,
    source: 'none',
  });
}));

// GET /api/logs/audit/list — Devuelve el registro de auditoría (máx 500 entradas),
// que guarda cada acción importante hecha desde el panel.
router.get('/audit/list', (req, res) => {
  const rows = queries.getAuditLog.all();
  ok(res, rows);
});

// GET /api/logs/errors?lines=N — Feed unificado de errores: nginx_error + syslog
// filtrado a líneas críticas (error/crit/alert/emerg/fail/denied/warn/fatal).
// Cada línea se prefija con [nginx] o [system] para identificar el origen.
// Devuelve también counts por origen para el badge de la UI.
router.get('/errors', wrap(async (req, res) => {
  const lines = clampLines(req.query.lines);
  const RE_ERR = /(error|crit|alert|emerg|denied|fail|warn|fatal)/i;
  const collect = async (label, file) => {
    if (!fs.existsSync(file)) return [];
    const r = await runSafe('tail', ['-n', String(lines), file]);
    return (r.stdout || '').split('\n')
      .filter((l) => l && RE_ERR.test(l))
      .map((l) => `[${label}] ${l}`);
  };
  const [n, s] = await Promise.all([
    collect('nginx',  LOG_FILES.nginx_error),
    collect('system', LOG_FILES.system),
  ]);
  const merged = [...n, ...s].slice(-lines);
  ok(res, {
    logs: merged.length ? merged.join('\n') : 'Sin errores recientes.',
    counts: { nginx: n.length, system: s.length },
  });
}));

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
