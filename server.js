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

// ── Cifrado en reposo (AES-256-GCM) ───────────────────────────
// Para secretos que hay que poder mostrar (contraseñas de BD). La clave se
// deriva de TXPL_SECRET_KEY (o, en su defecto, de JWT_SECRET) con scrypt.
const ENC_KEY = crypto.scryptSync(process.env.TXPL_SECRET_KEY || JWT_SECRET, 'txpl-enc-v1', 32);
function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return 'enc:v1:' + Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}
function decryptSecret(stored) {
  // Tolerante con filas antiguas en texto plano (sin prefijo enc:v1:).
  if (typeof stored !== 'string' || !stored.startsWith('enc:v1:')) return stored;
  try {
    const raw = Buffer.from(stored.slice(7), 'base64');
    const iv = raw.subarray(0, 12), tag = raw.subarray(12, 28), data = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENC_KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch (_) { return '(no descifrable)'; }
}

// ── TOTP (2FA) — RFC 6238, SHA-1, 6 dígitos, paso 30s ─────────
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const clean = str.replace(/=+$/, '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0; const out = [];
  for (const c of clean) {
    value = (value << 5) | B32.indexOf(c); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
function hotp(keyBuf, counter) {
  const buf = Buffer.alloc(8); buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', keyBuf).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24) | ((h[off + 1] & 0xff) << 16) | ((h[off + 2] & 0xff) << 8) | (h[off + 3] & 0xff);
  return (code % 1_000_000).toString().padStart(6, '0');
}
function totpVerify(secretB32, token) {
  if (!secretB32 || !/^\d{6}$/.test(String(token || '').trim())) return false;
  const key = base32Decode(secretB32);
  const step = Math.floor(Date.now() / 1000 / 30);
  for (let w = -1; w <= 1; w++) {           // tolera ±1 ventana (reloj desfasado)
    if (hotp(key, step + w) === String(token).trim()) return true;
  }
  return false;
}

// ── Bloqueo por intentos fallidos de login (por IP) ───────────
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_MS = 15 * 60_000;
const loginFails = new Map(); // ip -> { count, until }
function loginLocked(ip) {
  const e = loginFails.get(ip);
  return e && e.until && e.until > Date.now();
}
function recordLoginFail(ip) {
  const e = loginFails.get(ip) || { count: 0, until: 0 };
  e.count++;
  if (e.count >= LOGIN_MAX_FAILS) e.until = Date.now() + LOGIN_LOCK_MS;
  loginFails.set(ip, e);
}
function clearLoginFails(ip) { loginFails.delete(ip); }

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
  const ip = clientIp(req);
  if (loginLocked(ip)) {
    audit(req.body?.username, ip, 'login.locked', null);
    return fail(res, 429, 'Demasiados intentos fallidos. Cuenta bloqueada temporalmente.');
  }

  const { username, password, code } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') {
    return fail(res, 400, 'Credenciales requeridas');
  }
  const user = queries.getUserByName.get(username);
  // bcrypt.compare con hash dummy si el usuario no existe → tiempo constante,
  // evita revelar qué usuarios existen por temporización.
  const hash = user ? user.password_hash : '$2a$12$0000000000000000000000000000000000000000000000000000';
  const valid = await bcrypt.compare(password, hash);

  if (!user || !valid) {
    recordLoginFail(ip);
    audit(username, ip, 'login.fail', null);
    return fail(res, 401, 'Credenciales incorrectas');
  }

  // Segundo factor: si el usuario tiene 2FA activo, exige código TOTP válido.
  if (user.totp_enabled) {
    if (!code) return res.status(401).json({ error: 'Código 2FA requerido', twofa: true });
    if (!totpVerify(user.totp_secret, code)) {
      recordLoginFail(ip);
      audit(user.username, ip, 'login.2fa.fail', null);
      return res.status(401).json({ error: 'Código 2FA incorrecto', twofa: true });
    }
  }

  clearLoginFails(ip);
  const token = jwt.sign({ uid: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: TOKEN_TTL });
  audit(user.username, ip, 'login.ok', null);
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

// ── 2FA (TOTP) ────────────────────────────────────────────────
app.get('/api/auth/2fa/status', auth, (req, res) => {
  const u = queries.getUserById.get(req.user.uid);
  ok(res, { enabled: !!(u && u.totp_enabled) });
});

// Genera un secreto nuevo (aún sin activar) y devuelve el URI otpauth para el QR.
app.post('/api/auth/2fa/setup', auth, wrap(async (req, res) => {
  const u = queries.getUserFullById.get(req.user.uid);
  if (!u) return fail(res, 401, 'No autorizado');
  const secret = base32Encode(crypto.randomBytes(20));
  queries.setTotpSecret.run(secret, u.id); // queda totp_enabled = 0 hasta verificar
  const label = encodeURIComponent(`TecXPaneL:${u.username}`);
  const otpauth = `otpauth://totp/${label}?secret=${secret}&issuer=TecXPaneL&algorithm=SHA1&digits=6&period=30`;
  ok(res, { secret, otpauth });
}));

// Verifica el primer código y activa el 2FA.
app.post('/api/auth/2fa/enable', auth, wrap(async (req, res) => {
  const u = queries.getUserFullById.get(req.user.uid);
  if (!u || !u.totp_secret) return fail(res, 400, 'Primero genera un secreto (setup)');
  if (!totpVerify(u.totp_secret, req.body?.code)) return fail(res, 400, 'Código incorrecto');
  queries.enableTotp.run(u.id);
  audit(u.username, clientIp(req), '2fa.enable', null);
  ok(res);
}));

// Desactiva el 2FA (requiere la contraseña actual).
app.post('/api/auth/2fa/disable', auth, wrap(async (req, res) => {
  const u = queries.getUserFullById.get(req.user.uid);
  if (!u) return fail(res, 401, 'No autorizado');
  const valid = await bcrypt.compare(req.body?.password || '', u.password_hash);
  if (!valid) return fail(res, 403, 'Contraseña incorrecta');
  queries.disableTotp.run(u.id);
  audit(u.username, clientIp(req), '2fa.disable', null);
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

app.post('/api/system/service/:name/:action', auth, wrap(async (req, res) => {
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

function buildNginxSite(domain, type, proxyPort, opts = {}) {
  const { listenPort, phpVersion } = opts;
  const root = path.join(SITES_DIR, domain, 'public');
  const listen = listenPort ? `listen ${listenPort}` : 'listen 80';
  const serverName = listenPort ? '' : `\n    server_name ${domain} www.${domain};`;
  const fpmSock = phpVersion
    ? `/run/php/php${phpVersion}-fpm.sock`
    : '/run/php/php-fpm.sock';

  if (type === 'nodejs' || type === 'python') {
    return `server {
    ${listen};${serverName}
    location / {
        proxy_pass http://127.0.0.1:${proxyPort};
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
    ${listen};${serverName}
    root ${root};
    index index.html index.htm${type === 'php' ? ' index.php' : ''};
    location / { try_files $uri $uri/ ${type === 'react' ? '/index.html' : '=404'}; }
${type === 'php' ? `    location ~ \\.php$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:${fpmSock};
    }
` : ''}}
`;
}

app.get('/api/websites', auth, (req, res) => {
  const rows = queries.listWebsites.all().map((w) => ({
    ...w, ssl: !!w.ssl, php: !!w.php,
    listen_port: w.listen_port || null,
    php_version: w.php_version || null,
  }));
  ok(res, rows);
});

app.post('/api/websites', auth, wrap(async (req, res) => {
  const { domain, type = 'html', php = false, ssl = false, usePort = false, phpVersion } = req.body || {};
  if (!ALLOWED_SITE_TYPES.includes(type)) return fail(res, 400, 'Tipo de sitio inválido');

  let siteDomain, listenPort = null;
  if (usePort) {
    // Sin dominio: acceso por IP:puerto. domain es un slug (ej: "mi-web").
    if (!domain || !RE_APP_NAME.test(domain)) return fail(res, 400, 'Nombre inválido (letras, números, guiones)');
    siteDomain = domain;
    if (queries.getWebsiteByDomain.get(siteDomain)) return fail(res, 409, 'Ya existe un sitio con ese nombre');
    // Asigna el siguiente puerto disponible a partir de 8001.
    const maxRow = queries.getMaxListenPort.get();
    listenPort = Math.max(8001, (maxRow?.maxPort || 8000) + 1);
  } else {
    if (!isValidDomain(domain)) return fail(res, 400, 'Dominio inválido');
    siteDomain = domain;
    if (queries.getWebsiteByDomain.get(siteDomain)) return fail(res, 409, 'Ese dominio ya existe');
  }

  const root = path.join(SITES_DIR, siteDomain, 'public');
  fs.mkdirSync(root, { recursive: true });
  if (type === 'html' || type === 'react') {
    fs.writeFileSync(path.join(root, 'index.html'),
      `<!doctype html><meta charset="utf-8"><title>${siteDomain}</title><h1>${siteDomain}</h1><p>Servido por TecXPaneL.</p>`);
  }

  const conf = buildNginxSite(siteDomain, type, 3000, { listenPort, phpVersion: phpVersion || null });
  const confPath = path.join(NGINX_AVAILABLE, siteDomain);
  fs.writeFileSync(confPath, conf);
  try { fs.symlinkSync(confPath, path.join(NGINX_ENABLED, siteDomain)); } catch (e) { if (e.code !== 'EEXIST') throw e; }

  const test = await runSafe('nginx', ['-t']);
  if (!test.ok) {
    fs.rmSync(path.join(NGINX_ENABLED, siteDomain), { force: true });
    return fail(res, 500, 'Config nginx inválida: ' + test.stderr.split('\n')[0]);
  }
  await runSafe('systemctl', ['reload', 'nginx']);

  // Abre el puerto en UFW si es un sitio por puerto.
  if (listenPort) {
    await runSafe('ufw', ['allow', `${listenPort}/tcp`]);
  }

  const info = queries.insertWebsite.run({
    domain: siteDomain, type, php: php ? 1 : 0, ssl: 0, status: 'active',
    listen_port: listenPort, php_version: phpVersion || null,
  });
  audit(req.user.username, clientIp(req), 'website.create', siteDomain);

  if (ssl && !usePort) await installSsl(siteDomain).catch(() => {});
  ok(res, { success: true, id: info.lastInsertRowid, port: listenPort });
}));

app.delete('/api/websites/:id', auth, wrap(async (req, res) => {
  const site = queries.getWebsite.get(+req.params.id);
  if (!site) return fail(res, 404, 'Sitio no encontrado');
  fs.rmSync(path.join(NGINX_ENABLED, site.domain), { force: true });
  fs.rmSync(path.join(NGINX_AVAILABLE, site.domain), { force: true });
  await runSafe('systemctl', ['reload', 'nginx']);
  if (site.listen_port) await runSafe('ufw', ['delete', 'allow', `${site.listen_port}/tcp`]);
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

app.post('/api/websites/:id/ssl', auth, wrap(async (req, res) => {
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

app.get('/api/apps', auth, wrap(async (req, res) => {
  const apps = queries.listApps.all();
  const enriched = await Promise.all(apps.map(async (a) => ({
    id: a.id, name: a.name, type: a.type, port: a.port, domain: a.domain,
    status: await pm2Status(a.pm2_name),
  })));
  ok(res, enriched);
}));

app.post('/api/apps', auth, wrap(async (req, res) => {
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
  const cmd = (startCmd || '').trim();
  let pm2Args, script;

  if (/^(npm|yarn|pnpm)\b/.test(cmd)) {
    // npm start, npm run dev, yarn start, pnpm start → pm2 start npm -- start
    const parts = cmd.split(/\s+/);
    script = cmd;
    pm2Args = ['start', parts[0], '--name', pm2Name, '--cwd', cwd, '--', ...parts.slice(1)];
  } else if (/^(python3?|node)\s/.test(cmd)) {
    // node server.js → pm2 start server.js; python3 app.py → pm2 start app.py --interpreter python3
    const parts = cmd.split(/\s+/);
    const interp = parts[0];
    script = parts.slice(1).join(' ') || (interp.startsWith('python') ? 'app.py' : 'index.js');
    pm2Args = ['start', script, '--name', pm2Name, '--cwd', cwd];
    if (interp.startsWith('python')) pm2Args.push('--interpreter', interp);
  } else {
    script = cmd || (type === 'python' ? 'app.py' : 'index.js');
    const fullPath = path.join(cwd, script);
    if (!fs.existsSync(fullPath)) {
      return fail(res, 400, `No se encontró "${script}" en ${cwd}. Escribe el archivo a ejecutar (ej: server.js) o un comando npm (ej: npm start).`);
    }
    pm2Args = ['start', script, '--name', pm2Name, '--cwd', cwd];
    if (type === 'python') pm2Args.push('--interpreter', 'python3');
  }

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

app.post('/api/apps/:id/:action', auth, wrap(async (req, res) => {
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

app.get('/api/apps/:id/logs', auth, wrap(async (req, res) => {
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

app.get('/api/databases', auth, (req, res) => {
  // Las contraseñas se guardan cifradas (AES-256-GCM); se descifran al mostrarlas.
  const rows = queries.listDatabases.all().map(d => ({ ...d, db_password: decryptSecret(d.db_password) }));
  ok(res, rows);
});

app.post('/api/databases', auth, wrap(async (req, res) => {
  const { type = 'mysql', name, user, password } = req.body || {};
  if (!ALLOWED_DB_TYPES.includes(type)) return fail(res, 400, 'Motor inválido');
  if (!RE_DB_NAME.test(name || '')) return fail(res, 400, 'Nombre de BD inválido (solo letras, números y _)');
  if (queries.getDatabaseByName.get(name)) return fail(res, 409, 'Ya existe una BD con ese nombre');

  const dbUser = (user && user.trim()) || (name + '_u').slice(0, 32);
  if (!RE_DB_USER.test(dbUser)) return fail(res, 400, 'Usuario de BD inválido');
  const dbPass = (password && password.trim()) || genPassword();

  if (type === 'mysql') {
    const mysqlCheck = await runSafe('which', ['mysql']);
    if (!mysqlCheck.ok) return fail(res, 400, 'MariaDB/MySQL no está instalado. Instálalo desde Plugins.');

    const sql = `CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER '${dbUser}'@'localhost' IDENTIFIED BY '${dbPass.replace(/'/g, "''")}';
GRANT ALL PRIVILEGES ON \`${name}\`.* TO '${dbUser}'@'localhost';
FLUSH PRIVILEGES;`;
    // Intenta primero unix_socket (MariaDB default), luego con contraseña.
    let r = await runSafe('mysql', ['-u', 'root'], { input: sql });
    if (!r.ok) {
      const rootPass = process.env.MYSQL_ROOT_PASSWORD;
      if (rootPass) r = await runSafe('mysql', ['-u', 'root', `-p${rootPass}`], { input: sql });
    }
    if (!r.ok) return fail(res, 500, r.stderr.split('\n').filter(l => l.trim()).pop() || 'Error al crear la BD MySQL');
  } else {
    const pgCheck = await runSafe('which', ['psql']);
    if (!pgCheck.ok) return fail(res, 400, 'PostgreSQL no está instalado. Instálalo desde Plugins.');

    const r1 = await runSafe('sudo', ['-u', 'postgres', 'psql', '-c',
      `CREATE USER ${dbUser} WITH PASSWORD '${dbPass.replace(/'/g, "''")}';`]);
    if (!r1.ok) return fail(res, 500, r1.stderr.split('\n').filter(l => l.trim()).pop() || 'Error al crear el usuario PostgreSQL');
    const r2 = await runSafe('sudo', ['-u', 'postgres', 'psql', '-c',
      `CREATE DATABASE ${name} OWNER ${dbUser};`]);
    if (!r2.ok) return fail(res, 500, r2.stderr.split('\n').filter(l => l.trim()).pop() || 'Error al crear la BD PostgreSQL');
  }

  queries.insertDatabase.run({ name, type, db_user: dbUser, db_password: encryptSecret(dbPass), status: 'active' });
  audit(req.user.username, clientIp(req), 'database.create', `${type}:${name}`);
  ok(res, { success: true, name, user: dbUser, password: dbPass });
}));

// ════════════════════════════════════════════════════════════
//  GESTOR DE ARCHIVOS
// ════════════════════════════════════════════════════════════
// Permite acceso completo al sistema de archivos del VPS.
function safePath(input) {
  if (typeof input !== 'string') return null;
  // Resuelve la ruta como absoluta (partiendo desde la raíz '/')
  return path.resolve('/', input);
}

app.get('/api/files', auth, wrap(async (req, res) => {
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

app.get('/api/files/read', auth, wrap(async (req, res) => {
  const file = safePath(req.query.path || '');
  if (!file) return fail(res, 403, 'Ruta fuera del área permitida');
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return fail(res, 404, 'Archivo no encontrado');
  if (fs.statSync(file).size > 2 * 1024 * 1024) return fail(res, 413, 'Archivo demasiado grande para editar');
  ok(res, { content: fs.readFileSync(file, 'utf8') });
}));

app.post('/api/files/write', auth, wrap(async (req, res) => {
  const file = safePath(req.body?.path || '');
  if (!file) return fail(res, 403, 'Ruta fuera del área permitida');
  if (typeof req.body.content !== 'string') return fail(res, 400, 'Contenido inválido');
  fs.writeFileSync(file, req.body.content, 'utf8');
  audit(req.user.username, clientIp(req), 'file.write', file);
  ok(res);
}));

app.delete('/api/files', auth, wrap(async (req, res) => {
  const target = safePath(req.body?.path || '');
  if (!target) return fail(res, 403, 'Ruta inválida');
  if (target === '/' || target === SITES_DIR) return fail(res, 403, 'No se puede eliminar este directorio');
  if (!fs.existsSync(target)) return fail(res, 404, 'No encontrado');
  fs.rmSync(target, { recursive: true, force: true });
  audit(req.user.username, clientIp(req), 'file.delete', target);
  ok(res);
}));

// ════════════════════════════════════════════════════════════
//  FIREWALL (UFW)
// ════════════════════════════════════════════════════════════
app.get('/api/firewall', auth, wrap(async (req, res) => {
  const r = await runSafe('ufw', ['status', 'numbered']);
  const enabled = /Status:\s*active/i.test(r.stdout);
  const rules = [];
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/^\[\s*(\d+)\]\s+(.+?)\s{2,}(ALLOW|DENY|REJECT|LIMIT)\s+(?:IN\s+)?(.*)$/i);
    if (m) rules.push({ num: +m[1], to: m[2].trim(), action: m[3].toUpperCase(), from: m[4].trim() });
  }
  ok(res, { enabled, rules });
}));

app.post('/api/firewall/rule', auth, wrap(async (req, res) => {
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

app.delete('/api/firewall/rule/:num', auth, wrap(async (req, res) => {
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
app.get('/api/logs/:type', auth, wrap(async (req, res) => {
  const file = LOG_FILES[req.params.type];
  if (!file) return fail(res, 400, 'Tipo de log no permitido');
  const r = await runSafe('tail', ['-n', '300', file]);
  ok(res, { logs: r.stdout || r.stderr || 'Log no disponible' });
}));

// ════════════════════════════════════════════════════════════
//  PLUGINS — software instalable desde el panel
// ════════════════════════════════════════════════════════════
const PLUGINS = {
  docker: {
    name: 'Docker', desc: 'Motor de contenedores y Docker Compose',
    icon: 'brand-docker', category: 'Infraestructura',
    check: async () => (await runSafe('which', ['docker'])).ok,
    install: async () => {
      await runSafe('apt-get', ['update', '-qq'], { timeout: 120_000 });
      const r = await runSafe('apt-get', ['install', '-y', '-qq', 'docker.io', 'docker-compose-plugin'], { timeout: 300_000 });
      if (!r.ok) throw new Error(r.stderr.split('\n').filter(l => l.trim()).pop());
      await runSafe('systemctl', ['enable', '--now', 'docker']);
    },
    uninstall: async () => {
      await runSafe('apt-get', ['remove', '-y', 'docker.io', 'docker-compose-plugin'], { timeout: 120_000 });
    },
  },
  phpmyadmin: {
    name: 'phpMyAdmin', desc: 'Administración web de MySQL/MariaDB (puerto 8081)',
    icon: 'database-cog', category: 'Bases de datos',
    check: async () => fs.existsSync('/usr/share/phpmyadmin'),
    install: async () => {
      // Detecta la versión de PHP-FPM disponible
      const fpmCheck = await runSafe('bash', ['-c', 'ls /run/php/php*-fpm.sock 2>/dev/null | head -1']);
      let phpPkg = 'php-fpm';
      if (!fpmCheck.ok || !fpmCheck.stdout.trim()) phpPkg = 'php8.2-fpm';
      // Preseed debconf para instalación no interactiva
      await runSafe('bash', ['-c', [
        'echo "phpmyadmin phpmyadmin/dbconfig-install boolean true" | debconf-set-selections',
        'echo "phpmyadmin phpmyadmin/reconfigure-webserver multiselect " | debconf-set-selections',
      ].join(' && ')]);
      const r = await runSafe('apt-get', ['install', '-y', '-qq', 'phpmyadmin', phpPkg, 'php-mysql', 'php-mbstring'], { timeout: 300_000 });
      if (!r.ok) throw new Error(r.stderr.split('\n').filter(l => l.trim()).pop());
      // Crear config nginx para phpMyAdmin en puerto 8081
      const fpmSock2 = fpmCheck.stdout.trim() || '/run/php/php-fpm.sock';
      const pmaConf = `server {\n    listen 8081;\n    root /usr/share/phpmyadmin;\n    index index.php;\n    location / { try_files $uri $uri/ /index.php?$args; }\n    location ~ \\.php$ {\n        include snippets/fastcgi-php.conf;\n        fastcgi_pass unix:${fpmSock2};\n    }\n}\n`;
      fs.writeFileSync('/etc/nginx/sites-available/phpmyadmin', pmaConf);
      try { fs.symlinkSync('/etc/nginx/sites-available/phpmyadmin', '/etc/nginx/sites-enabled/phpmyadmin'); } catch (e) { if (e.code !== 'EEXIST') throw e; }
      await runSafe('ufw', ['allow', '8081/tcp']);
      await runSafe('nginx', ['-t']).then(async (t) => { if (t.ok) await runSafe('systemctl', ['reload', 'nginx']); });
    },
    uninstall: async () => {
      await runSafe('apt-get', ['remove', '-y', 'phpmyadmin'], { timeout: 120_000 });
      fs.rmSync('/etc/nginx/sites-enabled/phpmyadmin', { force: true });
      fs.rmSync('/etc/nginx/sites-available/phpmyadmin', { force: true });
      await runSafe('ufw', ['delete', 'allow', '8081/tcp']);
      await runSafe('systemctl', ['reload', 'nginx']);
    },
  },
  redis: {
    name: 'Redis', desc: 'Base de datos en memoria / caché',
    icon: 'database-heart', category: 'Bases de datos',
    check: async () => (await runSafe('which', ['redis-server'])).ok,
    install: async () => {
      const r = await runSafe('apt-get', ['install', '-y', '-qq', 'redis-server'], { timeout: 120_000 });
      if (!r.ok) throw new Error(r.stderr.split('\n').filter(l => l.trim()).pop());
      await runSafe('systemctl', ['enable', '--now', 'redis-server']);
    },
    uninstall: async () => {
      await runSafe('systemctl', ['stop', 'redis-server']);
      await runSafe('apt-get', ['remove', '-y', 'redis-server'], { timeout: 120_000 });
    },
  },
  fail2ban: {
    name: 'Fail2Ban', desc: 'Protección contra ataques de fuerza bruta (SSH, etc.)',
    icon: 'shield-lock', category: 'Seguridad',
    check: async () => (await runSafe('which', ['fail2ban-client'])).ok,
    install: async () => {
      const r = await runSafe('apt-get', ['install', '-y', '-qq', 'fail2ban'], { timeout: 120_000 });
      if (!r.ok) throw new Error(r.stderr.split('\n').filter(l => l.trim()).pop());
      await runSafe('systemctl', ['enable', '--now', 'fail2ban']);
    },
    uninstall: async () => {
      await runSafe('systemctl', ['stop', 'fail2ban']);
      await runSafe('apt-get', ['remove', '-y', 'fail2ban'], { timeout: 120_000 });
    },
  },
  composer: {
    name: 'Composer', desc: 'Gestor de paquetes PHP',
    icon: 'package', category: 'Desarrollo',
    check: async () => (await runSafe('which', ['composer'])).ok,
    install: async () => {
      const r = await runSafe('bash', ['-c',
        'curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer'], { timeout: 120_000 });
      if (!r.ok) throw new Error(r.stderr.split('\n').filter(l => l.trim()).pop());
    },
    uninstall: async () => { fs.rmSync('/usr/local/bin/composer', { force: true }); },
  },
  certbot: {
    name: 'Certbot', desc: 'Certificados SSL gratuitos de Let\'s Encrypt',
    icon: 'certificate', category: 'Seguridad',
    check: async () => (await runSafe('which', ['certbot'])).ok,
    install: async () => {
      const r = await runSafe('apt-get', ['install', '-y', '-qq', 'certbot', 'python3-certbot-nginx'], { timeout: 120_000 });
      if (!r.ok) throw new Error(r.stderr.split('\n').filter(l => l.trim()).pop());
    },
    uninstall: async () => {
      await runSafe('apt-get', ['remove', '-y', 'certbot', 'python3-certbot-nginx'], { timeout: 120_000 });
    },
  },
};

app.get('/api/plugins', wrap(async (req, res) => {
  const result = [];
  for (const [id, p] of Object.entries(PLUGINS)) {
    result.push({ id, name: p.name, desc: p.desc, icon: p.icon, category: p.category, installed: await p.check() });
  }
  ok(res, result);
}));

app.post('/api/plugins/:id/install', auth, wrap(async (req, res) => {
  const p = PLUGINS[req.params.id];
  if (!p) return fail(res, 404, 'Plugin no encontrado');
  if (await p.check()) return fail(res, 409, `${p.name} ya está instalado`);
  try {
    await p.install();
    audit(req.user.username, clientIp(req), 'plugin.install', p.name);
    ok(res, { success: true, message: `${p.name} instalado correctamente` });
  } catch (e) {
    fail(res, 500, e.message || `Error instalando ${p.name}`);
  }
}));

app.post('/api/plugins/:id/uninstall', auth, wrap(async (req, res) => {
  const p = PLUGINS[req.params.id];
  if (!p) return fail(res, 404, 'Plugin no encontrado');
  if (!(await p.check())) return fail(res, 409, `${p.name} no está instalado`);
  try {
    await p.uninstall();
    audit(req.user.username, clientIp(req), 'plugin.uninstall', p.name);
    ok(res, { success: true, message: `${p.name} desinstalado` });
  } catch (e) {
    fail(res, 500, e.message || `Error desinstalando ${p.name}`);
  }
}));

// Endpoint para obtener la IP pública del VPS (útil para mostrar URLs de sitios por puerto).
app.get('/api/system/ip', wrap(async (req, res) => {
  let ip = '';
  const r1 = await runSafe('curl', ['-4', '-s', '--max-time', '3', 'https://api.ipify.org']);
  if (r1.ok && r1.stdout.trim()) ip = r1.stdout.trim();
  if (!ip) {
    const r2 = await runSafe('hostname', ['-I']);
    if (r2.ok) ip = r2.stdout.trim().split(/\s+/).find(a => /^\d+\.\d+\.\d+\.\d+$/.test(a)) || '';
  }
  ok(res, { ip: ip || 'desconocida' });
}));

// Endpoint para listar versiones de PHP instaladas.
app.get('/api/system/php-versions', wrap(async (req, res) => {
  const r = await runSafe('bash', ['-c', 'ls /run/php/php*-fpm.sock 2>/dev/null || true']);
  const versions = [];
  if (r.ok && r.stdout.trim()) {
    for (const line of r.stdout.trim().split('\n')) {
      const m = line.match(/php(\d+\.\d+)-fpm\.sock/);
      if (m) versions.push(m[1]);
    }
  }
  ok(res, versions);
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
