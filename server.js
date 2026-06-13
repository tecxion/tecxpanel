// ============================================================
//  TecXPaneL — Backend
//  /opt/txpl/backend/server.js
//
//  Panel de control para VPS. Expone una API REST + WebSockets
//  (stats en tiempo real y terminal SSH) consumida por el
//  frontend SPA y la CLI `txpl`.
//
//  SEGURIDAD — principios aplicados en todo el fichero:
//   · Autenticación JWT con expiración; verificada también en WS.
//   · Contraseña admin con hash bcrypt (ver database.js).
//   · NUNCA se interpola entrada de usuario en una shell:
//     se usa execFile(cmd, [args]) — sin command injection.
//   · Listas blancas para servicios, acciones y rutas de logs.
//   · Jaula de rutas (path jail) en el gestor de archivos:
//     toda ruta se resuelve y debe quedar dentro de SITES_DIR.
//   · Validación de dominios, nombres y puertos por regex.
//   · Cabeceras de seguridad (helmet) y rate limiting.
//   · Auditoría de acciones sensibles en audit_log.
// ============================================================

'use strict';

require('dotenv').config({ path: process.env.TXPL_ENV || '/opt/txpl/.env' });

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const { execFile } = require('child_process');
const { promisify } = require('util');

const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { WebSocketServer } = require('ws');

const { queries, seedAdmin, audit } = require('./database');

const execFileAsync = promisify(execFile);

// ── Configuración ─────────────────────────────────────────────
const PORT = parseInt(process.env.TXPL_PORT || '8585', 10);
const JWT_SECRET = process.env.JWT_SECRET;
const SITES_DIR = path.resolve(process.env.SITES_DIR || '/var/www');
const FRONTEND_DIR = process.env.FRONTEND_DIR || path.join(process.env.TXPL_DIR || '/opt/txpl', 'frontend');
const TOKEN_TTL = process.env.TXPL_TOKEN_TTL || '8h';

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('[FATAL] JWT_SECRET ausente o demasiado corto (mínimo 32 caracteres). Revisa el .env.');
  process.exit(1);
}

seedAdmin();

// ── Listas blancas (defensa contra inyección) ─────────────────
const ALLOWED_SERVICES = ['nginx', 'mysql', 'mariadb', 'postgresql', 'redis', 'redis-server', 'ssh', 'sshd'];
const ALLOWED_SVC_ACTIONS = ['start', 'stop', 'restart'];
const ALLOWED_APP_ACTIONS = ['start', 'stop', 'restart', 'delete'];
const ALLOWED_SITE_TYPES = ['html', 'php', 'nodejs', 'react', 'python'];
const ALLOWED_APP_TYPES = ['nodejs', 'typescript', 'react', 'python'];
const ALLOWED_DB_TYPES = ['mysql', 'postgresql'];
const LOG_FILES = {
  nginx_access: '/var/log/nginx/access.log',
  nginx_error:  '/var/log/nginx/error.log',
  system:       '/var/log/syslog',
};

// ── Validadores ───────────────────────────────────────────────
const RE_DOMAIN = /^(?=.{1,253}$)(?:(?!-)[A-Za-z0-9-]{1,63}(?<!-)\.)+[A-Za-z]{2,63}$/;
const RE_APP_NAME = /^[a-zA-Z0-9_-]{1,40}$/;
const RE_DB_NAME = /^[a-zA-Z0-9_]{1,32}$/;
const RE_DB_USER = /^[a-zA-Z0-9_]{1,32}$/;
const RE_IP_CIDR = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;

const isPort = (v) => Number.isInteger(v) && v > 0 && v <= 65535;
const isValidDomain = (d) => typeof d === 'string' && RE_DOMAIN.test(d);

// ── App Express ───────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1); // detrás de nginx
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: false, // el frontend usa CDNs; se endurece en nginx si se desea
}));
app.use(express.json({ limit: '2mb' }));

// Rate limit global de la API + extra estricto en login
const apiLimiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, max: 10, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiados intentos de login. Espera unos minutos.' } });
app.use('/api/', apiLimiter);

