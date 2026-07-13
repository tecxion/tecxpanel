'use strict';

// ============================================================
//  TecXPaneL — Motor del Catálogo de aplicaciones (efectos)
//
//  Instala/desinstala las apps del CATALOG en el modo elegido:
//  docker (socket nativo), native (PHP-FPM) o pm2. La tabla
//  catalog_installs es la fuente de la verdad; solo se escribe
//  al TERMINAR con éxito (fallo a mitad => rollback best-effort).
// ============================================================

const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { run, runSafe } = require('./helpers');
const { genPassword, encryptSecret } = require('./crypto');
const nginx = require('./nginx');
const { buildPullPath, accumulatePullProgress } = require('./n8n');
const {
  getEntry, containerName, volumeName, nginxConfName, pm2Name,
  buildAppContainerConfig, buildDbEnv, buildWpConfig, buildGhostConfig,
} = require('./catalog');
const { queries } = require('../database');

const DOCKER_SOCKET = '/var/run/docker.sock';
const APPS_DIR = '/opt/txpl-apps';
// Sin límite de tiempo para procesos largos (regla del repo).
const LONG = { timeout: 0, maxBuffer: 64 * 1024 * 1024 };

// ── Docker por el socket (mismo patrón que routes/n8n.js) ────
function dockerRequest(method, apiPath, body = null) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(DOCKER_SOCKET)) {
      return reject(new Error('El socket de Docker no existe o Docker no está instalado.'));
    }
    const options = { socketPath: DOCKER_SOCKET, path: apiPath, method, headers: { Host: 'localhost' } };
    if (body) options.headers['Content-Type'] = 'application/json';
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Pull con progreso por streaming (patrón routes/n8n.js).
function pullImageWithProgress(image, tag, write) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(DOCKER_SOCKET)) {
      return reject(new Error('El socket de Docker no existe o Docker no está instalado.'));
    }
    const options = { socketPath: DOCKER_SOCKET, path: buildPullPath(image, tag), method: 'POST', headers: { Host: 'localhost' } };
    const req = http.request(options, (res) => {
      if (res.statusCode >= 400) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => reject(new Error(Buffer.concat(chunks).toString() || `HTTP ${res.statusCode}`)));
        return;
      }
      const state = { layers: {} };
      let lastPct = -1, buf = '', failed = null;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let event;
          try { event = JSON.parse(line); } catch (_) { continue; }
          const p = accumulatePullProgress(state, event);
          if (p.error) { failed = p.error; continue; }
          if (p.pct !== lastPct) { lastPct = p.pct; write(`__TXPL_PROGRESS__${p.pct}\n`); }
        }
      });
      res.on('end', () => (failed ? reject(new Error(failed)) : resolve()));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Puerto libre en loopback ─────────────────────────────────
function findFreePort(start = 8100) {
  return new Promise((resolve, reject) => {
    const tryPort = (p) => {
      if (p > 65000) return reject(new Error('No hay puertos libres.'));
      const srv = net.createServer();
      srv.once('error', () => tryPort(p + 1));
      srv.once('listening', () => srv.close(() => resolve(p)));
      srv.listen(p, '127.0.0.1');
    };
    tryPort(start);
  });
}

// ── Base de datos MySQL para la app ──────────────────────────
// Crea DB + usuario con acceso desde localhost Y desde la red del bridge
// de Docker (172.17.%). Registra en la tabla databases (contraseña cifrada)
// para que aparezca en la página Bases de datos y entre en los backups.
async function ensureDatabase(appId, write) {
  const { mysqlExec } = require('../routes/databases');
  const name = `txpl_${appId.replace(/-/g, '_')}`;
  if (queries.getDatabaseByName.get(name)) {
    const err = new Error(`La base de datos ${name} ya existe. Bórrala primero o desinstala la app anterior.`);
    err.http = 409;
    throw err;
  }
  const user = name;
  const password = genPassword();
  write(`⏳ Creando base de datos MySQL ${name}...\n`);
  const cmds = [
    `CREATE DATABASE IF NOT EXISTS \`${name}\`;`,
    `CREATE USER IF NOT EXISTS '${user}'@'localhost' IDENTIFIED BY '${password}';`,
    `ALTER USER '${user}'@'localhost' IDENTIFIED BY '${password}';`,
    `CREATE USER IF NOT EXISTS '${user}'@'172.17.%' IDENTIFIED BY '${password}';`,
    `ALTER USER '${user}'@'172.17.%' IDENTIFIED BY '${password}';`,
    `GRANT ALL PRIVILEGES ON \`${name}\`.* TO '${user}'@'localhost';`,
    `GRANT ALL PRIVILEGES ON \`${name}\`.* TO '${user}'@'172.17.%';`,
    'FLUSH PRIVILEGES;',
  ];
  for (const sql of cmds) {
    const r = await mysqlExec(sql);
    if (!r.ok) {
      const detail = (r.stderr || '').split('\n')[0] || 'fallo desconocido';
      const err = new Error(`Error MySQL: ${detail} — ¿está MySQL/MariaDB instalado?`);
      err.http = 409;
      throw err;
    }
  }
  queries.insertDatabase.run({ name, type: 'mysql', db_user: user, db_password: encryptSecret(password), status: 'active' });
  write(`✓ Base de datos ${name} creada.\n`);
  return { name, user, password };
}

