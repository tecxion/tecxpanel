'use strict';

// ============================================================
//  TecXPaneL — Correo (docker-mailserver)
//  Instala y gestiona un contenedor docker-mailserver por el socket
//  de Docker. El contenedor es la fuente de la verdad de los buzones;
//  el panel lo acciona ejecutando el script `setup` vía la exec API.
// ============================================================

const http = require('http');
const fs = require('fs');
const express = require('express');
const { ok, fail, clientIp, runSafe, wrap } = require('../lib/helpers');
const { queries, audit } = require('../database');
const nginx = require('../lib/nginx');
const {
  MAIL_CONTAINER, MAIL_IMAGE, MAIL_TAG, MAIL_PORTS, buildMailContainerConfig, isValidMailDomain,
  isValidEmail, isValidMailPassword,
  setupEmailAddArgs, setupEmailDelArgs, setupEmailUpdateArgs, setupEmailListArgs,
  setupAliasAddArgs, setupAliasDelArgs, setupAliasListArgs, setupDkimArgs,
  parseEmailList, parseAliasList, buildDnsRecords,
} = require('../lib/mail');

const router = express.Router();
const DOCKER_SOCKET = '/var/run/docker.sock';

// Petición nativa al socket de Docker (mismo patrón que routes/n8n.js).
function dockerRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(DOCKER_SOCKET)) return reject(new Error('El socket de Docker no existe o Docker no está instalado.'));
    const options = { socketPath: DOCKER_SOCKET, path, method, headers: { Host: 'localhost' } };
    if (body) options.headers['Content-Type'] = 'application/json';
    const rq = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    rq.on('error', reject);
    if (body) rq.write(JSON.stringify(body));
    rq.end();
  });
}

// Descarga una imagen por el socket transmitiendo el `status` de cada evento.
function pullImage(image, tag, write) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(DOCKER_SOCKET)) return reject(new Error('El socket de Docker no existe o Docker no está instalado.'));
    const path = `/images/create?fromImage=${encodeURIComponent(image)}&tag=${encodeURIComponent(tag)}`;
    const options = { socketPath: DOCKER_SOCKET, path, method: 'POST', headers: { Host: 'localhost' } };
    const rq = http.request(options, (res) => {
      if (res.statusCode >= 400) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => reject(new Error(Buffer.concat(chunks).toString() || `HTTP ${res.statusCode}`)));
        return;
      }
      let buf = '', failed = null, lastStatus = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
          if (ev.error) { failed = ev.error; continue; }
          if (ev.status && ev.status !== lastStatus) { lastStatus = ev.status; write(`  ${ev.status}\n`); }
        }
      });
      res.on('end', () => (failed ? reject(new Error(failed)) : resolve()));
      res.on('error', reject);
    });
    rq.on('error', reject);
    rq.end();
  });
}

// Localiza el contenedor txpl-mail. Devuelve { docker, exists, running, id }.
async function inspectContainer() {
  try {
    const r = await dockerRequest('GET', '/containers/json?all=1');
    if (r.statusCode >= 400) return { docker: true, exists: false, running: false, id: null };
    const list = JSON.parse(r.body.toString());
    const c = list.find((x) => (x.Names || []).some((n) => n === `/${MAIL_CONTAINER}`));
    if (!c) return { docker: true, exists: false, running: false, id: null };
    return { docker: true, exists: true, running: c.State === 'running', id: c.Id };
  } catch (_) {
    return { docker: false, exists: false, running: false, id: null };
  }
}

// Ejecuta un comando DENTRO del contenedor por la exec API (Tty para salida cruda).
// Devuelve { exitCode, output }. Cmd es un ARRAY de argumentos (sin shell).
async function dockerExec(containerId, cmd) {
  const created = await dockerRequest('POST', `/containers/${containerId}/exec`, {
    AttachStdout: true, AttachStderr: true, Tty: true, Cmd: cmd,
  });
  if (created.statusCode >= 400) throw new Error(created.body.toString() || 'Error creando exec');
  const execId = JSON.parse(created.body.toString()).Id;
  const started = await dockerRequest('POST', `/exec/${execId}/start`, { Detach: false, Tty: true });
  const output = started.body.toString();
  const info = await dockerRequest('GET', `/exec/${execId}/json`);
  const exitCode = JSON.parse(info.body.toString()).ExitCode;
  return { exitCode, output };
}