// ── Helpers de respuesta y comandos ───────────────────────────
const ok = (res, data = { success: true }) => res.json(data);
const fail = (res, code, msg) => res.status(code).json({ error: msg });
const clientIp = (req) => req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip;

// Ejecuta un binario con argumentos SIN shell (no hay command injection posible).
async function run(cmd, args = [], opts = {}) {
  const { stdout } = await execFileAsync(cmd, args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, ...opts });
  return stdout;
}
// Igual pero tolera código de salida ≠ 0, devolviendo stdout/stderr.
async function runSafe(cmd, args = [], opts = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, ...opts });
    return { ok: true, stdout, stderr };
  } catch (e) {
    return { ok: false, stdout: e.stdout || '', stderr: e.stderr || e.message };
  }
}

// ── Middleware de autenticación ───────────────────────────────
function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch (_) { return null; }
}

function auth(req, res, next) {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  const payload = token && verifyToken(token);
  if (!payload) return fail(res, 401, 'No autorizado');
  req.user = payload;
  next();
}

// Envuelve handlers async para capturar errores sin try/catch repetido.
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error(`[api] ${req.method} ${req.path}:`, e.message);
  if (!res.headersSent) fail(res, 500, 'Error interno del servidor');
});

// ════════════════════════════════════════════════════════════
//  AUTH
// ════════════════════════════════════════════════════════════
app.post('/api/auth/login', loginLimiter, wrap(async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return fail(res, 400, 'Credenciales requeridas');
  }
  const user = queries.getUserByName.get(username);
  // bcrypt.compare con hash dummy si el usuario no existe → tiempo constante,
  // evita revelar qué usuarios existen por temporización.
  const hash = user ? user.password_hash : '$2a$12$0000000000000000000000000000000000000000000000000000';
  const valid = await bcrypt.compare(password, hash);

  if (!user || !valid) {
    audit(username, clientIp(req), 'login.fail', null);
    return fail(res, 401, 'Credenciales incorrectas');
  }

  const token = jwt.sign({ uid: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: TOKEN_TTL });
  audit(user.username, clientIp(req), 'login.ok', null);
  ok(res, { token, user: { username: user.username, role: user.role } });
}));

app.get('/api/auth/me', auth, (req, res) => {
  const u = queries.getUserById.get(req.user.uid);
  if (!u) return fail(res, 401, 'No autorizado');
  ok(res, { username: u.username, role: u.role });
});

app.post('/api/auth/password', auth, wrap(async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    return fail(res, 400, 'La nueva contraseña debe tener al menos 8 caracteres');
  }
  const u = queries.getUserFullById.get(req.user.uid);
  if (!u) return fail(res, 401, 'No autorizado');
  const valid = await bcrypt.compare(oldPassword || '', u.password_hash);
  if (!valid) {
    audit(u.username, clientIp(req), 'password.change.fail', null);
    return fail(res, 403, 'La contraseña actual no es correcta');
  }
  queries.setPassword.run(bcrypt.hashSync(newPassword, 12), u.id);
  audit(u.username, clientIp(req), 'password.change.ok', null);
  ok(res);
}));

// A partir de aquí, todo /api requiere token.
app.use('/api', auth);

// ════════════════════════════════════════════════════════════
//  SISTEMA — stats, servicios, procesos
// ════════════════════════════════════════════════════════════

// Lectura de CPU desde /proc/stat (delta entre dos muestras).
function readCpuSample() {
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
    const p = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = p[3] + (p[4] || 0);
    const total = p.reduce((a, b) => a + b, 0);
    return { idle, total };
  } catch (_) { return null; }
}
async function cpuPercent() {
  const a = readCpuSample();
  if (!a) return 0;
  await new Promise((r) => setTimeout(r, 200));
  const b = readCpuSample();
  if (!b) return 0;
  const dTotal = b.total - a.total;
  const dIdle = b.idle - a.idle;
  if (dTotal <= 0) return 0;
  return Math.round((1 - dIdle / dTotal) * 100);
}

function memInfo() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  return { total, used, free, percent: Math.round((used / total) * 100) };
}

