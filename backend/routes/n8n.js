'use strict';

// ============================================================
//  TecXPaneL — n8n (Workflows)
//
//  Instala n8n como contenedor Docker, guarda su API key cifrada
//  y hace de proxy autenticado hacia la Public API de n8n para
//  listar/controlar workflows y ejecuciones. El editor NO se
//  reimplementa: para editar se hace deep-link a la UI de n8n.
// ============================================================

const http = require('http');
const fs = require('fs');
const express = require('express');
const { ok, fail, clientIp, wrap } = require('../lib/helpers');
const { isValidDomain } = require('../lib/validators');
const nginx = require('../lib/nginx');
const { encryptSecret, decryptSecret } = require('../lib/crypto');
const { queries, audit } = require('../database');
const {
  buildN8nContainerConfig, buildPullPath, buildLocalApiBase,
  n8nApi, computeN8nStatus, accumulatePullProgress,
  N8N_CONTAINER, N8N_IMAGE, N8N_TAG, N8N_PORT,
} = require('../lib/n8n');

const router = express.Router();
const DOCKER_SOCKET = '/var/run/docker.sock';
const N8N_CONF_NAME = 'txpl-n8n'; // nombre del vhost Nginx cuando hay dominio

// Petición nativa al socket de Docker (mismo patrón que routes/docker.js).
function dockerRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(DOCKER_SOCKET)) {
      return reject(new Error('El socket de Docker no existe o Docker no está instalado.'));
    }
    const options = { socketPath: DOCKER_SOCKET, path, method, headers: { Host: 'localhost' } };
    if (body) options.headers['Content-Type'] = 'application/json';
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// Descarga una imagen por el socket de Docker transmitiendo el progreso.
// Lee las líneas JSON de /images/create, agrega el % con accumulatePullProgress
// y llama a write('__TXPL_PROGRESS__<pct>\n') cuando el entero cambia.
// Resuelve al terminar; rechaza con el mensaje real si hay error.
function pullImageWithProgress(image, tag, write) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(DOCKER_SOCKET)) {
      return reject(new Error('El socket de Docker no existe o Docker no está instalado.'));
    }
    // buildPullPath fija el tag: sin él, la API descargaría TODAS las etiquetas.
    const path = buildPullPath(image, tag);
    const options = { socketPath: DOCKER_SOCKET, path, method: 'POST', headers: { Host: 'localhost' } };
    const req = http.request(options, (res) => {
      // Errores HTTP "duros" (auth, etc.): leer el cuerpo y rechazar.
      if (res.statusCode >= 400) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => reject(new Error(Buffer.concat(chunks).toString() || `HTTP ${res.statusCode}`)));
        res.on('error', reject);
        return;
      }
      const state = { layers: {} };
      let lastPct = -1;
      let lastPhase = '';
      let buf = '';
      let failed = null;
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buf += chunk;
        let nl;
        // Procesar solo líneas completas; el resto queda en buf para el próximo chunk.
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let event;
          try { event = JSON.parse(line); } catch (_) { continue; }
          const p = accumulatePullProgress(state, event);
          if (p.error) { failed = p.error; continue; }
          if (p.pct !== lastPct) { lastPct = p.pct; write(`__TXPL_PROGRESS__${p.pct}\n`); }
          // Log de fase: avisa cuando pasa de descargar a extraer capas.
          if (p.phase !== lastPhase) {
            lastPhase = p.phase;
            if (p.phase === 'extracción') write('⏳ Extrayendo capas de la imagen...\n');
          }
        }
      });
      res.on('end', () => (failed ? reject(new Error(failed)) : resolve()));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

// Localiza el contenedor txpl-n8n. Devuelve { exists, running } (o docker:false).
async function inspectContainer() {
  try {
    const r = await dockerRequest('GET', '/containers/json?all=1');
    if (r.statusCode >= 400) return { docker: true, exists: false, running: false };
    const list = JSON.parse(r.body.toString());
    const c = list.find((x) => (x.Names || []).some((n) => n === `/${N8N_CONTAINER}`));
    if (!c) return { docker: true, exists: false, running: false };
    return { docker: true, exists: true, running: c.State === 'running' };
  } catch (_) {
    return { docker: false, exists: false, running: false };
  }
}