// Abre los puertos de correo en UFW (best-effort; no aborta si UFW no está).
async function openMailPorts() {
  for (const p of MAIL_PORTS) {
    await runSafe('ufw', ['allow', `${p}/tcp`]);
  }
}

// Cabeceras de streaming (patrón de plugins.js/n8n.js).
function startStream(res) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
}

// Deriva el estado de alto nivel para el frontend.
function computeState({ exists, running, hostname }) {
  if (!exists) return 'not_installed';
  if (!running) return 'stopped';
  if (!hostname) return 'needs_config';
  return 'ready';
}

// ── Estado ───────────────────────────────────────────────────
router.get('/status', wrap(async (req, res) => {
  const insp = await inspectContainer();
  const cfg = queries.getMailConfig.get() || {};
  const state = computeState({ exists: insp.exists, running: insp.running, hostname: cfg.hostname });
  ok(res, {
    docker: insp.docker,
    state,
    installed: insp.exists,
    running: insp.running,
    configured: !!cfg.hostname,
    hostname: cfg.hostname || null,
    domain: cfg.domain || null,
  });
}));

// ── Instalar (streaming) ─────────────────────────────────────
router.post('/install', wrap(async (req, res) => {
  const insp = await inspectContainer();
  if (!insp.docker) return fail(res, 400, 'Docker no está instalado. Instálalo desde Plugins.');
  if (insp.exists) return fail(res, 409, 'El correo ya está instalado.');
  audit(req.user?.username || 'system', clientIp(req), 'mail.install', MAIL_CONTAINER);
  startStream(res);
  const done = (code) => res.end(`\n__TXPL_DONE__${code}`);
  try {
    res.write('📥 Descargando imagen de docker-mailserver...\n');
    await pullImage(MAIL_IMAGE, MAIL_TAG, (t) => res.write(t));
    res.write('🔧 Creando el contenedor...\n');
    // Hostname provisional hasta configurar: el propio nombre del contenedor.
    const config = buildMailContainerConfig({ hostname: MAIL_CONTAINER });
    const create = await dockerRequest('POST', `/containers/create?name=${encodeURIComponent(MAIL_CONTAINER)}`, config);
    if (create.statusCode >= 400) { res.write('[error] ' + create.body.toString() + '\n'); return done(1); }
    const id = JSON.parse(create.body.toString()).Id;
    res.write('🔥 Abriendo puertos en el firewall (UFW)...\n');
    await openMailPorts();
    res.write('▶️  Arrancando el contenedor...\n');
    const start = await dockerRequest('POST', `/containers/${id}/start`);
    if (start.statusCode >= 400) { res.write('[error] ' + start.body.toString() + '\n'); return done(1); }
    queries.saveMailConfig.run({ hostname: null, domain: null, container_id: id, status: 'needs_config', dkim_selector: 'mail', dkim_public: null });
    res.write('✅ Correo instalado. Configura el hostname para emitir el certificado TLS.\n');
    done(0);
  } catch (e) {
    res.write('[error] ' + e.message + '\n');
    done(1);
  }
}));

// ── Configurar hostname + TLS ────────────────────────────────
router.post('/config', wrap(async (req, res) => {
  const hostname = String((req.body && req.body.hostname) || '').trim().toLowerCase();
  if (!isValidMailDomain(hostname)) return fail(res, 400, 'Hostname inválido (ej. mail.tudominio.com).');
  const domain = hostname.split('.').slice(-2).join('.');
  const insp = await inspectContainer();
  if (!insp.exists) return fail(res, 400, 'Instala el correo primero.');

  // Emitir el certificado TLS del hostname del correo. Reutiliza el flujo de
  // sitios: un vhost mínimo para servir el reto ACME + installSsl (Certbot).
  // Best-effort: si el DNS del hostname aún no apunta aquí, se informa sin abortar.
  let tls = 'ok';
  try {
    await nginx.enableSite(hostname, nginx.buildSite(hostname, 'html'));
    await nginx.installSsl(hostname, { www: false });
  } catch (e) {
    tls = 'pendiente: ' + (e.message || 'no se pudo emitir el certificado (revisa el DNS del hostname)');
  }

  const cfg = queries.getMailConfig.get() || {};
  queries.saveMailConfig.run({
    hostname, domain, container_id: insp.id, status: 'ready',
    dkim_selector: cfg.dkim_selector || 'mail', dkim_public: cfg.dkim_public || null,
  });
  // Reiniciar para que docker-mailserver recoja el certificado montado.
  await dockerRequest('POST', `/containers/${insp.id}/restart`);
  audit(req.user?.username || 'system', clientIp(req), 'mail.config', hostname);
  ok(res, { hostname, domain, tls });
}));