function readNetSample() {
  try {
    const lines = fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2);
    let rx = 0, tx = 0;
    for (const l of lines) {
      const [iface, rest] = l.split(':');
      if (!rest || iface.trim() === 'lo') continue;
      const cols = rest.trim().split(/\s+/).map(Number);
      rx += cols[0]; tx += cols[8];
    }
    return { rx, tx, t: Date.now() };
  } catch (_) { return null; }
}

async function diskInfo() {
  const out = await runSafe('df', ['-PB1', '-x', 'tmpfs', '-x', 'devtmpfs']);
  if (!out.ok) return [];
  return out.stdout.trim().split('\n').slice(1).map((l) => {
    const c = l.trim().split(/\s+/);
    return { fs: c[0], size: +c[1], used: +c[2], avail: +c[3], percent: parseInt(c[4], 10), mount: c[5] };
  }).filter((d) => d.mount && !d.mount.startsWith('/snap'));
}

function osInfo() {
  let distro = 'Linux', release = '';
  try {
    const r = fs.readFileSync('/etc/os-release', 'utf8');
    distro = (r.match(/^NAME="?([^"\n]+)"?/m) || [])[1] || 'Linux';
    release = (r.match(/^VERSION_ID="?([^"\n]+)"?/m) || [])[1] || '';
  } catch (_) { /* noop */ }
  return { hostname: os.hostname(), distro, release, arch: os.arch(), uptime: Math.floor(os.uptime()) };
}

app.get('/api/system/stats', wrap(async (req, res) => {
  const [cpu, disk] = await Promise.all([cpuPercent(), diskInfo()]);
  ok(res, { cpu, memory: memInfo(), disk, os: osInfo() });
}));

app.get('/api/system/services', wrap(async (req, res) => {
  const result = [];
  for (const name of ['nginx', 'mysql', 'postgresql', 'redis', 'ssh']) {
    const r = await runSafe('systemctl', ['is-active', name]);
    result.push({ name, status: r.stdout.trim() === 'active' ? 'running' : 'stopped' });
  }
  ok(res, result);
}));

app.post('/api/system/service/:name/:action', wrap(async (req, res) => {
  const { name, action } = req.params;
  if (!ALLOWED_SERVICES.includes(name)) return fail(res, 400, 'Servicio no permitido');
  if (!ALLOWED_SVC_ACTIONS.includes(action)) return fail(res, 400, 'Acción no permitida');
  const r = await runSafe('systemctl', [action, name]);
  audit(req.user.username, clientIp(req), 'service.' + action, name);
  if (!r.ok) return fail(res, 500, r.stderr.trim() || 'Error al gestionar el servicio');
  ok(res);
}));

app.get('/api/system/processes', wrap(async (req, res) => {
  const out = await runSafe('ps', ['-eo', 'pid,comm,%cpu,%mem', '--sort=-%cpu']);
  if (!out.ok) return ok(res, []);
  const procs = out.stdout.trim().split('\n').slice(1, 21).map((l) => {
    const c = l.trim().split(/\s+/);
    return { pid: +c[0], name: c[1], cpu: parseFloat(c[2]) || 0, mem: parseFloat(c[3]) || 0 };
  });
  ok(res, procs);
}));

// ════════════════════════════════════════════════════════════
//  SITIOS WEB
// ════════════════════════════════════════════════════════════
const NGINX_AVAILABLE = '/etc/nginx/sites-available';
const NGINX_ENABLED = '/etc/nginx/sites-enabled';

function siteRootFor(domain) {
  // domain ya validado por regex → seguro para componer la ruta.
  return path.join(SITES_DIR, domain);
}

function buildNginxSite(domain, type, port) {
  const root = path.join(siteRootFor(domain), 'public');
  if (type === 'nodejs' || type === 'python') {
    return `server {
    listen 80;
    server_name ${domain} www.${domain};
    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
`;
  }
  return `server {
    listen 80;
    server_name ${domain} www.${domain};
    root ${root};
    index index.html index.htm${type === 'php' ? ' index.php' : ''};
    location / { try_files $uri $uri/ ${type === 'react' ? '/index.html' : '=404'}; }
${type === 'php' ? `    location ~ \\.php$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:/run/php/php-fpm.sock;
    }