// Borra la DB creada durante un rollback (best-effort, nunca lanza).
async function dropDatabase(name) {
  try {
    const { mysqlExec } = require('../routes/databases');
    await mysqlExec(`DROP DATABASE IF EXISTS \`${name}\`;`);
    await mysqlExec(`DROP USER IF EXISTS '${name}'@'localhost';`);
    await mysqlExec(`DROP USER IF EXISTS '${name}'@'172.17.%';`);
    const row = queries.getDatabaseByName.get(name);
    if (row) queries.deleteDatabase.run(row.id);
  } catch (_) {}
}

// ── MySQL accesible desde los contenedores ───────────────────
// Comprueba bind-address; si MySQL solo escucha en 127.0.0.1, añade un
// fichero de config que lo abre también a la IP del bridge de Docker y
// reinicia MySQL. UFW sigue bloqueando 3306 desde fuera.
async function detectDbHostForDocker(write) {
  const { mysqlExec } = require('../routes/databases');
  const r = await mysqlExec("SHOW VARIABLES LIKE 'bind_address';");
  const bound = (r.stdout || '').includes('127.0.0.1');
  if (bound) {
    write('⏳ MySQL solo escucha en 127.0.0.1; abriéndolo a la red interna de Docker (172.17.0.1)...\n');
    const conf = '[mysqld]\nbind-address = 0.0.0.0\n';
    fs.writeFileSync('/etc/mysql/mysql.conf.d/txpl-docker.cnf', conf);
    const rs = await runSafe('systemctl', ['restart', 'mysql']);
    if (!rs.ok) await runSafe('systemctl', ['restart', 'mariadb']);
    write('✓ MySQL accesible desde los contenedores (el puerto 3306 sigue cerrado en el firewall).\n');
  }
  return '172.17.0.1';
}

// ── Proxy Nginx + SSL opcional ───────────────────────────────
async function setupProxy(appId, domain, hostPort, ssl, write) {
  write(`⏳ Configurando proxy Nginx para ${domain}...\n`);
  await nginx.enableSite(nginxConfName(appId), nginx.buildProxy(domain, hostPort));
  write('✓ Proxy Nginx activo.\n');
  if (ssl) {
    write(`⏳ Emitiendo certificado SSL para ${domain} (el DNS debe apuntar ya a este servidor)...\n`);
    try {
      await nginx.installSsl(domain, { www: false });
      write('✓ SSL emitido y redirección HTTPS activa.\n');
    } catch (e) {
      write(`⚠ La app funciona, pero falló el SSL: ${e.message}\n  Puedes reintentarlo desde la sección SSL.\n`);
    }
  }
}

