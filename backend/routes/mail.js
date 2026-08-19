'use strict';

// ============================================================
//  TecXPaneL — Correo (docker-mailserver)
//  Instala y gestiona un contenedor docker-mailserver por el socket
//  de Docker. El contenedor es la fuente de la verdad de los buzones;
//  el panel lo acciona ejecutando el script `setup` vía la exec API.
// ============================================================

const http = require('http');
const fs = require('fs');
const net = require('net');
const dnsp = require('dns').promises;
const express = require('express');
const { ok, fail, clientIp, runSafe, wrap } = require('../lib/helpers');
const { queries, audit } = require('../database');
const nginx = require('../lib/nginx');
const D = require('../lib/dns');
const { findFreePort } = require('../lib/catalogEngine');
const {
  MAIL_CONTAINER, MAIL_IMAGE, MAIL_TAG, MAIL_PORTS, buildMailContainerConfig, isValidMailDomain,
  isValidEmail, isValidMailPassword,
  setupEmailAddArgs, setupEmailDelArgs, setupEmailUpdateArgs, setupEmailListArgs,
  setupAliasAddArgs, setupAliasDelArgs, setupAliasListArgs, setupDkimArgs,
  parseEmailList, parseAliasList, buildDnsRecords, mailRecordsToRrsets,
  buildWebmailContainerConfig, WEBMAIL_CONTAINER, WEBMAIL_TAG, WEBMAIL_IMAGE, WEBMAIL_VOLUME,
} = require('../lib/mail');
const diag = require('../lib/mail/diagnose');
const { encryptSecret, decryptSecret } = require('../lib/crypto');

const router = express.Router();
const DOCKER_SOCKET = '/var/run/docker.sock';

// Petición nativa al socket de Docker (mismo patrón que routes/n8n.js).
function dockerRequest(method, path, body = null, timeout = 30_000) {
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
    rq.setTimeout(timeout, () => rq.destroy(new Error('Tiempo de espera agotado al contactar con Docker.')));
    if (body) rq.write(JSON.stringify(body));
    rq.end();
  });
}

// Fracción 0..1 de una capa (descarga = primera mitad, extracción = segunda),
// para agregar el progreso global de la descarga en una barra de %.
function layerFraction(status, detail, prev) {
  const p = (detail && detail.total > 0) ? detail.current / detail.total : 0;
  switch (status) {
    case 'Downloading':        return Math.max(prev, p * 0.5);
    case 'Verifying Checksum':
    case 'Download complete':  return Math.max(prev, 0.5);
    case 'Extracting':         return Math.max(prev, 0.5 + p * 0.5);
    case 'Pull complete':
    case 'Already exists':     return 1;
    default:                   return prev; // 'Pulling fs layer', 'Waiting'…
  }
}

// Descarga una imagen por el socket emitiendo el % global (marcador __TXPL_PULL__).
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
      let buf = '', failed = null, lastPct = -1;
      const layers = new Map(); // id de capa -> fracción 0..1 (descarga + extracción)
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev; try { ev = JSON.parse(line); } catch (_) { continue; }
          if (ev.error) { failed = ev.error; continue; }
          if (!ev.id || !ev.status) continue; // 'Pulling from…', 'Digest:', 'Status:' → sin capa
          layers.set(ev.id, layerFraction(ev.status, ev.progressDetail, layers.get(ev.id) || 0));
          let sum = 0; for (const f of layers.values()) sum += f;
          const pct = Math.round((sum / layers.size) * 100);
          if (pct !== lastPct) { lastPct = pct; write(`__TXPL_PULL__${pct}\n`); }
        }
      });
      res.on('end', () => {
        if (!failed && lastPct < 100) write('__TXPL_PULL__100\n');
        return failed ? reject(new Error(failed)) : resolve();
      });
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
  if (started.statusCode >= 400) throw new Error(started.body.toString() || 'Error ejecutando el comando en el contenedor.');
  const output = started.body.toString();
  const info = await dockerRequest('GET', `/exec/${execId}/json`);
  if (info.statusCode >= 400) throw new Error(info.body.toString() || 'No se pudo consultar el resultado del comando.');
  const exitCode = JSON.parse(info.body.toString()).ExitCode;
  return { exitCode, output };
}

// Abre los puertos de correo en UFW (best-effort; no aborta si UFW no está).
async function openMailPorts() {
  const failed = [];
  for (const p of MAIL_PORTS) {
    const r = await runSafe('ufw', ['allow', `${p}/tcp`]);
    if (!r.ok) failed.push({ port: p, error: (r.stderr || 'UFW no disponible').split(/\r?\n/)[0] });
  }
  return failed;
}