` : ''}}
`;
}

app.get('/api/websites', (req, res) => {
  const rows = queries.listWebsites.all().map((w) => ({ ...w, ssl: !!w.ssl, php: !!w.php }));
  ok(res, rows);
});

app.post('/api/websites', wrap(async (req, res) => {
  const { domain, type = 'html', php = false, ssl = false } = req.body || {};
  if (!isValidDomain(domain)) return fail(res, 400, 'Dominio inválido');
  if (!ALLOWED_SITE_TYPES.includes(type)) return fail(res, 400, 'Tipo de sitio inválido');
  if (queries.getWebsiteByDomain.get(domain)) return fail(res, 409, 'Ese dominio ya existe');

  const root = path.join(siteRootFor(domain), 'public');
  fs.mkdirSync(root, { recursive: true });
  if (type === 'html' || type === 'react') {
    fs.writeFileSync(path.join(root, 'index.html'),
      `<!doctype html><meta charset="utf-8"><title>${domain}</title><h1>${domain}</h1><p>Servido por TecXPaneL.</p>`);
  }

  // Config nginx (los proxies usan un puerto por defecto editable luego).
  const conf = buildNginxSite(domain, type, 3000);
  const confPath = path.join(NGINX_AVAILABLE, domain);
  fs.writeFileSync(confPath, conf);
  try { fs.symlinkSync(confPath, path.join(NGINX_ENABLED, domain)); } catch (e) { if (e.code !== 'EEXIST') throw e; }

  const test = await runSafe('nginx', ['-t']);
  if (!test.ok) {
    fs.rmSync(path.join(NGINX_ENABLED, domain), { force: true });
    return fail(res, 500, 'Config nginx inválida: ' + test.stderr.split('\n')[0]);
  }
  await runSafe('systemctl', ['reload', 'nginx']);

  const info = queries.insertWebsite.run({ domain, type, php: php ? 1 : 0, ssl: 0, status: 'active' });
  audit(req.user.username, clientIp(req), 'website.create', domain);

  if (ssl) await installSsl(domain).catch(() => {});
  ok(res, { success: true, id: info.lastInsertRowid });
}));

app.delete('/api/websites/:id', wrap(async (req, res) => {
  const site = queries.getWebsite.get(+req.params.id);
  if (!site) return fail(res, 404, 'Sitio no encontrado');
  fs.rmSync(path.join(NGINX_ENABLED, site.domain), { force: true });
  fs.rmSync(path.join(NGINX_AVAILABLE, site.domain), { force: true });
  await runSafe('systemctl', ['reload', 'nginx']);
  queries.deleteWebsite.run(site.id);
  audit(req.user.username, clientIp(req), 'website.delete', site.domain);
  ok(res);
}));

async function installSsl(domain) {
  // certbot con argumentos en array → sin inyección.
  const r = await runSafe('certbot', ['--nginx', '-d', domain, '-d', `www.${domain}`,
    '--non-interactive', '--agree-tos', '--redirect', '-m', process.env.SSL_EMAIL || `admin@${domain}`]);
  if (!r.ok) throw new Error(r.stderr.split('\n').slice(-3).join(' ') || 'certbot falló');
}

app.post('/api/websites/:id/ssl', wrap(async (req, res) => {
  const site = queries.getWebsite.get(+req.params.id);
  if (!site) return fail(res, 404, 'Sitio no encontrado');
  await installSsl(site.domain);
  queries.setWebsiteSsl.run(site.id);
  audit(req.user.username, clientIp(req), 'website.ssl', site.domain);
  ok(res);
}));

// ════════════════════════════════════════════════════════════
//  APLICACIONES (PM2)
// ════════════════════════════════════════════════════════════
async function pm2Status(pm2Name) {
  const r = await runSafe('pm2', ['jlist']);
  if (!r.ok) return 'unknown';
  try {
    const list = JSON.parse(r.stdout);
    const proc = list.find((p) => p.name === pm2Name);
    return proc ? (proc.pm2_env.status === 'online' ? 'running' : 'stopped') : 'stopped';
  } catch (_) { return 'unknown'; }
}

