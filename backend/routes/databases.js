'use strict';

const express = require('express');
const { ok, fail, clientIp, runSafe, wrap } = require('../lib/helpers');
const { RE_APP_NAME } = require('../lib/validators');
const { encryptSecret, decryptSecret, genPassword } = require('../lib/crypto');
const { queries, audit } = require('../database');

const router = express.Router();

router.get('/', (req, res) => {
  const rows = queries.listDatabases.all().map((d) => ({
    id: d.id, name: d.name, type: d.type, db_user: d.db_user, created_at: d.created_at,
  }));
  ok(res, rows);
});

router.post('/', wrap(async (req, res) => {
  const { name, type = 'mysql' } = req.body || {};
  if (!RE_APP_NAME.test(name || '')) return fail(res, 400, 'Nombre inválido');
  if (!['mysql', 'postgres'].includes(type)) return fail(res, 400, 'Tipo inválido');
  if (queries.getDatabaseByName.get(name)) return fail(res, 409, 'Ya existe');

  const dbUser = `txpl_${name}`;
  const dbPass = genPassword();

  if (type === 'mysql') {
    const cmds = [
      `CREATE DATABASE IF NOT EXISTS \`${name}\`;`,
      `CREATE USER IF NOT EXISTS '${dbUser}'@'localhost' IDENTIFIED BY '${dbPass}';`,
      `GRANT ALL PRIVILEGES ON \`${name}\`.* TO '${dbUser}'@'localhost';`,
      'FLUSH PRIVILEGES;',
    ];
    for (const sql of cmds) {
      const r = await runSafe('mysql', ['-e', sql]);
      if (!r.ok) return fail(res, 500, 'Error MySQL: ' + r.stderr.split('\n')[0]);
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

router.delete('/:id', wrap(async (req, res) => {
  const db = queries.getDatabase.get(+req.params.id);
  if (!db) return fail(res, 404, 'DB no encontrada');

  if (db.type === 'mysql') {
    await runSafe('mysql', ['-e', `DROP DATABASE IF EXISTS \`${db.name}\`;`]);
    await runSafe('mysql', ['-e', `DROP USER IF EXISTS '${db.db_user}'@'localhost';`]);
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