// Cabeceras de streaming (patrón de plugins.js/n8n.js).
function startStream(res) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
}

// Deriva el estado de alto nivel para el frontend.
function computeState({ exists, running, hostname, status }) {
  if (!exists) return 'not_installed';
  if (!running) return 'stopped';
  if (!hostname) return 'needs_config';
  if (status === 'tls_pending') return 'needs_tls';
  return 'ready';
}

// ── Estado ───────────────────────────────────────────────────
router.get('/status', wrap(async (req, res) => {
  const insp = await inspectContainer();
  const cfg = queries.getMailConfig.get() || {};
  const state = computeState({ exists: insp.exists, running: insp.running, hostname: cfg.hostname, status: cfg.status });
  ok(res, {
    docker: insp.docker,
    state,
    installed: insp.exists,
    running: insp.running,
    configured: !!cfg.hostname,
    configStatus: cfg.status || null,
    hostname: cfg.hostname || null,
    domain: cfg.domain || null,
  });
}));

// ── Diagnóstico (sondas DNS/TCP → clasificadores puros de lib/mail/diagnose) ──
const DNSBL_LISTS = ['zen.spamhaus.org', 'bl.spamcop.net'];

// TCP connect saliente: ¿deja el proveedor salir por el puerto? true/false.
function probePort25(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; try { sock.destroy(); } catch (_) {} resolve(v); } };
    const sock = net.connect({ host, port });
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}
async function resolve4Safe(name) { try { return await dnsp.resolve4(name); } catch (_) { return []; } }
async function reverseSafe(ip) { try { return await dnsp.reverse(ip); } catch (_) { return []; } }
async function resolveMxSafe(domain) { try { return await dnsp.resolveMx(domain); } catch (_) { return []; } }
async function resolveTxtSafe(name) { try { return await dnsp.resolveTxt(name); } catch (_) { return []; } }
// Cada lista DNSBL: resolver la IP invertida → si resuelve, está listada.
async function probeDnsbl(ip, lists) {
  return Promise.all(lists.map(async (list) => {
    try { await dnsp.resolve4(diag.dnsblQuery(ip, list)); return { list, listed: true }; }
    catch (_) { return { list, listed: false }; }
  }));
}
// IP pública del VPS (best-effort): ipify por IPv4, si no `hostname -I`.
async function getServerIp() {
  const r = await runSafe('bash', ['-c', "curl -4 -s --max-time 3 https://api.ipify.org || hostname -I | awk '{print $1}'"]);
  return r.ok ? String(r.stdout || '').trim() : '';
}

// GET /diagnose — "salud del correo" en lenguaje llano (semáforo + cómo arreglar).
router.get('/diagnose', wrap(async (req, res) => {
  const cfg = queries.getMailConfig.get() || {};
  const hostname = cfg.hostname || null;
  const domain = cfg.domain || (hostname ? hostname.split('.').slice(-2).join('.') : null);
  const selector = cfg.dkim_selector || 'mail';
  const serverIp = await getServerIp();

  const [port25, dnsbl, aRec, ptr, mx, spf, dkim, dmarc] = await Promise.all([
    probePort25('gmail-smtp-in.l.google.com', 25, 5000),
    serverIp ? probeDnsbl(serverIp, DNSBL_LISTS) : Promise.resolve([]),
    hostname ? resolve4Safe(hostname) : Promise.resolve([]),
    (hostname && serverIp) ? reverseSafe(serverIp) : Promise.resolve([]),
    domain ? resolveMxSafe(domain) : Promise.resolve([]),
    domain ? resolveTxtSafe(domain) : Promise.resolve([]),
    domain ? resolveTxtSafe(`${selector}._domainkey.${domain}`) : Promise.resolve([]),
    domain ? resolveTxtSafe(`_dmarc.${domain}`) : Promise.resolve([]),
  ]);

  const checks = [diag.classifyPort25(port25)];
  if (serverIp) checks.push(diag.classifyDnsbl(dnsbl));
  if (hostname) {
    checks.push(diag.classifyDnsA(aRec, serverIp));
    if (serverIp) checks.push(diag.classifyPtr(ptr, hostname));
  }
  if (domain) {
    checks.push(diag.classifyMx(mx.map((m) => m.exchange), hostname));
    checks.push(diag.classifySpf(spf), diag.classifyDkim(dkim), diag.classifyDmarc(dmarc));
  }
  ok(res, { configured: !!hostname, hostname, serverIp: serverIp || null, overall: diag.overallLevel(checks), checks });
}));