app.get('/api/apps', wrap(async (req, res) => {
  const apps = queries.listApps.all();
  const enriched = await Promise.all(apps.map(async (a) => ({
    id: a.id, name: a.name, type: a.type, port: a.port, domain: a.domain,
    status: await pm2Status(a.pm2_name),
  })));
  ok(res, enriched);
}));

app.post('/api/apps', wrap(async (req, res) => {
  const { name, type = 'nodejs', path: appPath, startCmd, port, domain } = req.body || {};
  if (!RE_APP_NAME.test(name || '')) return fail(res, 400, 'Nombre de app inválido (solo letras, números, - y _)');
  if (!ALLOWED_APP_TYPES.includes(type)) return fail(res, 400, 'Tipo de app inválido');
  if (queries.getAppByName.get(name)) return fail(res, 409, 'Ya existe una app con ese nombre');

  const portNum = port ? parseInt(port, 10) : null;
  if (port && !isPort(portNum)) return fail(res, 400, 'Puerto inválido');
  if (domain && !isValidDomain(domain)) return fail(res, 400, 'Dominio inválido');

  // El path debe ser absoluto y existir; no se interpola en shell.
  const cwd = path.resolve(appPath || '');
  if (!appPath || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    return fail(res, 400, 'La ruta del proyecto no existe');
  }

  const pm2Name = `txpl-app-${name}`;
  // Comando de arranque según el tipo. startCmd es el fichero/entrypoint.
  let interpreter, script;
  if (type === 'python') { interpreter = 'python3'; script = startCmd || 'app.py'; }
  else { interpreter = null; script = startCmd || 'index.js'; }

  const pm2Args = ['start', script, '--name', pm2Name, '--cwd', cwd];
  if (interpreter) pm2Args.push('--interpreter', interpreter);
  if (portNum) pm2Args.push('--', `PORT=${portNum}`); // se pasa como arg, no como shell

  const r = await runSafe('pm2', pm2Args, { cwd });
  if (!r.ok) return fail(res, 500, r.stderr.split('\n').slice(-2).join(' ') || 'PM2 no pudo iniciar la app');
  await runSafe('pm2', ['save']);

  const info = queries.insertApp.run({
    name, type, path: cwd, start_cmd: script, port: portNum, domain: domain || null,
    pm2_name: pm2Name, status: 'running',
  });
  audit(req.user.username, clientIp(req), 'app.create', name);
  ok(res, { success: true, id: info.lastInsertRowid });
}));

app.post('/api/apps/:id/:action', wrap(async (req, res) => {
  const { action } = req.params;
  if (!ALLOWED_APP_ACTIONS.includes(action)) return fail(res, 400, 'Acción no permitida');
  const appRow = queries.getApp.get(+req.params.id);
  if (!appRow) return fail(res, 404, 'App no encontrada');

  if (action === 'delete') {
    await runSafe('pm2', ['delete', appRow.pm2_name]);
    await runSafe('pm2', ['save']);
    queries.deleteApp.run(appRow.id);
  } else {
    const r = await runSafe('pm2', [action, appRow.pm2_name]);
    if (!r.ok) return fail(res, 500, r.stderr.split('\n').slice(-1)[0] || 'Error de PM2');
    queries.setAppStatus.run(action === 'stop' ? 'stopped' : 'running', appRow.id);
  }
  audit(req.user.username, clientIp(req), 'app.' + action, appRow.name);
  ok(res);
}));

app.get('/api/apps/:id/logs', wrap(async (req, res) => {
  const appRow = queries.getApp.get(+req.params.id);
  if (!appRow) return fail(res, 404, 'App no encontrada');
  const r = await runSafe('pm2', ['logs', appRow.pm2_name, '--lines', '200', '--nostream', '--raw']);
  ok(res, { logs: r.stdout || r.stderr || 'Sin logs' });
}));

