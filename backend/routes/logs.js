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
const { ok, fail, runSafe, wrap, clientIp } = require('../lib/helpers');
const { LOG_FILES } = require('../lib/validators');
const { siteLogPath, clampLines } = require('../lib/logs');
const { queries, audit } = require('../database');

const router = express.Router();

// IPv4 / IPv6 (incluye IPv4-mapped IPv6 como "::ffff:1.2.3.4" que es lo que
// nginx a veces registra). runSafe/execFile no interpreta shell, pero mejor
// rechazar basura antes de pasar al cliente de fail2ban.
const RE_IP = /^(?:(?:\d{1,3}\.){3}\d{1,3}|[a-fA-F0-9:]+(?::(?:\d{1,3}\.){3}\d{1,3})?)$/;
// Nombre de jail (evita paths, espacios, etc.). Fail2ban por convención usa
// slug con letras/números/guion.
const RE_JAIL = /^[a-zA-Z0-9._-]{1,64}$/;

// Rutas típicas de bots/escaneos — se marcan como "intento de hackeo" tanto
// en el visor de logs (Bonito) como en el resumen /security. Coincide contra
// el path (case-insensitive). Ampliable sin cambios de shape.
const SUSPICIOUS_PATHS = /(wp-admin|wp-login|wp-content|xmlrpc\.php|\.env|\.git|phpmyadmin|\/pma\b|\/shell\.php|\/cgi-bin\/|\/vendor\/|\/console\b|\/solr\b|\/actuator\b|\/server-status\b|\/config\.php|\/setup\.php|\/eval\.php|\.\.\/)/i;

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

// GET /api/logs/security?hours=24 — Resumen agregado de seguridad:
//   - loginOk/loginFail de las últimas N horas (audit_log).
//   - Top IPs ofensivas (por logins fallidos + hits sospechosos en nginx).
//   - Recuento de intentos de hackeo (paths tipo /wp-admin, /.env, etc.).
// Devuelve un JSON estructurado para pintarlo en cards en el frontend.
router.get('/security', wrap(async (req, res) => {
  const hours = Math.min(Math.max(parseInt(req.query.hours, 10) || 24, 1), 168);
  const cutoff = Date.now() - hours * 3600_000;

  // 1) Audit de logins en la ventana pedida.
  const auditRows = queries.getAuditLog.all();
  const inWindow = auditRows.filter((r) => {
    const t = r.ts ? Date.parse(r.ts) : 0;
    return t && t >= cutoff;
  });
  const logins = { ok: 0, fail: 0, locked: 0 };
  const loginFailByIp = new Map();
  const recentLogins = [];
  for (const r of inWindow) {
    if (!r.action || !r.action.startsWith('login')) continue;
    if (r.action === 'login.ok')     logins.ok++;
    if (r.action === 'login.fail')   { logins.fail++; loginFailByIp.set(r.ip, (loginFailByIp.get(r.ip) || 0) + 1); }
    if (r.action === 'login.locked') logins.locked++;
    if (recentLogins.length < 20) recentLogins.push({ ts: r.ts, user: r.user, ip: r.ip, action: r.action });
  }

  // 2) Nginx access: cuenta hits por IP + intentos sospechosos.
  const hitsByIp = new Map();
  const attacksByIp = new Map();
  const attackSamples = [];
  const accessFile = LOG_FILES.nginx_access;
  if (fs.existsSync(accessFile)) {
    const r = await runSafe('tail', ['-n', '5000', accessFile], { maxBuffer: 16 * 1024 * 1024 });
    const lines = (r.stdout || '').split('\n');
    const RE_ACCESS = /^(\S+)\s+\S+\s+\S+\s+\[([^\]]+)\]\s+"(\S+)\s+(\S+)[^"]*"\s+(\d+)\s+(\d+|-)/;
    for (const line of lines) {
      const m = line.match(RE_ACCESS);
      if (!m) continue;
      const [, ip, , method, path, status] = m;
      hitsByIp.set(ip, (hitsByIp.get(ip) || 0) + 1);
      if (SUSPICIOUS_PATHS.test(path)) {
        attacksByIp.set(ip, (attacksByIp.get(ip) || 0) + 1);
        if (attackSamples.length < 30) attackSamples.push({ ip, method, path, status });
      }
    }
  }

  // 3) Top ofensivas: score = logins fallidos*5 + intentos hackeo*2 + hits/100.
  const allIps = new Set([...loginFailByIp.keys(), ...attacksByIp.keys(), ...hitsByIp.keys()]);
  const top = [...allIps].map((ip) => ({
    ip,
    loginFail: loginFailByIp.get(ip) || 0,
    attacks:   attacksByIp.get(ip) || 0,
    hits:      hitsByIp.get(ip) || 0,
  }))
    .map((r) => ({ ...r, score: r.loginFail * 5 + r.attacks * 2 + Math.floor(r.hits / 100) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);

  ok(res, {
    hours,
    logins,
    attacks: { total: [...attacksByIp.values()].reduce((a, b) => a + b, 0), samples: attackSamples },
    topIps: top,
    recentLogins,
  });
}));

