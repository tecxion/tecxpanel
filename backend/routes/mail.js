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
const { ok, fail, clientIp, run, runSafe, wrap } = require('../lib/helpers');
const { queries, audit } = require('../database');
const nginx = require('../lib/nginx');
const {
  MAIL_CONTAINER, MAIL_IMAGE, MAIL_TAG, MAIL_PORTS, buildMailContainerConfig, isValidMailDomain,
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
  const insp = await inspectContainer();
  if (insp.exists) {
    await dockerRequest('POST', `/containers/${insp.id}/stop`);
    await dockerRequest('DELETE', `/containers/${insp.id}?force=1`);
  }
  queries.clearMailConfig.run();
  audit(req.user?.username || 'system', clientIp(req), 'mail.uninstall', MAIL_CONTAINER);
  ok(res);
}));

module.exports = router;