// ════════════════════════════════════════════════════════════
//  BASES DE DATOS
// ════════════════════════════════════════════════════════════
function genPassword(len = 20) {
  return crypto.randomBytes(len).toString('base64').replace(/[+/=]/g, '').slice(0, len);
}

app.get('/api/databases', (req, res) => {
  ok(res, queries.listDatabases.all());
});

app.post('/api/databases', wrap(async (req, res) => {
  const { type = 'mysql', name, user, password } = req.body || {};
  if (!ALLOWED_DB_TYPES.includes(type)) return fail(res, 400, 'Motor inválido');
  if (!RE_DB_NAME.test(name || '')) return fail(res, 400, 'Nombre de BD inválido (solo letras, números y _)');
  if (queries.getDatabaseByName.get(name)) return fail(res, 409, 'Ya existe una BD con ese nombre');

  const dbUser = (user && user.trim()) || (name + '_u').slice(0, 32);
  if (!RE_DB_USER.test(dbUser)) return fail(res, 400, 'Usuario de BD inválido');
  const dbPass = (password && password.trim()) || genPassword();

  if (type === 'mysql') {
    const rootPass = process.env.MYSQL_ROOT_PASSWORD;
    if (!rootPass) return fail(res, 500, 'MYSQL_ROOT_PASSWORD no configurado');
    // Sentencias parametrizadas vía stdin con identificadores ya validados por regex.
    const sql = `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER '${dbUser}'@'localhost' IDENTIFIED BY '${dbPass.replace(/'/g, "''")}';
GRANT ALL PRIVILEGES ON \`${name}\`.* TO '${dbUser}'@'localhost';
FLUSH PRIVILEGES;`;
    const r = await runSafe('mysql', ['-u', 'root', `-p${rootPass}`], { input: sql });
    if (!r.ok) return fail(res, 500, r.stderr.split('\n')[0] || 'Error al crear la BD MySQL');
  } else {
    // PostgreSQL: createuser/createdb como usuario postgres.
    const r1 = await runSafe('sudo', ['-u', 'postgres', 'psql', '-c',
      `CREATE USER ${dbUser} WITH PASSWORD '${dbPass.replace(/'/g, "''")}';`]);
    if (!r1.ok) return fail(res, 500, r1.stderr.split('\n')[0] || 'Error al crear el usuario PostgreSQL');
    const r2 = await runSafe('sudo', ['-u', 'postgres', 'psql', '-c',
      `CREATE DATABASE ${name} OWNER ${dbUser};`]);
    if (!r2.ok) return fail(res, 500, r2.stderr.split('\n')[0] || 'Error al crear la BD PostgreSQL');
  }

  queries.insertDatabase.run({ name, type, db_user: dbUser, db_password: dbPass, status: 'active' });
  audit(req.user.username, clientIp(req), 'database.create', `${type}:${name}`);
  ok(res, { success: true, name, user: dbUser, password: dbPass });
}));

// ════════════════════════════════════════════════════════════
//  GESTOR DE ARCHIVOS — con jaula de rutas (path jail)
// ════════════════════════════════════════════════════════════
// Resuelve una ruta y garantiza que queda DENTRO de SITES_DIR.
// Bloquea path traversal (../) y rutas absolutas fuera del jail.
function safePath(input) {
  if (typeof input !== 'string' || !input) return null;
  const resolved = path.resolve(SITES_DIR, input.replace(/^\/+/, ''));
  if (resolved !== SITES_DIR && !resolved.startsWith(SITES_DIR + path.sep)) return null;
  return resolved;
}

app.get('/api/files', wrap(async (req, res) => {
  const dir = safePath(req.query.path || '');
  if (!dir) return fail(res, 403, 'Ruta fuera del área permitida');
  if (!fs.existsSync(dir)) return fail(res, 404, 'Directorio no encontrado');

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const items = entries.map((e) => {
    const full = path.join(dir, e.name);
    let size = 0, modified = null;
    try { const st = fs.statSync(full); size = st.size; modified = st.mtime; } catch (_) { /* noop */ }
    return { name: e.name, path: full, type: e.isDirectory() ? 'directory' : 'file', size, modified };
  }).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));

  ok(res, { path: dir, items });
}));