// Devuelve la config de conexión con la API key descifrada, o lanza si falta.
function getConnectedConfig() {
  const cfg = queries.getN8nConfig.get();
  if (!cfg || !cfg.api_key_enc) {
    const err = new Error('n8n no está configurado. Conecta la API key primero.');
    err.code = 'NO_CONFIG';
    throw err;
  }
  // El backend SIEMPRE llama a n8n por loopback (no por la IP pública/dominio):
  // fiable y sin depender de hairpin NAT ni DNS.
  return {
    apiBase: buildLocalApiBase(cfg.host_port || N8N_PORT),
    apiKey: decryptSecret(cfg.api_key_enc),
    base_url: cfg.base_url,
    domain: cfg.domain,
  };
}

// GET /status — estado para que el frontend decida la vista.
router.get('/status', wrap(async (req, res) => {
  const insp = await inspectContainer();
  const cfg = queries.getN8nConfig.get();
  const hasApiKey = !!(cfg && cfg.api_key_enc);
  const status = computeN8nStatus({ containerExists: insp.exists, running: insp.running, hasApiKey });
  ok(res, {
    docker: insp.docker,
    ...status,
    base_url: (cfg && cfg.base_url) || null,
    domain: (cfg && cfg.domain) || null,
    host_port: (cfg && cfg.host_port) || N8N_PORT,
  });
}));

// POST /config — guarda la API key tras validarla contra n8n. El backend usa
// SIEMPRE loopback para hablar con n8n, así que no pedimos ninguna URL al usuario.
router.post('/config', wrap(async (req, res) => {
  const apiKey = String((req.body && req.body.api_key) || '').trim();
  if (!apiKey) return fail(res, 400, 'Falta la API key de n8n. Genérala en n8n → Settings → API.');

  const prev = queries.getN8nConfig.get() || {};
  const hostPort = prev.host_port || N8N_PORT;
  const apiBase = buildLocalApiBase(hostPort);

  // Validar la key llamando una vez a la API (por loopback). Si falla, no guardamos.
  try {
    await n8nApi(apiBase, apiKey, 'GET', '/api/v1/workflows?limit=1');
  } catch (e) {
    return fail(res, 400, `No pude validar la API key contra n8n: ${e.message}`);
  }

  queries.saveN8nConfig.run({
    base_url: prev.base_url || apiBase,
    api_key_enc: encryptSecret(apiKey),
    container_id: prev.container_id || null,
    domain: prev.domain || null,
    host_port: hostPort,
    status: 'configured',
    created_at: prev.created_at || new Date().toISOString(),
  });
  audit(req.user.username, clientIp(req), 'n8n.config', apiBase);
  ok(res);
}));