// ── Acciones start/stop/restart ──────────────────────────────
router.post('/:action(start|stop|restart)', wrap(async (req, res) => {
  const insp = await inspectContainer();
  if (!insp.exists) return fail(res, 400, 'El correo no está instalado.');
  const r = await dockerRequest('POST', `/containers/${insp.id}/${req.params.action}`);
  if (r.statusCode >= 400) return fail(res, 500, r.body.toString() || 'Error en la acción');
  audit(req.user?.username || 'system', clientIp(req), 'mail.' + req.params.action, MAIL_CONTAINER);
  ok(res);
}));

// ── Desinstalar (conserva los volúmenes de datos) ────────────
router.delete('/', wrap(async (req, res) => {
  const cfg = queries.getMailConfig.get();
  const insp = await inspectContainer();
  if (insp.exists) {
    await dockerRequest('POST', `/containers/${insp.id}/stop`);
    await dockerRequest('DELETE', `/containers/${insp.id}?force=1`);
  }
  // Limpia el vhost de Nginx creado para emitir el certificado TLS del correo.
  if (cfg && cfg.hostname) { try { await nginx.removeSite(cfg.hostname); } catch (_) {} }
  queries.clearMailConfig.run();
  audit(req.user?.username || 'system', clientIp(req), 'mail.uninstall', MAIL_CONTAINER);
  ok(res);
}));

// Ejecuta un comando `setup` dentro del contenedor en marcha. Devuelve la salida.
async function runSetup(cmd) {
  const insp = await inspectContainer();
  if (!insp.exists) { const e = new Error('El correo no está instalado.'); e.http = 400; throw e; }
  if (!insp.running) { const e = new Error('El contenedor de correo está parado.'); e.http = 409; throw e; }
  const { exitCode, output } = await dockerExec(insp.id, cmd);
  if (exitCode !== 0) { const e = new Error(output.trim() || `setup salió con código ${exitCode}`); e.http = 500; throw e; }
  return output;
}

// ── Buzones ──────────────────────────────────────────────────
router.get('/mailboxes', wrap(async (req, res) => {
  const out = await runSetup(setupEmailListArgs());
  ok(res, { mailboxes: parseEmailList(out) });
}));

router.post('/mailboxes', wrap(async (req, res) => {
  const address = String((req.body && req.body.address) || '').trim().toLowerCase();
  const password = String((req.body && req.body.password) || '');
  if (!isValidEmail(address)) return fail(res, 400, 'Dirección de correo inválida.');
  if (!isValidMailPassword(password)) return fail(res, 400, 'Contraseña inválida (mínimo 6 caracteres, sin espacios).');
  await runSetup(setupEmailAddArgs(address, password));
  audit(req.user?.username || 'system', clientIp(req), 'mail.mailbox.add', address);
  ok(res);
}));

router.put('/mailboxes', wrap(async (req, res) => {
  const address = String((req.body && req.body.address) || '').trim().toLowerCase();
  const password = String((req.body && req.body.password) || '');
  if (!isValidEmail(address)) return fail(res, 400, 'Dirección de correo inválida.');
  if (!isValidMailPassword(password)) return fail(res, 400, 'Contraseña inválida (mínimo 6 caracteres, sin espacios).');
  await runSetup(setupEmailUpdateArgs(address, password));
  audit(req.user?.username || 'system', clientIp(req), 'mail.mailbox.password', address);
  ok(res);
}));