// ── Instalar (streaming) ─────────────────────────────────────
router.post('/install', wrap(async (req, res) => {
  const insp = await inspectContainer();
  if (!insp.docker) return fail(res, 400, 'Docker no está instalado. Instálalo desde Plugins.');
  if (insp.exists) return fail(res, 409, 'El correo ya está instalado.');
  audit(req.user?.username || 'system', clientIp(req), 'mail.install', MAIL_CONTAINER);
  startStream(res);
  const done = (code) => res.end(`\n__TXPL_DONE__${code}`);
  let createdId = null;
  try {
    res.write('📥 Descargando imagen de docker-mailserver...\n');
    await pullImage(MAIL_IMAGE, MAIL_TAG, (t) => res.write(t));
    res.write('🔧 Creando el contenedor...\n');
    // Hostname provisional VÁLIDO (con dominio) y SIN TLS: docker-mailserver exige
    // un FQDN o se cae con "Setting hostname/domainname is required". Se recrea con
    // el hostname real al configurar (/config).
    const config = buildMailContainerConfig({ hostname: 'mail.local', ssl: false });
    const create = await dockerRequest('POST', `/containers/create?name=${encodeURIComponent(MAIL_CONTAINER)}`, config);
    if (create.statusCode >= 400) throw new Error('No se pudo crear el contenedor: ' + create.body.toString());
    const id = JSON.parse(create.body.toString()).Id;
    createdId = id;
    res.write('🔥 Abriendo puertos en el firewall (UFW)...\n');
    const firewallErrors = await openMailPorts();
    if (firewallErrors.length) {
      res.write('⚠ No se pudieron abrir todos los puertos en UFW: ' + firewallErrors.map((item) => item.port).join(', ') + '.\n');
    }
    res.write('▶️  Arrancando el contenedor...\n');
    const start = await dockerRequest('POST', `/containers/${id}/start`);
    if (start.statusCode >= 400) throw new Error('El contenedor no arrancó: ' + start.body.toString());
    queries.saveMailConfig.run({ hostname: null, domain: null, container_id: id, status: 'needs_config', dkim_selector: 'mail', dkim_public: null });
    res.write('✅ Correo instalado. Configura el hostname para emitir el certificado TLS.\n');
    done(0);
  } catch (e) {
    if (createdId) {
      await dockerRequest('DELETE', `/containers/${createdId}?force=1`).catch(() => {});
    }
    res.write('[error] ' + e.message + '\n');
    done(1);
  }
}));

// Relay efectivo (descifrado) o null si no está activo. Para recrear el contenedor.
function currentRelay() {
  const r = queries.getMailRelay.get();
  if (!r || !r.enabled || !r.host) return null;
  let password = '';
  if (r.password_enc) { const p = decryptSecret(r.password_enc); password = p === '(no descifrable)' ? '' : p; }
  return { host: r.host, port: r.port || 587, username: r.username || '', password };
}

// Recrea el contenedor de correo con la config dada, conservando los volúmenes de
// datos (v=0). Devuelve el nuevo id. En Docker el hostname/envs no se pueden
// cambiar sin recrear el contenedor.
async function recreateMailContainer(oldId, opts) {
  if (oldId) await dockerRequest('DELETE', `/containers/${oldId}?force=1&v=0`).catch(() => {});
  const create = await dockerRequest('POST', `/containers/create?name=${encodeURIComponent(MAIL_CONTAINER)}`, buildMailContainerConfig(opts));
  if (create.statusCode >= 400) { const e = new Error('No se pudo recrear el contenedor de correo: ' + create.body.toString()); e.http = 502; throw e; }
  const newId = JSON.parse(create.body.toString()).Id;
  const start = await dockerRequest('POST', `/containers/${newId}/start`);
  if (start.statusCode >= 400) { const e = new Error('El contenedor de correo no arrancó: ' + start.body.toString()); e.http = 502; throw e; }
  return newId;
}

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
  // Recrear el contenedor con el FQDN real (el hostname no se puede cambiar sin
  // recrear; un simple restart deja el hostname provisional y se cae). Conserva
  // volúmenes y el relay ya configurado. SSL solo si el certificado ya se emitió.
  const newId = await recreateMailContainer(insp.id, { hostname, ssl: tls === 'ok', relay: currentRelay() });
  queries.saveMailConfig.run({
    hostname, domain, container_id: newId, status: tls === 'ok' ? 'ready' : 'tls_pending',
    dkim_selector: cfg.dkim_selector || 'mail', dkim_public: cfg.dkim_public || null,
  });
  audit(req.user?.username || 'system', clientIp(req), 'mail.config', hostname);
  ok(res, { hostname, domain, tls });
}));