// ── Instalación modo Docker ──────────────────────────────────
async function installDocker(entry, opts, write) {
  const { domain, ssl } = opts;
  const cName = containerName(entry.id);
  let dbCreds = null;
  try {
    if (!fs.existsSync(DOCKER_SOCKET)) {
      const err = new Error('Docker no está instalado. Instálalo primero desde la sección Plugins.');
      err.http = 409;
      throw err;
    }
    let dbHost = null;
    if (entry.db === 'mysql') {
      dbCreds = await ensureDatabase(entry.id, write);
      dbHost = await detectDbHostForDocker(write);
    }
    const hostPort = await findFreePort();
    write(`⏳ Descargando imagen ${entry.docker.image}:${entry.docker.tag}...\n`);
    await pullImageWithProgress(entry.docker.image, entry.docker.tag, write);
    write('✓ Imagen lista.\n');

    await dockerRequest('DELETE', `/containers/${cName}?force=1`).catch(() => {});
    const config = buildAppContainerConfig(entry, { hostPort, domain, dbCreds, dbHost });
    write(`⏳ Creando contenedor ${cName} (volumen persistente ${volumeName(entry.id)})...\n`);
    const create = await dockerRequest('POST', `/containers/create?name=${encodeURIComponent(cName)}`, config);
    if (create.statusCode >= 400) throw new Error(`Error al crear el contenedor: ${create.body.toString()}`);
    const start = await dockerRequest('POST', `/containers/${cName}/start`);
    if (start.statusCode >= 400) throw new Error(`El contenedor no arrancó: ${start.body.toString()}`);
    write(`✓ Contenedor ${cName} en marcha en 127.0.0.1:${hostPort}.\n`);

    if (domain) await setupProxy(entry.id, domain, hostPort, ssl, write);

    queries.insertCatalogInstall.run({
      app_id: entry.id, mode: 'docker', domain: domain || null,
      port: hostPort, ref: cName, db_name: dbCreds ? dbCreds.name : null,
    });
    writeSummary(entry, { domain, hostPort, dbCreds }, write);
    return 0;
  } catch (e) {
    write(`\n✖ ${e.message}\n`);
    // Rollback best-effort: no dejar piezas a medias.
    write('⏳ Deshaciendo cambios parciales...\n');
    await dockerRequest('DELETE', `/containers/${cName}?force=1`).catch(() => {});
    if (dbCreds) await dropDatabase(dbCreds.name);
    write('✓ Limpieza hecha. Puedes reintentar la instalación.\n');
    return 1;
  }
}

// Resumen final: URL de acceso + credenciales UNA SOLA VEZ (no se persisten en claro).
function writeSummary(entry, { domain, hostPort, dbCreds }, write) {
  write(`\n✅ ${entry.name} instalado.\n`);
  const url = domain ? `http${''}s://${domain}` : `http://IP-DEL-SERVIDOR:${hostPort} (o túnel SSH a 127.0.0.1:${hostPort})`;
  write(`   URL: ${url}\n`);
  if (!domain) write('   ⚠ Sin dominio el puerto solo escucha en 127.0.0.1; añade un dominio o usa un túnel SSH.\n');
  if (dbCreds) {
    write(`   Base de datos: ${dbCreds.name} · usuario: ${dbCreds.user} · contraseña: ${dbCreds.password}\n`);
    write('   ⚠ Guarda la contraseña ahora: no volverá a mostrarse en claro.\n');
  }
  write('   Completa el asistente inicial de la app desde su URL.\n');
}

// ── Stubs temporales (Tasks 5-6 los sustituyen por la implementación real) ──
async function installNativePhp(entry, opts, write) { write('✖ Modo nativo aún no disponible.\n'); return 1; }
async function installPm2(entry, opts, write) { write('✖ Modo PM2 aún no disponible.\n'); return 1; }

// ── Punto de entrada ─────────────────────────────────────────
async function installApp(appId, opts, write) {
  const entry = getEntry(appId);
  if (!entry) { const e = new Error('App no encontrada en el catálogo.'); e.http = 404; throw e; }
  if (queries.getCatalogInstall.get(appId)) {
    const e = new Error(`${entry.name} ya está instalado. Desinstálalo antes de reinstalar.`);
    e.http = 409;
    throw e;
  }
  if (opts.mode === 'docker') return installDocker(entry, opts, write);
  if (opts.mode === 'native') return installNativePhp(entry, opts, write);   // Task 5
  if (opts.mode === 'pm2') return installPm2(entry, opts, write);            // Task 6
  const e = new Error('Modo no soportado.');
  e.http = 400;
  throw e;
}

module.exports = {
  installApp,
  // internos reutilizados por el resto del motor y las rutas:
  dockerRequest, pullImageWithProgress, findFreePort,
  ensureDatabase, dropDatabase, detectDbHostForDocker, setupProxy, writeSummary,
  APPS_DIR, LONG,
};