router.delete('/mailboxes', wrap(async (req, res) => {
  const address = String((req.body && req.body.address) || '').trim().toLowerCase();
  if (!isValidEmail(address)) return fail(res, 400, 'Dirección de correo inválida.');
  await runSetup(setupEmailDelArgs(address));
  audit(req.user?.username || 'system', clientIp(req), 'mail.mailbox.del', address);
  ok(res);
}));

// ── Alias ────────────────────────────────────────────────────
router.get('/aliases', wrap(async (req, res) => {
  const out = await runSetup(setupAliasListArgs());
  ok(res, { aliases: parseAliasList(out) });
}));

router.post('/aliases', wrap(async (req, res) => {
  const source = String((req.body && req.body.source) || '').trim().toLowerCase();
  const destination = String((req.body && req.body.destination) || '').trim().toLowerCase();
  if (!isValidEmail(source) || !isValidEmail(destination)) return fail(res, 400, 'Origen o destino inválidos.');
  await runSetup(setupAliasAddArgs(source, destination));
  audit(req.user?.username || 'system', clientIp(req), 'mail.alias.add', `${source} -> ${destination}`);
  ok(res);
}));

router.delete('/aliases', wrap(async (req, res) => {
  const source = String((req.body && req.body.source) || '').trim().toLowerCase();
  const destination = String((req.body && req.body.destination) || '').trim().toLowerCase();
  if (!isValidEmail(source) || !isValidEmail(destination)) return fail(res, 400, 'Origen o destino inválidos.');
  await runSetup(setupAliasDelArgs(source, destination));
  audit(req.user?.username || 'system', clientIp(req), 'mail.alias.del', `${source} -> ${destination}`);
  ok(res);
}));

// ── DKIM ─────────────────────────────────────────────────────
router.post('/dkim', wrap(async (req, res) => {
  const cfg = queries.getMailConfig.get();
  if (!cfg || !cfg.domain) return fail(res, 400, 'Configura el hostname del correo primero.');
  await runSetup(setupDkimArgs(cfg.domain));
  // Leer la clave pública generada del volumen de config (rspamd).
  const insp = await inspectContainer();
  const selector = cfg.dkim_selector || 'mail';
  let pub = '';
  try {
    // NOTA: la ruta/formato del fichero de clave pública DKIM depende de la versión
    // de docker-mailserver (Rspamd); leemos cualquier *.public.dkim.txt y normalizamos.
    const r = await dockerExec(insp.id, ['sh', '-c', `cat /tmp/docker-mailserver/rspamd/dkim/*.public.dkim.txt 2>/dev/null | tr -d '\\n\\t"' `]);
    const raw = (r.output || '').replace(/.*p=/, 'v=DKIM1; k=rsa; p=').trim();
    // Solo guardar si parece un registro DKIM real (evita persistir ruido/errores).
    if (/p=[A-Za-z0-9+/]{20,}/.test(raw)) pub = raw;
  } catch (_) { pub = ''; }
  queries.saveMailConfig.run({
    hostname: cfg.hostname, domain: cfg.domain, container_id: insp.id, status: cfg.status || 'ready',
    dkim_selector: selector, dkim_public: pub || null,
  });
  audit(req.user?.username || 'system', clientIp(req), 'mail.dkim', cfg.domain);
  ok(res, { dkim_public: pub || null });
}));

// ── Registros DNS a mostrar ──────────────────────────────────
router.get('/dns', wrap(async (req, res) => {
  const cfg = queries.getMailConfig.get();
  if (!cfg || !cfg.hostname || !cfg.domain) return fail(res, 400, 'Configura el hostname del correo primero.');
  const ipR = await runSafe('bash', ['-c', "curl -s https://api.ipify.org || hostname -I | awk '{print $1}'"]);
  const serverIp = (ipR.stdout || '').trim();
  const records = buildDnsRecords({
    domain: cfg.domain, hostname: cfg.hostname, serverIp,
    dkimPublic: cfg.dkim_public, dkimSelector: cfg.dkim_selector || 'mail',
  });
  ok(res, { records });
}));

module.exports = router;