app.get('/api/files/read', wrap(async (req, res) => {
  const file = safePath(req.query.path || '');
  if (!file) return fail(res, 403, 'Ruta fuera del área permitida');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return fail(res, 404, 'Archivo no encontrado');
  if (fs.statSync(file).size > 2 * 1024 * 1024) return fail(res, 413, 'Archivo demasiado grande para editar');
  ok(res, { content: fs.readFileSync(file, 'utf8') });
}));

app.post('/api/files/write', wrap(async (req, res) => {
  const file = safePath(req.body?.path || '');
  if (!file) return fail(res, 403, 'Ruta fuera del área permitida');
  if (typeof req.body.content !== 'string') return fail(res, 400, 'Contenido inválido');
  fs.writeFileSync(file, req.body.content, 'utf8');
  audit(req.user.username, clientIp(req), 'file.write', file);
  ok(res);
}));

app.delete('/api/files', wrap(async (req, res) => {
  const target = safePath(req.body?.path || '');
  if (!target) return fail(res, 403, 'Ruta fuera del área permitida');
  if (target === SITES_DIR) return fail(res, 403, 'No se puede eliminar el directorio raíz');
  if (!fs.existsSync(target)) return fail(res, 404, 'No encontrado');
  fs.rmSync(target, { recursive: true, force: true });
  audit(req.user.username, clientIp(req), 'file.delete', target);
  ok(res);
}));

// ════════════════════════════════════════════════════════════
//  FIREWALL (UFW)
// ════════════════════════════════════════════════════════════
app.get('/api/firewall', wrap(async (req, res) => {
  const r = await runSafe('ufw', ['status', 'numbered']);
  const enabled = /Status:\s*active/i.test(r.stdout);
  const rules = [];
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^\[\s*(\d+)\]\s+(.+?)\s{2,}(ALLOW|DENY|REJECT|LIMIT)\s+(?:IN\s+)?(.*)$/i);
    if (m) rules.push({ num: +m[1], to: m[2].trim(), action: m[3].toUpperCase(), from: m[4].trim() });
  }
  ok(res, { enabled, rules });
}));

app.post('/api/firewall/rule', wrap(async (req, res) => {
  const { action = 'allow', port, protocol = 'tcp', from } = req.body || {};
  if (!['allow', 'deny'].includes(action)) return fail(res, 400, 'Acción inválida');
  const portNum = parseInt(port, 10);
  if (!isPort(portNum)) return fail(res, 400, 'Puerto inválido');
  if (protocol && !['tcp', 'udp', ''].includes(protocol)) return fail(res, 400, 'Protocolo inválido');
  if (from && !RE_IP_CIDR.test(from)) return fail(res, 400, 'IP/CIDR de origen inválida');

  // Construye los argumentos validados; ufw no ve una shell.
  let args;
  const portSpec = protocol ? `${portNum}/${protocol}` : String(portNum);
  if (from) args = [action, 'from', from, 'to', 'any', 'port', String(portNum), ...(protocol ? ['proto', protocol] : [])];
  else args = [action, portSpec];

  const r = await runSafe('ufw', args);
  if (!r.ok) return fail(res, 500, r.stderr.split('\n')[0] || 'Error de UFW');
  audit(req.user.username, clientIp(req), 'firewall.add', args.join(' '));
  ok(res);
}));

app.delete('/api/firewall/rule/:num', wrap(async (req, res) => {
  const num = parseInt(req.params.num, 10);
  if (!Number.isInteger(num) || num < 1) return fail(res, 400, 'Número de regla inválido');
  // `ufw --force delete N` no pide confirmación interactiva.
  const r = await runSafe('ufw', ['--force', 'delete', String(num)]);
  if (!r.ok) return fail(res, 500, r.stderr.split('\n')[0] || 'Error de UFW');
  audit(req.user.username, clientIp(req), 'firewall.delete', String(num));
  ok(res);
}));