// ── Relay SMTP saliente (smarthost) ──────────────────────────
// GET /relay — config actual SIN exponer la contraseña.
router.get('/relay', wrap(async (req, res) => {
  const r = queries.getMailRelay.get() || {};
  ok(res, { enabled: !!r.enabled, host: r.host || null, port: r.port || 587, username: r.username || null, hasPassword: !!r.password_enc });
}));

// POST /relay — guarda el relay (contraseña cifrada) y recrea el contenedor.
router.post('/relay', wrap(async (req, res) => {
  const b = req.body || {};
  const enabled = !!b.enabled;
  const host = String(b.host || '').trim();
  const port = Number(b.port) || 587;
  const username = String(b.username || '').trim();
  const password = typeof b.password === 'string' ? b.password : '';

  if (enabled) {
    if (!host || host.length > 255 || /\s/.test(host)) return fail(res, 400, 'Host del relay inválido (ej. smtp-relay.brevo.com).');
    if (!(port >= 1 && port <= 65535)) return fail(res, 400, 'Puerto del relay inválido (1-65535).');
    if (username.length > 255) return fail(res, 400, 'Usuario del relay demasiado largo.');
    if (password.length > 1024) return fail(res, 400, 'Contraseña del relay demasiado larga.');
  }

  const insp = await inspectContainer();
  if (!insp.exists) return fail(res, 400, 'Instala el correo primero.');
  const cfg = queries.getMailConfig.get() || {};
  if (!cfg.hostname) return fail(res, 400, 'Configura primero el hostname del correo.');

  // Si el usuario deja la contraseña vacía, conserva la anterior (no la borra).
  const prev = queries.getMailRelay.get() || {};
  const password_enc = password ? encryptSecret(password) : (prev.password_enc || null);
  queries.saveMailRelay.run({ host: host || null, port, username: username || null, password_enc, enabled: enabled ? 1 : 0 });

  // Recrear el contenedor con (o sin) el relay ya guardado. SSL según estado actual.
  const newId = await recreateMailContainer(insp.id, { hostname: cfg.hostname, ssl: cfg.status === 'ready', relay: currentRelay() });
  queries.saveMailConfig.run({
    hostname: cfg.hostname, domain: cfg.domain, container_id: newId, status: cfg.status,
    dkim_selector: cfg.dkim_selector || 'mail', dkim_public: cfg.dkim_public || null,
  });
  audit(req.user?.username || 'system', clientIp(req), 'mail.relay', enabled ? `on ${host}:${port}` : 'off');
  ok(res, { enabled, host: host || null, port });
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

// ── Publicar los registros de correo en el DNS del panel ─────
// Calcula los rrsets deseados y el estado actual de la zona PowerDNS.
// Lanza con e.http=409 si falta correo, DNS o la zona.
async function computeDnsPublish() {
  const cfg = queries.getMailConfig.get();
  if (!cfg || !cfg.hostname || !cfg.domain) {
    const e = new Error('Configura primero el correo (hostname y dominio).'); e.http = 409; throw e;
  }
  let dnsCfg;
  try { dnsCfg = require('./dns').getDnsConnectedConfig(); }
  catch (_) { const e = new Error('El DNS del panel no está instalado. Instálalo en la sección DNS.'); e.http = 409; throw e; }

  const { pdnsApi } = require('./dns');
  const zone = cfg.domain;
  const zoneId = encodeURIComponent(D.canonical(zone));
  const zr = await pdnsApi('GET', `/zones/${zoneId}`, dnsCfg.apiKey);
  if (zr.statusCode === 404) {
    const e = new Error(`La zona ${zone} no existe en el DNS del panel. Créala primero en la sección DNS.`); e.http = 409; throw e;
  }
  if (zr.statusCode >= 400) { const e = new Error('PowerDNS: ' + JSON.stringify(zr.json)); e.http = 502; throw e; }

  const ipR = await runSafe('bash', ['-c', "curl -s https://api.ipify.org || hostname -I | awk '{print $1}'"]);
  const serverIp = (ipR.stdout || '').trim();
  const records = buildDnsRecords({
    domain: cfg.domain, hostname: cfg.hostname, serverIp,
    dkimPublic: cfg.dkim_public, dkimSelector: cfg.dkim_selector || 'mail',
  });
  const desired = mailRecordsToRrsets(records, zone);
  const existing = D.parseRecords(zr.json); // [{ name, type, ttl, content }] sin punto final

  const skipped = [];
  if (!cfg.dkim_public) skipped.push('DKIM omitido: genera primero la clave DKIM en esta página.');
  if (!serverIp) skipped.push('Registro A omitido: no se pudo detectar la IP pública.');

  const items = desired.map((d) => {
    const match = existing.find((x) => x.name === d.name && x.type === d.type);
    let action = 'crear';
    if (match) action = match.content === d.content ? 'igual' : 'sobrescribir';
    return { type: d.type, name: d.name, value: d.content, action };
  });
  return { zone, zoneId, apiKey: dnsCfg.apiKey, desired, items, skipped };
}

// GET /dns/preview — qué se creará/sobrescribirá, sin tocar nada.
router.get('/dns/preview', wrap(async (req, res) => {
  const { zone, items, skipped } = await computeDnsPublish();
  ok(res, { zone, items, skipped });
}));

// POST /dns/publish — upsert (REPLACE) de cada rrset en la zona.
router.post('/dns/publish', wrap(async (req, res) => {
  const { pdnsApi } = require('./dns');
  const { zone, zoneId, apiKey, desired, items, skipped } = await computeDnsPublish();
  let applied = 0;
  for (const d of desired) {
    const patch = D.buildRrsetPatch({ name: d.name, type: d.type, contents: [d.content], ttl: 3600, changetype: 'REPLACE' });
    const r = await pdnsApi('PATCH', `/zones/${zoneId}`, apiKey, patch);
    if (r.statusCode >= 400) return fail(res, 502, `PowerDNS al publicar ${d.type} ${d.name}: ` + JSON.stringify(r.json));
    applied++;
  }
  audit(req.user.username, clientIp(req), 'mail.dns.publish', `${zone} (${applied} registros)`);
  ok(res, { success: true, applied, items, skipped });
}));

// ── Webmail (Roundcube) ──────────────────────────────────────
const WEBMAIL_CONF = 'txpl-webmail'; // nombre del vhost Nginx

async function inspectWebmail() {
  try {
    const r = await dockerRequest('GET', '/containers/json?all=1');
    if (r.statusCode >= 400) return { exists: false, running: false };
    const list = JSON.parse(r.body.toString());
    const c = list.find((x) => (x.Names || []).some((n) => n === `/${WEBMAIL_CONTAINER}`));
    return { exists: !!c, running: !!c && c.State === 'running' };
  } catch (_) { return { exists: false, running: false }; }
}

// GET /webmail/status — estado para la tarjeta de la página Correo.
router.get('/webmail/status', wrap(async (req, res) => {
  const cfg = queries.getMailConfig.get();
  const insp = await inspectWebmail();
  ok(res, {
    installed: insp.exists,
    running: insp.running,
    domain: (cfg && cfg.webmail_domain) || null,
    port: (cfg && cfg.webmail_port) || null,
  });
}));

// POST /webmail/install — body { domain?, ssl? }. Streaming __TXPL_DONE__.
router.post('/webmail/install', wrap(async (req, res) => {
  const cfg = queries.getMailConfig.get();
  if (!cfg || !cfg.hostname) return fail(res, 409, 'Configura primero el correo (hostname).');
  const domainRaw = String((req.body && req.body.domain) || '').trim();
  const ssl = !!(req.body && req.body.ssl);
  let domain = null;
  if (domainRaw) {
    if (!isValidMailDomain(domainRaw)) return fail(res, 400, 'Dominio inválido.');
    domain = domainRaw;
  }
  if (ssl && !domain) return fail(res, 400, 'SSL requiere un dominio.');
  const existing = await inspectWebmail();
  if (existing.exists) return fail(res, 409, 'Roundcube ya está instalado.');

  audit(req.user.username, clientIp(req), 'mail.webmail.install', domain || 'sin dominio');
  startStream(res);
  const write = (s) => res.write(s);
  const done = (code) => res.end(`\n__TXPL_DONE__${code}`);
  write('▶ Instalando webmail (Roundcube)...\n\n');
  try {
    const hostPort = await findFreePort();
    write(`⏳ Descargando imagen ${WEBMAIL_IMAGE}:${WEBMAIL_TAG}...\n`);
    await pullImage(WEBMAIL_IMAGE, WEBMAIL_TAG, write);
    write('✓ Imagen lista.\n');
    const config = buildWebmailContainerConfig({ hostPort, mailHostname: cfg.hostname, domain });
    write(`⏳ Creando contenedor ${WEBMAIL_CONTAINER}...\n`);
    const create = await dockerRequest('POST', `/containers/create?name=${encodeURIComponent(WEBMAIL_CONTAINER)}`, config);
    if (create.statusCode >= 400) throw new Error('Error al crear el contenedor: ' + create.body.toString());
    const start = await dockerRequest('POST', `/containers/${WEBMAIL_CONTAINER}/start`);
    if (start.statusCode >= 400) throw new Error('El contenedor no arrancó: ' + start.body.toString());
    write(`✓ Roundcube en marcha en 127.0.0.1:${hostPort}.\n`);
    if (domain) {
      write(`⏳ Proxy Nginx para ${domain}...\n`);
      await nginx.enableSite(WEBMAIL_CONF, nginx.buildProxy(domain, hostPort));
      write('✓ Proxy activo.\n');
      if (ssl) {
        try { await nginx.installSsl(domain, { www: false }); write('✓ SSL emitido.\n'); }
        catch (e) { write(`⚠ Webmail funciona, pero falló el SSL: ${e.message}\n`); }
      }
    }
    queries.setMailWebmail.run(domain, hostPort, WEBMAIL_CONTAINER);
    write(`\n✅ Webmail instalado. Entra con un buzón (usuario@${cfg.domain}) y su contraseña.\n`);
    if (!domain) write(`   Acceso: túnel SSH a 127.0.0.1:${hostPort} (sin dominio no se expone fuera).\n`);
    return done(0);
  } catch (e) {
    write(`\n✖ ${e.message}\n⏳ Deshaciendo...\n`);
    await dockerRequest('DELETE', `/containers/${WEBMAIL_CONTAINER}?force=1`).catch(() => {});
    try { await nginx.removeSite(WEBMAIL_CONF); } catch (_) {}
    write('✓ Limpieza hecha.\n');
    return done(1);
  }
}));

// POST /webmail/:action — start | stop | restart.
router.post('/webmail/:action(start|stop|restart)', wrap(async (req, res) => {
  const insp = await inspectWebmail();
  if (!insp.exists) return fail(res, 404, 'El webmail no está instalado.');
  const r = await dockerRequest('POST', `/containers/${WEBMAIL_CONTAINER}/${req.params.action}`);
  if (r.statusCode >= 400) return fail(res, 502, `Error al ${req.params.action}: ` + r.body.toString());
  audit(req.user.username, clientIp(req), `mail.webmail.${req.params.action}`, null);
  ok(res);
}));

// DELETE /webmail?volume=true — desinstala; el volumen solo con opt-in.
router.delete('/webmail', wrap(async (req, res) => {
  const removeVolume = req.query.volume === 'true';
  audit(req.user.username, clientIp(req), 'mail.webmail.uninstall', removeVolume ? 'con volumen' : 'sin volumen');
  startStream(res);
  const write = (s) => res.write(s);
  const done = (code) => res.end(`\n__TXPL_DONE__${code}`);
  try {
    write('▶ Desinstalando webmail...\n');
    await dockerRequest('DELETE', `/containers/${WEBMAIL_CONTAINER}?force=1&v=0`).catch(() => {});
    if (removeVolume) {
      write(`⏳ Borrando volumen ${WEBMAIL_VOLUME}...\n`);
      const volume = await dockerRequest('DELETE', `/volumes/${WEBMAIL_VOLUME}`);
      // El contenedor ya se borró: si el volumen no se puede quitar (raro),
      // avisamos pero NO abortamos, para no dejar el vhost y la BD a medias.
      if (volume.statusCode >= 400 && volume.statusCode !== 404) {
        write('⚠ No se pudo borrar el volumen de Roundcube; bórralo a mano si hace falta.\n');
      }
    }
    try { await nginx.removeSite(WEBMAIL_CONF); } catch (_) {}
    queries.clearMailWebmail.run();
    write('\n✅ Webmail desinstalado.\n');
    return done(0);
  } catch (e) {
    write(`\n✖ ${e.message}\n`);
    return done(1);
  }
}));

module.exports = router;