// ── Fail2Ban ────────────────────────────────────────────────────────
// Wrapper mínimo sobre fail2ban-client. Requiere fail2ban instalado y el
// panel corriendo como root (o con sudo NOPASSWD). Si no está instalado,
// /status devuelve installed:false y el frontend oculta la pestaña.

async function f2bInstalled() {
  const r = await runSafe('fail2ban-client', ['--version']);
  return r.ok;
}
// Parsea la salida de `fail2ban-client status` para obtener la lista de jails.
function parseJailList(stdout) {
  const m = (stdout || '').match(/Jail list:\s*(.+)/);
  if (!m) return [];
  return m[1].split(',').map((s) => s.trim()).filter(Boolean);
}
// Parsea `fail2ban-client status <jail>` — devuelve counts + IPs baneadas.
function parseJailStatus(stdout) {
  const currFailed = +((stdout.match(/Currently failed:\s*(\d+)/) || [])[1] || 0);
  const totalFailed = +((stdout.match(/Total failed:\s*(\d+)/) || [])[1] || 0);
  const currBanned = +((stdout.match(/Currently banned:\s*(\d+)/) || [])[1] || 0);
  const totalBanned = +((stdout.match(/Total banned:\s*(\d+)/) || [])[1] || 0);
  const ipLine = (stdout.match(/Banned IP list:\s*(.*)/) || [])[1] || '';
  const ips = ipLine.trim().split(/\s+/).filter(Boolean);
  return { currFailed, totalFailed, currBanned, totalBanned, ips };
}

// GET /api/logs/fail2ban/status — estado global + por jail (paralelo).
router.get('/fail2ban/status', wrap(async (req, res) => {
  if (!(await f2bInstalled())) return ok(res, { installed: false, jails: [] });
  const st = await runSafe('fail2ban-client', ['status']);
  if (!st.ok) return ok(res, { installed: true, error: (st.stderr || '').trim() || 'No se pudo consultar fail2ban.', jails: [] });
  const jailNames = parseJailList(st.stdout);
  const jails = await Promise.all(jailNames.map(async (name) => {
    const r = await runSafe('fail2ban-client', ['status', name]);
    if (!r.ok) return { name, error: (r.stderr || '').trim() };
    return { name, ...parseJailStatus(r.stdout) };
  }));
  ok(res, { installed: true, jails });
}));

// POST /api/logs/fail2ban/unban  { jail, ip } — desbanea una IP en un jail.
// La respuesta lleva success:true EXPLÍCITO — ok(res, {...}) NO lo añade solo.
router.post('/fail2ban/unban', wrap(async (req, res) => {
  const { jail, ip } = req.body || {};
  if (!RE_JAIL.test(String(jail || ''))) return fail(res, 400, 'Jail inválido.');
  if (!RE_IP.test(String(ip || '')))     return fail(res, 400, 'IP inválida.');
  const r = await runSafe('fail2ban-client', ['set', jail, 'unbanip', ip]);
  if (!r.ok) {
    audit(req.user.username, clientIp(req), 'fail2ban.unban.fail', `${jail}:${ip}`);
    return fail(res, 502, (r.stderr || '').trim() || 'fail2ban-client rechazó la petición.');
  }
  audit(req.user.username, clientIp(req), 'fail2ban.unban', `${jail}:${ip}`);
  ok(res, { success: true, output: (r.stdout || '').trim() });
}));