// ════════════════════════════════════════════════════════════
//  LOGS
// ════════════════════════════════════════════════════════════
app.get('/api/logs/:type', wrap(async (req, res) => {
  const file = LOG_FILES[req.params.type];
  if (!file) return fail(res, 400, 'Tipo de log no permitido');
  const r = await runSafe('tail', ['-n', '300', file]);
  ok(res, { logs: r.stdout || r.stderr || 'Log no disponible' });
}));

// ════════════════════════════════════════════════════════════
//  FRONTEND ESTÁTICO
// ════════════════════════════════════════════════════════════
// Sin cache larga: el frontend es un único index.html y debe reflejar
// las actualizaciones al instante. ETag/Last-Modified evitan transferencias
// innecesarias (respuestas 304) sin servir una versión obsoleta.
app.use(express.static(FRONTEND_DIR, { maxAge: 0, index: 'index.html', etag: true }));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return fail(res, 404, 'No encontrado');
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

// ════════════════════════════════════════════════════════════
//  SERVIDOR HTTP + WEBSOCKETS
// ════════════════════════════════════════════════════════════
const server = http.createServer(app);

// WS de stats (push cada 2s) y terminal. Ambos autentican el token
// del query string ANTES de establecer la sesión.
const wssStats = new WebSocketServer({ noServer: true });
const wssTerm = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname, searchParams } = new URL(req.url, 'http://localhost');
  const token = searchParams.get('token');
  const payload = token && verifyToken(token);
  if (!payload) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  req.user = payload;

  if (pathname === '/ws/stats') {
    wssStats.handleUpgrade(req, socket, head, (ws) => wssStats.emit('connection', ws, req));
  } else if (pathname === '/ws/terminal') {
    wssTerm.handleUpgrade(req, socket, head, (ws) => wssTerm.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// ── Stats en tiempo real ──────────────────────────────────────
wssStats.on('connection', (ws) => {
  let prevNet = readNetSample();
  let alive = true;
  ws.on('close', () => { alive = false; });

  const tick = async () => {
    if (!alive || ws.readyState !== ws.OPEN) return;
    const cpu = await cpuPercent();
    const net = readNetSample();
    let rx = 0, tx = 0;
    if (prevNet && net) {
      const dt = (net.t - prevNet.t) / 1000 || 1;
      rx = Math.max(0, Math.round((net.rx - prevNet.rx) / dt));
      tx = Math.max(0, Math.round((net.tx - prevNet.tx) / dt));
    }
    prevNet = net;
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'stats', cpu, memory: memInfo(), network: { rx, tx } }));
    }
    if (alive) setTimeout(tick, 2000);
  };
  tick();
});

// ── Terminal interactiva (requiere node-pty) ──────────────────
let pty = null;
try { pty = require('node-pty'); } catch (_) { console.warn('[ws] node-pty no instalado: la terminal estará deshabilitada.'); }

wssTerm.on('connection', (ws, req) => {
  if (!pty) {
    ws.send(JSON.stringify({ type: 'output', data: 'node-pty no está instalado en el servidor.\r\n' }));
    ws.close();
    return;
  }
  audit(req.user.username, clientIp(req), 'terminal.open', null);
  const shell = pty.spawn(process.env.SHELL || 'bash', [], {
    name: 'xterm-color', cols: 80, rows: 24, cwd: process.env.HOME || '/root', env: process.env,
  });
  shell.onData((data) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'output', data })); });
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'input' && typeof msg.data === 'string') shell.write(msg.data);
      else if (msg.type === 'resize' && msg.cols && msg.rows) shell.resize(msg.cols, msg.rows);
    } catch (_) { /* ignora mensajes mal formados */ }
  });
  ws.on('close', () => shell.kill());
});

// ── Arranque + apagado limpio ─────────────────────────────────
server.listen(PORT, '127.0.0.1', () => {
  console.log(`[txpl] Panel escuchando en http://127.0.0.1:${PORT}`);
});

function shutdown() {
  console.log('[txpl] Apagando...');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 4000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('message', (m) => { if (m === 'shutdown') shutdown(); }); // PM2 shutdown_with_message