// POST /install — descarga la imagen y crea el contenedor, transmitiendo el
// progreso en vivo. Opcionalmente crea un vhost Nginx si se indica dominio.
router.post('/install', wrap(async (req, res) => {
  const hostPort = parseInt((req.body && req.body.host_port) || N8N_PORT, 10) || N8N_PORT;
  const domainRaw = String((req.body && req.body.domain) || '').trim();
  const timezone = String((req.body && req.body.timezone) || 'UTC').trim() || 'UTC';
  let domain = null;
  if (domainRaw) {
    if (!isValidDomain(domainRaw)) return fail(res, 400, 'Dominio inválido.');
    domain = domainRaw;
  }

  // Cabeceras de streaming (mismo patrón que plugins).
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const write = (s) => res.write(s);
  const done = (code) => res.end(`\n__TXPL_DONE__${code}`);

  write('▶ Instalando n8n...\n\n');
  audit(req.user.username, clientIp(req), 'n8n.install', domain || `puerto ${hostPort}`);

  try {
    if (!fs.existsSync(DOCKER_SOCKET)) {
      write('✖ Docker no está instalado. Instálalo primero desde la sección Plugins.\n');
      return done(1);
    }

    // 1. Descargar imagen (con tag fijo: una sola imagen, no todas las etiquetas).
    write(`⏳ Descargando imagen ${N8N_IMAGE}:${N8N_TAG}...\n`);
    try {
      await pullImageWithProgress(N8N_IMAGE, N8N_TAG, write);
    } catch (e) {
      write(`✖ Error al descargar la imagen: ${e.message}\n`);
      return done(1);
    }
    write(`✓ Imagen ${N8N_IMAGE}:${N8N_TAG} lista.\n`);

    // 2. Si ya existe un contenedor previo, borrarlo (mantiene el volumen).
    await dockerRequest('DELETE', `/containers/${N8N_CONTAINER}?force=1`).catch(() => {});

    // 3. Crear contenedor con volumen persistente.
    const config = buildN8nContainerConfig({ hostPort, domain, timezone });
    write('⏳ Creando contenedor con volumen persistente n8n_data...\n');
    const create = await dockerRequest('POST', `/containers/create?name=${encodeURIComponent(N8N_CONTAINER)}`, config);
    if (create.statusCode >= 400) { write(`✖ Error al crear el contenedor: ${create.body.toString()}\n`); return done(1); }
    const containerId = JSON.parse(create.body.toString()).Id;

    // 4. Arrancar.
    const start = await dockerRequest('POST', `/containers/${N8N_CONTAINER}/start`);
    if (start.statusCode >= 400) { write(`✖ Contenedor creado pero falló al iniciar: ${start.body.toString()}\n`); return done(1); }
    write('✓ Contenedor n8n en marcha.\n');

    // 5. Proxy Nginx opcional.
    if (domain) {
      write(`⏳ Configurando proxy Nginx para ${domain}...\n`);
      try {
        await nginx.enableSite(N8N_CONF_NAME, nginx.buildProxy(domain, hostPort));
        write('✓ Proxy Nginx activo. Recuerda apuntar el DNS y emitir SSL desde la sección SSL.\n');
      } catch (e) {
        write(`⚠ El contenedor corre, pero falló el proxy Nginx: ${e.message}\n`);
      }
    }

    // 6. Guardar config base (sin API key todavía; se conecta después).
    const base_url = domain ? `https://${domain}` : `http://localhost:${hostPort}`;
    const prev = queries.getN8nConfig.get() || {};
    queries.saveN8nConfig.run({
      base_url,
      api_key_enc: prev.api_key_enc || null,
      container_id: containerId,
      domain: domain || null,
      host_port: hostPort,
      status: 'installed',
      created_at: prev.created_at || new Date().toISOString(),
    });

    write('\n✅ n8n instalado. Ahora ábrelo, crea tu cuenta y genera tu API key en Settings → API.\n');
    return done(0);
  } catch (e) {
    write(`\n✖ Error inesperado: ${e.message}\n`);
    return done(1);
  }
}));

// Helper: responde 409 claro si n8n no está configurado; si no, ejecuta fn.
async function withN8n(res, fn) {
  let call;
  try {
    call = (method, apiPath, body) => module.exports.n8nApiCall(method, apiPath, body);
    getConnectedConfig(); // lanza NO_CONFIG si falta
  } catch (e) {
    if (e.code === 'NO_CONFIG') return fail(res, 409, e.message);
    throw e;
  }
  try {
    return await fn(call);
  } catch (e) {
    return fail(res, e.status || 502, `n8n no respondió correctamente: ${e.message}`);
  }
}

