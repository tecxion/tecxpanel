'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const { ok, fail, clientIp, runSafe, wrap } = require('../lib/helpers');
const { runInput } = require('../lib/common/run');
const { RE_APP_NAME, RE_DB_USER, isValidDomain } = require('../lib/validators');
const { encryptSecret, decryptSecret, genPassword } = require('../lib/crypto');
const nginx = require('../lib/nginx');
const { queries, audit } = require('../database');

const router = express.Router();

// Ejecuta SQL en MySQL/MariaDB probando varios métodos de autenticación.
// SEGURIDAD: el SQL viaja por STDIN (no como -e "...") y la password root va
// por env (MYSQL_PWD), nunca en argv — así no aparece en `ps aux`.
// Métodos: 1) socket root · 2) sudo auth_socket · 3) /etc/mysql/debian.cnf
// · 4) MYSQL_ROOT_PASSWORD del .env. Devuelve además `.method` para diagnóstico.
async function mysqlExec(sql) {
  const attempts = [
    { method: 'root-socket', cmd: 'mysql', args: [], env: {} },
    { method: 'sudo-socket', cmd: 'sudo',  args: ['-n', 'mysql'], env: {} },
  ];
  if (fs.existsSync('/etc/mysql/debian.cnf')) {
    attempts.push({ method: 'debian-maint', cmd: 'sudo', args: ['-n', 'mysql', '--defaults-file=/etc/mysql/debian.cnf'], env: {} });
  }
  if (process.env.MYSQL_ROOT_PASSWORD) {
    attempts.push({ method: 'env-password', cmd: 'mysql', args: ['-u', 'root'], env: { MYSQL_PWD: process.env.MYSQL_ROOT_PASSWORD } });
  }

  let last = null;
  for (const a of attempts) {
    const env = { PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', ...a.env };
    const r = await runInput(a.cmd, a.args, sql, { env, timeout: 60_000 });
    if (r.ok) { r.method = a.method; return r; }
    last = { ...r, method: a.method };
  }
  return last || { ok: false, stdout: '', stderr: 'sin métodos de acceso disponibles', method: 'none' };
}

// Ejecuta SQL en PostgreSQL como usuario 'postgres' con SQL por stdin.
// Usa sudo -u postgres (peer auth) — no requiere PGPASSWORD.
async function pgExec(sql) {
  const env = { PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' };
  return runInput('sudo', ['-n', '-u', 'postgres', 'psql', '-v', 'ON_ERROR_STOP=1'], sql, { env, timeout: 60_000 });
}

// Duplica la comilla simple (defensa en profundidad: el validador ya rechaza ').
function sqlLit(s) { return String(s).replace(/'/g, "''"); }

// Password aceptada: 8..128 imprimibles, sin comillas/backticks/;/\ ni control.
function isSafePassword(p) {
  return typeof p === 'string' && p.length >= 8 && p.length <= 128 && /^[!-~]+$/.test(p) && !/['"`;\\]/.test(p);
}

router.get('/', (req, res) => {
  const rows = queries.listDatabases.all().map((d) => ({
    id: d.id, name: d.name, type: d.type, db_user: d.db_user, created_at: d.created_at,
  }));
  ok(res, rows);
});

router.post('/', wrap(async (req, res) => {
  const { name, type = 'mysql', user, password } = req.body || {};
  if (!RE_APP_NAME.test(name || '')) return fail(res, 400, 'Nombre inválido');
  if (!['mysql', 'postgresql'].includes(type)) return fail(res, 400, 'Tipo inválido');
  if (queries.getDatabaseByName.get(name)) return fail(res, 409, 'Ya existe');

  const dbUser = (user && user.trim()) ? user.trim() : `txpl_${name}`;
  if (!RE_DB_USER.test(dbUser)) return fail(res, 400, 'Usuario inválido (solo letras, números y _, máx 32)');

  let dbPass;
  if (password && String(password).length) {
    if (!isSafePassword(String(password))) return fail(res, 400, 'Contraseña inválida (8-128 caracteres imprimibles, sin comillas, backticks, ;, \\)');
    dbPass = String(password);
  } else {
    dbPass = genPassword(24);
  }
  const pw = sqlLit(dbPass);

  if (type === 'mysql') {
    // Un solo batch por stdin — más rápido y con detección clara de errores.
    const sql = [
      `CREATE DATABASE IF NOT EXISTS \`${name}\`;`,
      `CREATE USER IF NOT EXISTS '${dbUser}'@'localhost' IDENTIFIED BY '${pw}';`,
      `ALTER USER '${dbUser}'@'localhost' IDENTIFIED BY '${pw}';`,
      `GRANT ALL PRIVILEGES ON \`${name}\`.* TO '${dbUser}'@'localhost';`,
      'FLUSH PRIVILEGES;',
    ].join('\n');
    const r = await mysqlExec(sql);
    if (!r.ok) {
      const detail = (r.stderr || '').split('\n').find((l) => /error|denied|not found|command/i.test(l)) || (r.stderr || '').split('\n')[0] || 'fallo desconocido';
      return fail(res, 500, `Error MySQL [${r.method || 'sin-metodo'}]: ${detail} — usa GET /api/databases/mysql/status para diagnosticar (auth_socket, sudo o MYSQL_ROOT_PASSWORD en .env).`);
    }
  } else {
    // PostgreSQL: identificadores entrecomillados y contraseña por stdin.
    const sql = `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${dbUser}') THEN CREATE ROLE "${dbUser}" LOGIN PASSWORD '${pw}'; ELSE ALTER ROLE "${dbUser}" WITH PASSWORD '${pw}'; END IF; END $$;\n` +
                `SELECT 'CREATE DATABASE "${name}" OWNER "${dbUser}"' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${name}') \\gexec\n`;
    const r = await pgExec(sql);
    if (!r.ok) return fail(res, 500, 'Error PostgreSQL: ' + (r.stderr.split('\n')[0] || 'fallo desconocido'));
  }

  const enc = encryptSecret(dbPass);
  queries.insertDatabase.run({ name, type, db_user: dbUser, db_password: enc, status: 'active' });
  audit(req.user.username, clientIp(req), 'db.create', name);
  ok(res, { success: true, user: dbUser, password: dbPass });
}));

// GET /api/databases/mysql/status — Diagnóstico: qué método de acceso funciona
// y por qué fallan los otros. Útil para depurar el clásico ERROR 1045.
router.get('/mysql/status', wrap(async (req, res) => {
  const r = await mysqlExec('SELECT VERSION() AS version;');
  if (r.ok) {
    const version = (r.stdout.split('\n').find((l) => l && !/version/i.test(l)) || '').trim();
    return ok(res, { success: true, working: true, method: r.method, version, hint: null });
  }
  const hasEnvPw = !!process.env.MYSQL_ROOT_PASSWORD;
  const hasDebianCnf = fs.existsSync('/etc/mysql/debian.cnf');
  let hint = 'MySQL/MariaDB no accesible desde el panel. ';
  if (!hasEnvPw && !hasDebianCnf) hint += 'Añade MYSQL_ROOT_PASSWORD a tu .env o instala/repara MariaDB (auth_socket para root).';
  else if (hasEnvPw) hint += 'MYSQL_ROOT_PASSWORD está en .env pero no autentica — verifica la contraseña real de root.';
  else hint += 'Existe /etc/mysql/debian.cnf pero sudo -n falla — el usuario del panel necesita permiso sudo sin contraseña para mysql.';
  ok(res, { success: true, working: false, method: r.method, error: (r.stderr || '').split('\n')[0], hint, hasEnvPw, hasDebianCnf });
}));

// GET /api/databases/postgres/status — Igual pero para PostgreSQL.
router.get('/postgres/status', wrap(async (req, res) => {
  const r = await pgExec('SELECT version();');
  if (r.ok) return ok(res, { success: true, working: true, version: r.stdout.split('\n')[2]?.trim() || null });
  ok(res, { success: true, working: false, error: (r.stderr || '').split('\n')[0], hint: 'PostgreSQL no accesible. Instala postgresql y verifica que el usuario del panel tenga "sudo -n -u postgres psql" permitido.' });
}));

// ── phpMyAdmin: servirlo por nginx en un puerto dedicado ──────
const PMA_DIR = '/usr/share/phpmyadmin';
const PMA_PORT = 8081;
const PMA_CONF = '/etc/nginx/sites-available/txpl-phpmyadmin';
const PMA_LINK = '/etc/nginx/sites-enabled/txpl-phpmyadmin';

function detectPhpFpmSock() {
  try {
    const socks = fs.readdirSync('/run/php').filter((f) => f.endsWith('.sock') && f.includes('fpm'));
    if (socks.length) {
      socks.sort().reverse(); // versión más alta primero
      return '/run/php/' + socks[0];
    }
  } catch (_) {}
  return null;
}

// ── Adminer: gestor ligero para MySQL Y PostgreSQL ───────────
const ADMINER_DIR = '/usr/share/adminer';
const ADMINER_FILE = ADMINER_DIR + '/index.php';
const ADMINER_PORT = 8082;
const ADMINER_CONF = '/etc/nginx/sites-available/txpl-adminer';
const ADMINER_LINK = '/etc/nginx/sites-enabled/txpl-adminer';

// Descriptor de cada herramienta web. Separamos DOS vhosts por herramienta:
//   - <site>       → bloque de IP:puerto (100% del panel; se reescribe libre).
//   - <site>-web   → bloque de dominio (lo gestiona certbot al emitir SSL).
// Así el botón "HTTPS en el puerto" solo toca <site> y nunca pisa a certbot.
const TOOLS = {
  phpmyadmin: { site: 'txpl-phpmyadmin', label: 'phpMyAdmin', dir: PMA_DIR, fileCheck: PMA_DIR, port: PMA_PORT, conf: PMA_CONF, link: PMA_LINK, notInstalled: 'phpMyAdmin no está instalado. Instálalo primero desde Plugins.' },
  adminer:    { site: 'txpl-adminer',    label: 'Adminer',    dir: ADMINER_DIR, fileCheck: ADMINER_FILE, port: ADMINER_PORT, conf: ADMINER_CONF, link: ADMINER_LINK, notInstalled: 'Adminer no está instalado. Instálalo primero desde Plugins.' },
};
const webAvail = (site) => `/etc/nginx/sites-available/${site}-web`;

// Lee el server_name del vhost de dominio (ignora el "_" del bloque de puerto).
function confDomain(confPath) {
  try {
    const m = fs.readFileSync(confPath, 'utf8').match(/server_name\s+([^;\s_][^;\s]*)\s*;/);
    return m ? m[1] : null;
  } catch (_) { return null; }
}
// ¿El bloque del puerto está sirviendo HTTPS? (listen NNNN ssl)
function portIsSsl(confPath) {
  try { return /listen\s+\d+\s+ssl/.test(fs.readFileSync(confPath, 'utf8')); } catch (_) { return false; }
}

function toolStatus(t) {
  const installed = fs.existsSync(t.fileCheck);
  const configured = fs.existsSync(t.link);
  const domain = confDomain(webAvail(t.site));
  const ssl = domain ? fs.existsSync(`/etc/letsencrypt/live/${domain}/fullchain.pem`) : false;
  return { installed, configured, port: t.port, domain, ssl, portSsl: portIsSsl(t.conf) };
}

// Configura el acceso web: bloque de puerto (HTTP) siempre y, si se indica
// dominio válido, ADEMÁS bloque de dominio + certbot (SSL). Idempotente.
async function setupPhpTool(t, req, res) {
  if (!fs.existsSync(t.fileCheck)) return fail(res, 400, t.notInstalled);

  const domain = (req.body?.domain || '').trim();
  if (domain && !isValidDomain(domain)) return fail(res, 400, 'Dominio inválido (ej. adminer.tudominio.es)');

  let sock = detectPhpFpmSock();
  if (!sock) {
    await runSafe('apt-get', ['install', '-y', 'php-fpm', 'php-mysql', 'php-pgsql'], { timeout: 300_000 });
    sock = detectPhpFpmSock();
  }
  if (!sock) return fail(res, 500, 'No se encontró PHP-FPM tras instalarlo. Revisa la instalación de PHP.');

  // Bloque de PUERTO (HTTP por defecto).
  try {
    await nginx.enableSite(t.site, nginx.buildPhpFpmSite(t.port, t.dir, sock));
  } catch (e) {
    return fail(res, 500, e.message);
  }
  await runSafe('ufw', ['allow', `${t.port}/tcp`]);

  const host = req.headers.host ? req.headers.host.split(':')[0] : null;
  const portUrl = host ? `http://${host}:${t.port}` : `http://IP:${t.port}`;

  // Bloque de DOMINIO (fichero aparte) + SSL con certbot.
  let ssl = false, sslMsg = null;
  if (domain) {
    try {
      await nginx.enableSite(`${t.site}-web`, nginx.buildPhpFpmDomain(domain, t.dir, sock));
      await nginx.installSsl(domain);
      ssl = fs.existsSync(`/etc/letsencrypt/live/${domain}/fullchain.pem`);
    } catch (e) {
      sslMsg = 'El vhost quedó activo, pero certbot no pudo emitir el certificado: ' + (e.message || '') + ' Comprueba que el DNS de ' + domain + ' apunta a este servidor y reintenta. Mientras, entra por ' + portUrl + '.';
    }
  }
  audit(req.user.username, clientIp(req), `${t.site}.setup`, (domain ? domain + (ssl ? ' (SSL)' : ' (HTTP)') + ' + ' : '') + `puerto ${t.port}`);
  ok(res, {
    success: true, port: t.port, domain: domain || null, ssl, portSsl: false,
    portUrl, domainUrl: domain ? `${ssl ? 'https' : 'http'}://${domain}` : null, message: sslMsg,
  });
}

// Activa/desactiva HTTPS en el bloque del PUERTO reutilizando el certificado
// del dominio ya configurado. Requiere que la herramienta tenga dominio+cert.
// OJO: con HTTPS activo, http://IP:puerto deja de funcionar (usa https://dominio:puerto).
async function togglePortSsl(t, req, res) {
  const enabled = req.body?.enabled !== false; // por defecto true
  if (!fs.existsSync(t.link)) return fail(res, 400, `${t.label} no está configurado todavía.`);
  const domain = confDomain(webAvail(t.site));
  if (enabled) {
    if (!domain) return fail(res, 400, `Para poner HTTPS en el puerto, ${t.label} necesita primero un dominio con certificado (usa "configurar" e indica un subdominio).`);
    if (!fs.existsSync(`/etc/letsencrypt/live/${domain}/fullchain.pem`)) return fail(res, 400, `No hay certificado para ${domain} todavía. Emítelo configurando el dominio.`);
  }
  let sock = detectPhpFpmSock();
  if (!sock) return fail(res, 500, 'PHP-FPM no disponible.');
  try {
    await nginx.enableSite(t.site, nginx.buildPhpFpmSite(t.port, t.dir, sock, enabled ? { sslCertDomain: domain } : {}));
  } catch (e) {
    return fail(res, 500, e.message);
  }
  audit(req.user.username, clientIp(req), `${t.site}.port-ssl`, enabled ? `on (${domain})` : 'off');
  const urlHost = enabled && domain ? domain : (req.headers.host ? req.headers.host.split(':')[0] : 'IP');
  ok(res, { success: true, portSsl: enabled, portUrl: `${enabled ? 'https' : 'http'}://${urlHost}:${t.port}` });
}

router.get('/phpmyadmin/status', (req, res) => ok(res, toolStatus(TOOLS.phpmyadmin)));
router.post('/phpmyadmin/setup', wrap((req, res) => setupPhpTool(TOOLS.phpmyadmin, req, res)));
router.post('/phpmyadmin/port-ssl', wrap((req, res) => togglePortSsl(TOOLS.phpmyadmin, req, res)));

router.get('/adminer/status', (req, res) => ok(res, toolStatus(TOOLS.adminer)));
router.post('/adminer/setup', wrap((req, res) => setupPhpTool(TOOLS.adminer, req, res)));
router.post('/adminer/port-ssl', wrap((req, res) => togglePortSsl(TOOLS.adminer, req, res)));

router.delete('/:id', wrap(async (req, res) => {
  const db = queries.getDatabase.get(+req.params.id);
  if (!db) return fail(res, 404, 'DB no encontrada');

  if (db.type === 'mysql') {
    await mysqlExec(`DROP DATABASE IF EXISTS \`${db.name}\`;\nDROP USER IF EXISTS '${db.db_user}'@'localhost';`);
  } else {
    await pgExec(`DROP DATABASE IF EXISTS "${db.name}";\nDROP ROLE IF EXISTS "${db.db_user}";`);
  }
  queries.deleteDatabase.run(db.id);
  audit(req.user.username, clientIp(req), 'db.delete', db.name);
  ok(res);
}));

// POST /api/databases/:id/password — Cambia la contraseña del usuario de BD.
// Si no se manda password, se genera. Se actualiza en MySQL/PG y se re-cifra.
router.post('/:id/password', wrap(async (req, res) => {
  const db = queries.getDatabase.get(+req.params.id);
  if (!db) return fail(res, 404, 'DB no encontrada');
  let newPass = req.body?.password;
  if (newPass && !isSafePassword(String(newPass))) return fail(res, 400, 'Contraseña inválida (8-128 imprimibles, sin comillas, backticks, ;, \\)');
  if (!newPass) newPass = genPassword(24);
  const pw = sqlLit(newPass);
  if (db.type === 'mysql') {
    const r = await mysqlExec(`ALTER USER '${db.db_user}'@'localhost' IDENTIFIED BY '${pw}';\nFLUSH PRIVILEGES;`);
    if (!r.ok) return fail(res, 500, 'MySQL: ' + (r.stderr.split('\n')[0] || 'fallo'));
  } else {
    const r = await pgExec(`ALTER ROLE "${db.db_user}" WITH PASSWORD '${pw}';`);
    if (!r.ok) return fail(res, 500, 'PostgreSQL: ' + (r.stderr.split('\n')[0] || 'fallo'));
  }
  queries.updateDatabasePassword.run(encryptSecret(newPass), db.id);
  audit(req.user.username, clientIp(req), 'db.password', db.name);
  ok(res, { success: true, password: newPass });
}));

// POST /api/databases/:id/test — Prueba la conexión con las credenciales guardadas.
router.post('/:id/test', wrap(async (req, res) => {
  const db = queries.getDatabase.get(+req.params.id);
  if (!db) return fail(res, 404, 'DB no encontrada');
  const pass = decryptSecret(db.db_password);
  if (pass === '(no descifrable)') return fail(res, 500, 'No se pudo descifrar la contraseña guardada. Cambia la contraseña para regenerarla.');
  const env = { PATH: process.env.PATH || '/usr/bin:/bin' };
  let r;
  if (db.type === 'mysql') {
    env.MYSQL_PWD = pass;
    r = await runInput('mysql', ['-u', db.db_user, '-h', '127.0.0.1', db.name], 'SELECT 1;', { env, timeout: 15_000 });
  } else {
    env.PGPASSWORD = pass;
    r = await runInput('psql', ['-U', db.db_user, '-h', '127.0.0.1', '-d', db.name, '-v', 'ON_ERROR_STOP=1'], 'SELECT 1;', { env, timeout: 15_000 });
  }
  ok(res, { success: true, working: r.ok, error: r.ok ? null : (r.stderr.split('\n')[0] || 'fallo') });
}));

// GET /api/databases/:id/info — Tamaño total y nº de tablas.
router.get('/:id/info', wrap(async (req, res) => {
  const db = queries.getDatabase.get(+req.params.id);
  if (!db) return fail(res, 404, 'DB no encontrada');
  if (db.type === 'mysql') {
    const r = await mysqlExec(
      `SELECT COALESCE(SUM(data_length + index_length),0) AS bytes, COUNT(*) AS tables FROM information_schema.tables WHERE table_schema = '${db.name}';`
    );
    if (!r.ok) return fail(res, 500, 'MySQL: ' + (r.stderr.split('\n')[0] || 'fallo'));
    const line = r.stdout.trim().split('\n').pop() || '';
    const [bytes, tables] = line.split(/\s+/).map((n) => parseInt(n, 10) || 0);
    return ok(res, { success: true, bytes, tables });
  } else {
    const r = await pgExec(
      `SELECT pg_database_size('${db.name}') AS bytes, (SELECT COUNT(*) FROM information_schema.tables WHERE table_catalog='${db.name}' AND table_schema='public') AS tables;`
    );
    if (!r.ok) return fail(res, 500, 'PG: ' + (r.stderr.split('\n')[0] || 'fallo'));
    const nums = (r.stdout.match(/-?\d+/g) || []).map((n) => parseInt(n, 10));
    return ok(res, { success: true, bytes: nums[0] || 0, tables: nums[1] || 0 });
  }
}));

// GET /api/databases/:id/dump — Descarga un dump SQL (mysqldump/pg_dump).
router.get('/:id/dump', wrap(async (req, res) => {
  const db = queries.getDatabase.get(+req.params.id);
  if (!db) return fail(res, 404, 'DB no encontrada');
  const pass = decryptSecret(db.db_password);
  if (pass === '(no descifrable)') return fail(res, 500, 'No se pudo descifrar la contraseña');
  const env = { PATH: process.env.PATH || '/usr/bin:/bin' };
  let r;
  if (db.type === 'mysql') {
    env.MYSQL_PWD = pass;
    r = await runInput('mysqldump', ['-u', db.db_user, '-h', '127.0.0.1', '--single-transaction', '--quick', db.name], '', { env, timeout: 0, maxBuffer: 256 * 1024 * 1024 });
  } else {
    env.PGPASSWORD = pass;
    r = await runInput('pg_dump', ['-U', db.db_user, '-h', '127.0.0.1', db.name], '', { env, timeout: 0, maxBuffer: 256 * 1024 * 1024 });
  }
  if (!r.ok) return fail(res, 500, 'Dump falló: ' + (r.stderr.split('\n')[0] || 'error'));
  audit(req.user.username, clientIp(req), 'db.dump', db.name);
  res.setHeader('Content-Type', 'application/sql');
  res.setHeader('Content-Disposition', `attachment; filename="${db.name}-${Date.now()}.sql"`);
  res.send(r.stdout);
}));

// POST /api/databases/:id/restore — Restaura desde un .sql (JSON { sql: "..." }).
router.post('/:id/restore', wrap(async (req, res) => {
  const db = queries.getDatabase.get(+req.params.id);
  if (!db) return fail(res, 404, 'DB no encontrada');
  const sql = typeof req.body === 'string' ? req.body : (req.body?.sql || '');
  if (!sql || sql.length < 4) return fail(res, 400, 'Falta el contenido SQL');
  const pass = decryptSecret(db.db_password);
  if (pass === '(no descifrable)') return fail(res, 500, 'No se pudo descifrar la contraseña');
  const env = { PATH: process.env.PATH || '/usr/bin:/bin' };
  let r;
  if (db.type === 'mysql') {
    env.MYSQL_PWD = pass;
    r = await runInput('mysql', ['-u', db.db_user, '-h', '127.0.0.1', db.name], sql, { env, timeout: 0, maxBuffer: 64 * 1024 * 1024 });
  } else {
    env.PGPASSWORD = pass;
    r = await runInput('psql', ['-U', db.db_user, '-h', '127.0.0.1', '-d', db.name, '-v', 'ON_ERROR_STOP=1'], sql, { env, timeout: 0, maxBuffer: 64 * 1024 * 1024 });
  }
  audit(req.user.username, clientIp(req), 'db.restore', `${db.name} (${sql.length} bytes)`);
  if (!r.ok) return fail(res, 500, 'Restore: ' + (r.stderr.split('\n').filter(Boolean).slice(0, 2).join(' | ') || 'fallo'));
  ok(res, { success: true, bytes: sql.length });
}));

router.get('/:id/password', (req, res) => {
  const db = queries.getDatabase.get(+req.params.id);
  if (!db) return fail(res, 404, 'DB no encontrada');
  // decryptSecret devuelve el sentinel "(no descifrable)" si la clave cambió
  // — no lanza. Chequeamos explícitamente para dar un error real al frontend.
  const pass = decryptSecret(db.db_password);
  if (pass === '(no descifrable)') return fail(res, 500, 'No se pudo descifrar la contraseña (JWT_SECRET/TXPL_SECRET_KEY cambió tras crearla). Usa "Cambiar contraseña" para regenerarla.');
  ok(res, { success: true, password: pass });
});

// ── .env: leer y escribir claves concretas ────────────────────
// Ubicación igual que en server.js: TXPL_ENV → <repo>/.env → /opt/txpl/.env.
function envPath() {
  if (process.env.TXPL_ENV) return process.env.TXPL_ENV;
  const local = path.resolve(__dirname, '../../.env');
  return fs.existsSync(local) ? local : '/opt/txpl/.env';
}

// Actualiza una clave preservando las demás líneas y comentarios. Si no
// existe, la añade. Vacío = borra el valor pero deja la línea. chmod 600.
function updateEnvKey(key, value) {
  const p = envPath();
  let text = '';
  try { text = fs.readFileSync(p, 'utf8'); } catch (_) {}
  const re = new RegExp('^' + key + '=.*$', 'm');
  const line = value == null ? `${key}=` : `${key}=${value}`;
  text = re.test(text) ? text.replace(re, line) : (text + (text.endsWith('\n') ? '' : '\n') + line + '\n');
  fs.writeFileSync(p, text, { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch (_) {}
  // Sincroniza process.env para que el cambio surta efecto en caliente.
  if (value == null || value === '') delete process.env[key];
  else process.env[key] = value;
  return p;
}

// POST /api/databases/mysql/repair — Opción A: devuelve root a unix_socket
// y limpia MYSQL_ROOT_PASSWORD del .env. Prueba primero con los métodos
// automáticos (mysqlExec); si todos fallan y el usuario mandó
// { currentPassword }, la usa como último recurso (no se guarda: se descarta
// tras el ALTER). Sin body y sin acceso disponible, devuelve 400 pidiéndola.
router.post('/mysql/repair', wrap(async (req, res) => {
  const sqlUnix = "ALTER USER 'root'@'localhost' IDENTIFIED VIA unix_socket;\nFLUSH PRIVILEGES;";
  const sqlAuth = "ALTER USER 'root'@'localhost' IDENTIFIED WITH auth_socket;\nFLUSH PRIVILEGES;";

  // 1) Métodos automáticos (los del mysqlExec)
  let r = await mysqlExec(sqlUnix);
  if (!r.ok) r = await mysqlExec(sqlAuth); // fallback MySQL 8

  // 2) Password de un solo uso (nunca se persiste)
  if (!r.ok) {
    const cp = req.body?.currentPassword;
    if (cp && typeof cp === 'string') {
      const env = { PATH: process.env.PATH || '/usr/bin:/bin', MYSQL_PWD: cp };
      r = await runInput('mysql', ['-u', 'root'], sqlUnix, { env, timeout: 30_000 });
      if (!r.ok) r = await runInput('mysql', ['-u', 'root'], sqlAuth, { env, timeout: 30_000 });
    }
  }

  if (!r.ok) {
    const detail = (r.stderr || '').split('\n')[0] || 'acceso denegado';
    // http:400 para que el frontend distinga y ofrezca pedir la password.
    return res.status(400).json({ error: `No se pudo reparar automáticamente: ${detail}. Pega la contraseña actual de root (si la sabes) o repáralo por SSH: sudo mysql → ALTER USER 'root'@'localhost' IDENTIFIED WITH auth_socket;`, needsPassword: true });
  }

  const p = updateEnvKey('MYSQL_ROOT_PASSWORD', '');
  audit(req.user.username, clientIp(req), 'db.repair', 'mysql:auth_socket');
  ok(res, { success: true, envFile: p, hint: 'Root ahora se autentica por socket. MYSQL_ROOT_PASSWORD vaciado en .env.' });
}));

// GET /api/databases/env/mysql-password — Presencia (nunca el valor real).
router.get('/env/mysql-password', (req, res) => {
  const v = process.env.MYSQL_ROOT_PASSWORD || '';
  ok(res, { success: true, set: !!v, length: v.length, envFile: envPath() });
});

// PUT /api/databases/env/mysql-password — Actualiza MYSQL_ROOT_PASSWORD.
// Body: { password: "..." } (vacío o null = borra la variable).
router.put('/env/mysql-password', wrap(async (req, res) => {
  const pass = req.body?.password;
  if (pass && !isSafePassword(String(pass))) return fail(res, 400, 'Contraseña inválida (8-128 imprimibles, sin comillas, backticks, ;, \\)');
  const p = updateEnvKey('MYSQL_ROOT_PASSWORD', pass || '');
  audit(req.user.username, clientIp(req), 'db.env.mysql-pw', pass ? `set (${String(pass).length} chars)` : 'cleared');
  ok(res, { success: true, envFile: p, set: !!pass });
}));

module.exports = router;
module.exports.mysqlExec = mysqlExec;