// POST /api/logs/fail2ban/apply-defaults — Escribe /etc/fail2ban/jail.local con
// una config recomendada (bantime 1 h, incremental, ignoreip con localhost +
// IP pública del servidor, jails sshd + nginx-http-auth + nginx-botsearch) y
// recarga fail2ban. Si ya había un jail.local previo, se guarda a jail.local.bak-<ts>
// antes de sobrescribir para poder revertir a mano.
router.post('/fail2ban/apply-defaults', wrap(async (req, res) => {
  if (!(await f2bInstalled())) {
    return fail(res, 400, 'Fail2Ban no está instalado. Instálalo con: sudo apt install fail2ban');
  }

  // Detecta la IP pública para meterla en ignoreip. Fallback a hostname -I.
  let publicIp = '';
  const ipify = await runSafe('curl', ['-4', '-s', '--max-time', '3', 'https://api.ipify.org']);
  if (ipify.ok && /^\d+\.\d+\.\d+\.\d+$/.test(ipify.stdout.trim())) publicIp = ipify.stdout.trim();
  if (!publicIp) {
    const host = await runSafe('hostname', ['-I']);
    if (host.ok) publicIp = (host.stdout || '').trim().split(/\s+/).find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a)) || '';
  }

  const conf = `# TecXPaneL — jail.local generado el ${new Date().toISOString()}
# Regenerable desde Panel → Logs → Fail2Ban → "Aplicar defaults".
# Los cambios manuales sobreviven al reload, pero se pisan si vuelves a
# aplicar defaults (se guarda backup automático en jail.local.bak-<ts>).

[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5
# Baneos que reinciden aumentan progresivamente: 1h → 2h → 4h → 8h ...
bantime.increment = true
bantime.factor    = 2
bantime.maxtime   = 1w
# Localhost + IP pública del servidor para que TecXPaneL no se autobanee.
ignoreip = 127.0.0.1/8 ::1${publicIp ? ' ' + publicIp : ''}

[sshd]
enabled = true

[nginx-http-auth]
enabled = true

[nginx-botsearch]
enabled = true
`;

  const target = '/etc/fail2ban/jail.local';
  const fsp = require('fs').promises;

  // Backup si existe uno previo, con timestamp para no pisarlo.
  let backupPath = null;
  try {
    await fsp.access(target);
    backupPath = `${target}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    await fsp.copyFile(target, backupPath);
  } catch (_) { /* no existía, no hay que respaldar */ }

  try {
    await fsp.writeFile(target, conf, { mode: 0o644 });
  } catch (e) {
    return fail(res, 500, `No se pudo escribir ${target}: ${e.message}. ¿El panel corre como root?`);
  }

  // Reload — mejor que restart (no pierde el estado de baneos actuales).
  const reload = await runSafe('fail2ban-client', ['reload']);
  audit(req.user.username, clientIp(req), 'fail2ban.apply-defaults', publicIp || '(sin ip publica)');
  if (!reload.ok) {
    return fail(res, 502, `jail.local escrito pero fail2ban-client rechazó el reload: ${(reload.stderr || reload.stdout || '').trim()}`);
  }
  ok(res, { success: true, publicIp, backupPath, target });
}));

// POST /api/logs/fail2ban/ban  { jail, ip } — banea manualmente una IP.
router.post('/fail2ban/ban', wrap(async (req, res) => {
  const { jail, ip } = req.body || {};
  if (!RE_JAIL.test(String(jail || ''))) return fail(res, 400, 'Jail inválido.');
  if (!RE_IP.test(String(ip || '')))     return fail(res, 400, 'IP inválida.');
  const r = await runSafe('fail2ban-client', ['set', jail, 'banip', ip]);
  if (!r.ok) {
    audit(req.user.username, clientIp(req), 'fail2ban.ban.fail', `${jail}:${ip}`);
    return fail(res, 502, (r.stderr || '').trim() || 'fail2ban-client rechazó la petición.');
  }
  audit(req.user.username, clientIp(req), 'fail2ban.ban', `${jail}:${ip}`);
  ok(res, { success: true, output: (r.stdout || '').trim() });
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