// GET /workflows — lista workflows con su estado y (si tiene) su ruta de webhook.
router.get('/workflows', wrap(async (req, res) => {
  await withN8n(res, async (call) => {
    const data = await call('GET', '/api/v1/workflows');
    const items = (data && data.data) || [];
    const workflows = items.map((w) => {
      // Detectar un nodo Webhook para exponer su ruta de producción.
      let webhookPath = null;
      for (const node of (w.nodes || [])) {
        if (node.type && node.type.includes('webhook') && node.parameters && node.parameters.path) {
          webhookPath = node.parameters.path;
          break;
        }
      }
      return {
        id: w.id,
        name: w.name,
        active: !!w.active,
        tags: (w.tags || []).map((t) => (typeof t === 'string' ? t : t.name)),
        webhookPath,
      };
    });
    ok(res, { workflows });
  });
}));

// POST /workflows/:id/activate — activa un workflow.
router.post('/workflows/:id/activate', wrap(async (req, res) => {
  await withN8n(res, async (call) => {
    await call('POST', `/api/v1/workflows/${encodeURIComponent(req.params.id)}/activate`);
    audit(req.user.username, clientIp(req), 'n8n.workflow.activate', req.params.id);
    ok(res);
  });
}));

// POST /workflows/:id/deactivate — desactiva un workflow.
router.post('/workflows/:id/deactivate', wrap(async (req, res) => {
  await withN8n(res, async (call) => {
    await call('POST', `/api/v1/workflows/${encodeURIComponent(req.params.id)}/deactivate`);
    audit(req.user.username, clientIp(req), 'n8n.workflow.deactivate', req.params.id);
    ok(res);
  });
}));

// GET /executions — últimas ejecuciones con su estado.
router.get('/executions', wrap(async (req, res) => {
  await withN8n(res, async (call) => {
    const data = await call('GET', '/api/v1/executions?limit=20&includeData=false');
    const items = (data && data.data) || [];
    const executions = items.map((e) => ({
      id: e.id,
      workflowName: (e.workflowData && e.workflowData.name) || e.workflowId || '—',
      status: e.status || (e.finished ? 'success' : 'running'),
      startedAt: e.startedAt || e.createdAt || null,
    }));
    ok(res, { executions });
  });
}));

// POST /:action — start | stop | restart del contenedor.
router.post('/:action', wrap(async (req, res) => {
  const action = req.params.action;
  if (!['start', 'stop', 'restart'].includes(action)) return fail(res, 400, 'Acción no permitida.');
  const insp = await inspectContainer();
  if (!insp.exists) return fail(res, 404, 'n8n no está instalado.');
  const r = await dockerRequest('POST', `/containers/${N8N_CONTAINER}/${action}`);
  if (r.statusCode >= 400) return fail(res, r.statusCode, `Error al ${action}: ${r.body.toString()}`);
  audit(req.user.username, clientIp(req), `n8n.${action}`, null);
  ok(res);
}));

// DELETE / — desinstala: borra contenedor y (opcional) volumen y vhost.
router.delete('/', wrap(async (req, res) => {
  const removeVolume = req.query.volume === 'true';
  const cfg = queries.getN8nConfig.get();
  // Borrar el contenedor (force).
  const del = await dockerRequest('DELETE', `/containers/${N8N_CONTAINER}?v=${removeVolume ? 1 : 0}&force=1`);
  if (del.statusCode >= 400 && del.statusCode !== 404) {
    return fail(res, del.statusCode, `Error al borrar el contenedor: ${del.body.toString()}`);
  }
  // Borrar el vhost de Nginx si había dominio.
  if (cfg && cfg.domain) { try { await nginx.removeSite(N8N_CONF_NAME); } catch (_) {} }
  queries.clearN8nConfig.run();
  audit(req.user.username, clientIp(req), 'n8n.uninstall', removeVolume ? 'con volumen' : 'sin volumen');
  ok(res);
}));

module.exports = router;
module.exports.getConnectedConfig = getConnectedConfig;
module.exports.n8nApiCall = (method, apiPath, body) => {
  const { apiBase, apiKey } = getConnectedConfig();
  return n8nApi(apiBase, apiKey, method, apiPath, body);
};
