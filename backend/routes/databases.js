'use strict';

const fs = require('fs');
const express = require('express');
const { ok, fail, clientIp, runSafe, wrap } = require('../lib/helpers');
const { RE_APP_NAME, RE_DB_USER } = require('../lib/validators');
const { encryptSecret, decryptSecret, genPassword } = require('../lib/crypto');
const nginx = require('../lib/nginx');
const { queries, audit } = require('../database');

const router = express.Router();

// Ejecuta SQL en MySQL/MariaDB probando varios métodos de autenticación:
// 1) root por socket (proceso root), 2) sudo (auth_socket), 3) debian-sys-maint,
// 4) contraseña root desde .env (MYSQL_ROOT_PASSWORD).
async function mysqlExec(sql) {
  let last = await runSafe('mysql', ['-e', sql]);
  if (last.ok) return last;

  const sudo = await runSafe('sudo', ['-n', 'mysql', '-e', sql]);
  if (sudo.ok) return sudo; last = sudo;

  if (fs.existsSync('/etc/mysql/debian.cnf')) {
    const deb = await runSafe('sudo', ['-n', 'mysql', '--defaults-file=/etc/mysql/debian.cnf', '-e', sql]);
    if (deb.ok) return deb; last = deb;
  }

  if (process.env.MYSQL_ROOT_PASSWORD) {
    const pw = await runSafe('mysql', ['-u', 'root', `-p${process.env.MYSQL_ROOT_PASSWORD}`, '-e', sql]);
    if (pw.ok) return pw; last = pw;
  }
  return last;
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

  // Usuario: el que indique el usuario, o uno automático
  const dbUser = (user && user.trim()) ? user.trim() : `txpl_${name}`;
  if (!RE_DB_USER.test(dbUser)) return fail(res, 400, 'Usuario inválido (solo letras, números y _, máx 32)');

  // Contraseña: la que indique el usuario, o una generada. Sin caracteres que rompan el SQL.
  let dbPass;
  if (password && String(password).length) {
    if (!/^[^'"\\]{4,128}$/.test(String(password))) return fail(res, 400, 'Contraseña inválida (mín 4 caracteres, sin comillas ni \\)');
    dbPass = String(password);
  } else {
    dbPass = genPassword();
  }

  if (type === 'mysql') {
    const cmds = [
      `CREATE DATABASE IF NOT EXISTS \`${name}\`;`,
      `CREATE USER IF NOT EXISTS '${dbUser}'@'localhost' IDENTIFIED BY '${dbPass}';`,
      // ALTER garantiza que la contraseña coincida aunque el usuario ya existiera
      `ALTER USER '${dbUser}'@'localhost' IDENTIFIED BY '${dbPass}';`,
      `GRANT ALL PRIVILEGES ON \`${name}\`.* TO '${dbUser}'@'localhost';`,
      'FLUSH PRIVILEGES;',
    ];
    for (const sql of cmds) {
      const r = await mysqlExec(sql);
      if (!r.ok) {
        const detail = (r.stderr || '').split('\n').find((l) => /error|denied|not found|command/i.test(l)) || (r.stderr || '').split('\n')[0] || 'fallo desconocido';
        return fail(res, 500, 'Error MySQL: ' + detail + ' — verifica que MySQL/MariaDB esté instalado y que el panel pueda acceder (auth_socket o MYSQL_ROOT_PASSWORD en .env).');
      }
    }
  } else {
    let r = await runSafe('sudo', ['-u', 'postgres', 'psql', '-c', `CREATE USER ${dbUser} WITH PASSWORD '${dbPass}';`]);
    if (!r.ok && !r.stderr.includes('already exists')) return fail(res, 500, 'Error PG: ' + r.stderr.split('\n')[0]);
    r = await runSafe('sudo', ['-u', 'postgres', 'psql', '-c', `CREATE DATABASE ${name} OWNER ${dbUser};`]);
    if (!r.ok && !r.stderr.includes('already exists')) return fail(res, 500, 'Error PG: ' + r.stderr.split('\n')[0]);
  }

  const enc = encryptSecret(dbPass);
  queries.insertDatabase.run({ name, type, db_user: dbUser, db_password: enc, status: 'active' });
  audit(req.user.username, clientIp(req), 'db.create', name);
  ok(res, { success: true, user: dbUser, password: dbPass });
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

router.get('/phpmyadmin/status', (req, res) => {
  const installed = fs.existsSync(PMA_DIR);
  const configured = fs.existsSync(PMA_LINK);
  ok(res, { installed, configured, port: PMA_PORT });
});

router.post('/phpmyadmin/setup', wrap(async (req, res) => {
  if (!fs.existsSync(PMA_DIR)) return fail(res, 400, 'phpMyAdmin no está instalado. Instálalo primero desde Plugins.');

  // 1. Asegurar php-fpm
  let sock = detectPhpFpmSock();
  if (!sock) {
    await runSafe('apt-get', ['install', '-y', 'php-fpm', 'php-mysql'], { timeout: 300_000 });
    sock = detectPhpFpmSock();
  }
  if (!sock) return fail(res, 500, 'No se encontró PHP-FPM tras instalarlo. Revisa la instalación de PHP.');

  // 2. Escribir y activar el vhost de nginx (valida y revierte si falla).
  try {
    await nginx.enableSite('txpl-phpmyadmin', nginx.buildPhpFpmSite(PMA_PORT, PMA_DIR, sock));
  } catch (e) {
    return fail(res, 500, e.message);
  }
  await runSafe('ufw', ['allow', `${PMA_PORT}/tcp`]);

  audit(req.user.username, clientIp(req), 'phpmyadmin.setup', `puerto ${PMA_PORT}`);
  ok(res, { success: true, port: PMA_PORT });
}));

// ── Adminer: gestor ligero para MySQL Y PostgreSQL ───────────
const ADMINER_DIR = '/usr/share/adminer';
const ADMINER_FILE = ADMINER_DIR + '/index.php';
const ADMINER_PORT = 8082;
const ADMINER_CONF = '/etc/nginx/sites-available/txpl-adminer';
const ADMINER_LINK = '/etc/nginx/sites-enabled/txpl-adminer';

router.get('/adminer/status', (req, res) => {
  ok(res, { installed: fs.existsSync(ADMINER_FILE), configured: fs.existsSync(ADMINER_LINK), port: ADMINER_PORT });
});

router.delete('/:id', wrap(async (req, res) => {
  const db = queries.getDatabase.get(+req.params.id);
  if (!db) return fail(res, 404, 'DB no encontrada');

  if (db.type === 'mysql') {
    await mysqlExec(`DROP DATABASE IF EXISTS \`${db.name}\`;`);
    await mysqlExec(`DROP USER IF EXISTS '${db.db_user}'@'localhost';`);
  } else {
    await runSafe('sudo', ['-u', 'postgres', 'psql', '-c', `DROP DATABASE IF EXISTS ${db.name};`]);
    await runSafe('sudo', ['-u', 'postgres', 'psql', '-c', `DROP USER IF EXISTS ${db.db_user};`]);
  }
  queries.deleteDatabase.run(db.id);
  audit(req.user.username, clientIp(req), 'db.delete', db.name);
  ok(res);
}));

router.get('/:id/password', (req, res) => {
  const db = queries.getDatabase.get(+req.params.id);
  if (!db) return fail(res, 404, 'DB no encontrada');
  try {
    const pass = decryptSecret(db.db_password);
    ok(res, { password: pass });
  } catch (_) { fail(res, 500, 'No se pudo descifrar la contraseña'); }
});

module.exports = router;
