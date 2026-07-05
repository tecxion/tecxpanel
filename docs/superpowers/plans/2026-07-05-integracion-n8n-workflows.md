# Integración de n8n (Workflows) — Plan de Implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Añadir a TecXPaneL una sección "Workflows" que instala n8n en Docker, guarda su API key cifrada, y muestra/controla workflows y ejecuciones vía la Public API de n8n (editar = deep-link a n8n).

**Architecture:** Un módulo backend dedicado. Los helpers puros y testeables viven en `backend/lib/n8n.js` (config del contenedor, cliente HTTP de la API, lógica de estado). El router `backend/routes/n8n.js` cablea la base de datos (tabla `n8n_config`), el socket de Docker (`dockerRequest`) y el proxy Nginx (`lib/nginx`). El frontend añade una vista adaptativa que reutiliza el patrón de streaming de plugins y el helper `req()`.

**Tech Stack:** Node.js + Express, better-sqlite3, Docker API vía UNIX socket, `node:test`, frontend vanilla JS.

## Global Constraints

- **Idioma:** UI, comentarios, mensajes de error y commits en **español** (convención del proyecto).
- **Sin dependencias npm nuevas.** Tests con el runner nativo `node:test`.
- **Comandos del sistema con `execFile`/array** (nunca interpolación de strings). Usar `run`/`runSafe` de `lib/helpers.js`.
- **Secretos cifrados en reposo** con `encryptSecret`/`decryptSecret` de `lib/crypto.js`.
- **Sin fallos silenciosos:** devolver la salida real de errores; nada de `|| true` que oculte fallos.
- **Sin secretos hardcodeados:** el repo es público; la API key de n8n se **solicita** siempre y se cifra, nunca hay un valor por defecto.
- **Auditoría:** toda acción mutadora pasa por `audit(user, ip, action, detail)`.
- **Rutas específicas antes que genéricas** en Express (una ruta `/:action` genérica debe ir DESPUÉS de las rutas concretas).
- Todas las rutas cuelgan de `/api/n8n` y quedan bajo el middleware `auth` (JWT), igual que el resto salvo login/webhooks.
- El contenedor se llama **`txpl-n8n`**; el volumen persistente **`n8n_data`** montado en `/home/node/.n8n`; imagen **`n8nio/n8n`**; puerto interno **5678**.

---

### Task 1: Tabla `n8n_config` y queries en la base de datos

**Files:**
- Modify: `backend/database.js` (bloque de `CREATE TABLE`, y objeto `queries`)

**Interfaces:**
- Produces (exportadas en `queries` desde `backend/database.js`):
  - `queries.getN8nConfig` → `.get()` devuelve la fila `{ id, base_url, api_key_enc, container_id, domain, host_port, status, created_at }` o `undefined`.
  - `queries.saveN8nConfig` → `.run({ base_url, api_key_enc, container_id, domain, host_port, status, created_at })` (upsert de la fila única `id=1`).
  - `queries.clearN8nConfig` → `.run()` borra la fila.

- [ ] **Step 1: Añadir la tabla al esquema**

En `backend/database.js`, dentro del bloque que ejecuta los `CREATE TABLE IF NOT EXISTS` (junto a `audit_log`), añadir:

```javascript
  CREATE TABLE IF NOT EXISTS n8n_config (
    id         INTEGER PRIMARY KEY,
    base_url   TEXT,
    api_key_enc TEXT,
    container_id TEXT,
    domain     TEXT,
    host_port  INTEGER,
    status     TEXT,
    created_at TEXT
  );
```

- [ ] **Step 2: Añadir las queries**

En el objeto `queries` de `backend/database.js` (antes del `insertAudit`/`getAuditLog` o junto a ellos), añadir:

```javascript
  // ── n8n (Workflows) ─────────────────────────────────────────
  getN8nConfig: db.prepare('SELECT * FROM n8n_config WHERE id = 1'),
  saveN8nConfig: db.prepare(`
    INSERT INTO n8n_config (id, base_url, api_key_enc, container_id, domain, host_port, status, created_at)
    VALUES (1, @base_url, @api_key_enc, @container_id, @domain, @host_port, @status, @created_at)
    ON CONFLICT(id) DO UPDATE SET
      base_url = excluded.base_url,
      api_key_enc = excluded.api_key_enc,
      container_id = excluded.container_id,
      domain = excluded.domain,
      host_port = excluded.host_port,
      status = excluded.status`),
  clearN8nConfig: db.prepare('DELETE FROM n8n_config WHERE id = 1'),
```

- [ ] **Step 3: Verificar que el módulo carga sin errores**

Run: `node -e "const {queries}=require('./backend/database'); console.log(typeof queries.getN8nConfig.get, typeof queries.saveN8nConfig.run, typeof queries.clearN8nConfig.run)"`
Expected: imprime `function function function` (las prepared statements existen).

- [ ] **Step 4: Commit**

```bash
git add backend/database.js
git commit -m "feat(n8n): tabla n8n_config y queries de conexión"
```

---

### Task 2: Helpers puros de n8n (`backend/lib/n8n.js`) con tests

**Files:**
- Create: `backend/lib/n8n.js`
- Test: `backend/test/n8n.test.js`
- Modify: `package.json` (script `test` para incluir el nuevo fichero)

**Interfaces:**
- Produces (exportadas desde `backend/lib/n8n.js`):
  - `buildN8nContainerConfig({ hostPort, domain, timezone })` → objeto de config para la Docker API (Image `n8nio/n8n`, volumen `n8n_data`, puerto, `RestartPolicy: unless-stopped`, `Env`).
  - `async n8nApi(baseUrl, apiKey, method, apiPath, body = null, fetchImpl = fetch)` → hace la petición HTTP con cabecera `X-N8N-API-KEY`; devuelve el JSON parseado; lanza `Error` con `.status` si la respuesta no es 2xx.
  - `computeN8nStatus({ containerExists, running, hasApiKey })` → `{ state, installed, running, configured }` con `state ∈ {'not_installed','stopped','needs_config','ready'}`.
  - Constante `N8N_CONTAINER = 'txpl-n8n'`, `N8N_VOLUME = 'n8n_data'`, `N8N_IMAGE = 'n8nio/n8n'`, `N8N_PORT = 5678`.

- [ ] **Step 1: Escribir el test que falla**

Crear `backend/test/n8n.test.js`:

```javascript
const { test } = require('node:test');
const assert = require('node:assert');
const n8n = require('../lib/n8n');

test('n8n exporta los helpers y constantes esperados', () => {
  for (const fn of ['buildN8nContainerConfig', 'n8nApi', 'computeN8nStatus']) {
    assert.strictEqual(typeof n8n[fn], 'function', `falta ${fn}`);
  }
  assert.strictEqual(n8n.N8N_CONTAINER, 'txpl-n8n');
  assert.strictEqual(n8n.N8N_VOLUME, 'n8n_data');
  assert.strictEqual(n8n.N8N_IMAGE, 'n8nio/n8n');
  assert.strictEqual(n8n.N8N_PORT, 5678);
});

test('buildN8nContainerConfig: sin dominio => http, cookie insegura, puerto host', () => {
  const c = n8n.buildN8nContainerConfig({ hostPort: 5678, domain: null, timezone: 'Europe/Madrid' });
  assert.strictEqual(c.Image, 'n8nio/n8n');
  assert.deepStrictEqual(c.HostConfig.RestartPolicy, { Name: 'unless-stopped' });
  assert.deepStrictEqual(c.HostConfig.Binds, ['n8n_data:/home/node/.n8n']);
  assert.deepStrictEqual(c.HostConfig.PortBindings, { '5678/tcp': [{ HostPort: '5678' }] });
  assert.deepStrictEqual(c.ExposedPorts, { '5678/tcp': {} });
  assert.ok(c.Env.includes('N8N_PROTOCOL=http'));
  assert.ok(c.Env.includes('N8N_SECURE_COOKIE=false'));
  assert.ok(c.Env.includes('GENERIC_TIMEZONE=Europe/Madrid'));
  assert.ok(c.Env.some((e) => e.startsWith('WEBHOOK_URL=http://localhost:5678')));
});

test('buildN8nContainerConfig: con dominio => https y cookie segura', () => {
  const c = n8n.buildN8nContainerConfig({ hostPort: 5678, domain: 'n8n.midominio.com' });
  assert.ok(c.Env.includes('N8N_HOST=n8n.midominio.com'));
  assert.ok(c.Env.includes('N8N_PROTOCOL=https'));
  assert.ok(c.Env.includes('N8N_SECURE_COOKIE=true'));
  assert.ok(c.Env.some((e) => e === 'WEBHOOK_URL=https://n8n.midominio.com/'));
});

test('computeN8nStatus: transiciones de estado', () => {
  assert.strictEqual(n8n.computeN8nStatus({ containerExists: false, running: false, hasApiKey: false }).state, 'not_installed');
  assert.strictEqual(n8n.computeN8nStatus({ containerExists: true, running: false, hasApiKey: true }).state, 'stopped');
  assert.strictEqual(n8n.computeN8nStatus({ containerExists: true, running: true, hasApiKey: false }).state, 'needs_config');
  const ready = n8n.computeN8nStatus({ containerExists: true, running: true, hasApiKey: true });
  assert.strictEqual(ready.state, 'ready');
  assert.deepStrictEqual(ready, { state: 'ready', installed: true, running: true, configured: true });
});

test('n8nApi: construye URL y cabecera X-N8N-API-KEY, parsea JSON', async () => {
  let captured = null;
  const fakeFetch = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: '1' }] }) };
  };
  const out = await n8n.n8nApi('https://n8n.test/', 'KEY123', 'GET', '/api/v1/workflows?limit=1', null, fakeFetch);
  assert.strictEqual(captured.url, 'https://n8n.test/api/v1/workflows?limit=1');
  assert.strictEqual(captured.opts.headers['X-N8N-API-KEY'], 'KEY123');
  assert.deepStrictEqual(out, { data: [{ id: '1' }] });
});

test('n8nApi: respuesta no-2xx lanza Error con .status', async () => {
  const fakeFetch = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ message: 'unauthorized' }) });
  await assert.rejects(
    () => n8n.n8nApi('https://n8n.test', 'BAD', 'GET', '/api/v1/workflows', null, fakeFetch),
    (e) => e.status === 401 && /401/.test(e.message)
  );
});
```

- [ ] **Step 2: Ejecutar el test para verificar que falla**

Run: `node --test backend/test/n8n.test.js`
Expected: FAIL con `Cannot find module '../lib/n8n'`.

- [ ] **Step 3: Implementar `backend/lib/n8n.js`**

Crear `backend/lib/n8n.js`:

```javascript
'use strict';

// ============================================================
//  TecXPaneL — Helpers puros de n8n (Workflows)
//
//  Funciones sin estado ni dependencias del servidor, para poder
//  testearlas de forma aislada: config del contenedor Docker,
//  cliente HTTP de la Public API de n8n y cálculo de estado.
// ============================================================

const N8N_CONTAINER = 'txpl-n8n';
const N8N_VOLUME = 'n8n_data';
const N8N_IMAGE = 'n8nio/n8n';
const N8N_PORT = 5678;

// Construye la config que se envía a la Docker API para crear el contenedor n8n.
//  - hostPort: puerto del VPS que se mapea al 5678 interno.
//  - domain:   si hay dominio (proxy + SSL) => https y cookie segura; si no, http.
//  - timezone: zona horaria para los nodos de fecha/cron de n8n.
function buildN8nContainerConfig({ hostPort = N8N_PORT, domain = null, timezone = 'UTC' } = {}) {
  const protocol = domain ? 'https' : 'http';
  const host = domain || 'localhost';
  const webhookUrl = domain ? `https://${domain}/` : `http://localhost:${hostPort}/`;
  const env = [
    `N8N_HOST=${host}`,
    `N8N_PORT=${N8N_PORT}`,
    `N8N_PROTOCOL=${protocol}`,
    `GENERIC_TIMEZONE=${timezone}`,
    `WEBHOOK_URL=${webhookUrl}`,
    // Sin HTTPS el navegador rechaza la cookie de sesión "secure"; en acceso por
    // dominio con SSL sí la exigimos.
    `N8N_SECURE_COOKIE=${domain ? 'true' : 'false'}`,
  ];
  const cPort = `${N8N_PORT}/tcp`;
  return {
    Image: N8N_IMAGE,
    Env: env,
    ExposedPorts: { [cPort]: {} },
    HostConfig: {
      RestartPolicy: { Name: 'unless-stopped' },
      PortBindings: { [cPort]: [{ HostPort: String(hostPort) }] },
      Binds: [`${N8N_VOLUME}:/home/node/.n8n`],
    },
    Labels: domain ? { 'txpl.domain': domain } : {},
  };
}

// Cliente HTTP mínimo para la Public API de n8n. fetchImpl es inyectable para test.
async function n8nApi(baseUrl, apiKey, method, apiPath, body = null, fetchImpl = fetch) {
  const url = String(baseUrl).replace(/\/+$/, '') + apiPath;
  const headers = { 'X-N8N-API-KEY': apiKey, 'Accept': 'application/json' };
  const opts = { method, headers };
  if (body) { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetchImpl(url, opts);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = text; }
  if (!res.ok) {
    const msg = (data && typeof data === 'object' && data.message) ? data.message
      : (typeof data === 'string' && data) ? data : 'error desconocido';
    const err = new Error(`n8n API ${res.status}: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Deriva el estado de alto nivel que consume el frontend para decidir la vista.
function computeN8nStatus({ containerExists, running, hasApiKey }) {
  if (!containerExists) return { state: 'not_installed', installed: false, running: false, configured: false };
  if (!running) return { state: 'stopped', installed: true, running: false, configured: !!hasApiKey };
  if (!hasApiKey) return { state: 'needs_config', installed: true, running: true, configured: false };
  return { state: 'ready', installed: true, running: true, configured: true };
}

module.exports = {
  N8N_CONTAINER, N8N_VOLUME, N8N_IMAGE, N8N_PORT,
  buildN8nContainerConfig, n8nApi, computeN8nStatus,
};
```

- [ ] **Step 4: Ejecutar el test para verificar que pasa**

Run: `node --test backend/test/n8n.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Incluir el nuevo fichero en el script `test`**

En `package.json`, cambiar el script `test` para que ejecute ambos ficheros:

```json
    "test": "node --test backend/test/"
```

(usar el directorio ejecuta todos los `*.test.js`). Verificar:
Run: `npm test`
Expected: PASS de `appdeploy.test.js` y `n8n.test.js` juntos.

- [ ] **Step 6: Commit**

```bash
git add backend/lib/n8n.js backend/test/n8n.test.js package.json
git commit -m "feat(n8n): helpers puros (config contenedor, cliente API, estado) + tests"
```

---

### Task 3: Router n8n — ciclo de vida (instalar/configurar/estado)

**Files:**
- Create: `backend/routes/n8n.js`
- Modify: `backend/server.js` (montar el router)

**Interfaces:**
- Consumes: `queries.getN8nConfig/saveN8nConfig/clearN8nConfig` (Task 1); `buildN8nContainerConfig`, `n8nApi`, `computeN8nStatus`, `N8N_CONTAINER`, `N8N_IMAGE`, `N8N_PORT` (Task 2); `dockerRequest` (patrón de `routes/docker.js` — se replica localmente); `encryptSecret`/`decryptSecret` (`lib/crypto`); `enableSite`/`removeSite`/`buildProxy` (`lib/nginx`); `ok`/`fail`/`clientIp`/`wrap` (`lib/helpers`); `audit` (`database`).
- Produces (rutas montadas en `/api/n8n`):
  - `GET /status` → `{ docker: bool, ...computeN8nStatus(), base_url, domain, host_port }`.
  - `POST /install` → streaming `text/plain` con marcador `__TXPL_DONE__<code>`.
  - `POST /config` → `{ success: true }` o `fail` con mensaje.
  - `POST /:action` (`start|stop|restart`) → `{ success: true }`.
  - `DELETE /` → `{ success: true }`.
  - Helper interno `getConnectedConfig()` → `{ base_url, apiKey }` descifrada, o lanza si falta config (lo reutiliza Task 4).

- [ ] **Step 1: Crear el router con `dockerRequest`, `/status`, `/config`, `/:action`, `DELETE`**

Crear `backend/routes/n8n.js`:

```javascript
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
  buildN8nContainerConfig, n8nApi, computeN8nStatus,
  N8N_CONTAINER, N8N_IMAGE, N8N_PORT,
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
  if (!cfg || !cfg.base_url || !cfg.api_key_enc) {
    const err = new Error('n8n no está configurado. Conecta la API key primero.');
    err.code = 'NO_CONFIG';
    throw err;
  }
  return { base_url: cfg.base_url, apiKey: decryptSecret(cfg.api_key_enc), domain: cfg.domain };
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

// POST /config — guarda base_url + API key tras validarla contra n8n.
router.post('/config', wrap(async (req, res) => {
  const base_url = String((req.body && req.body.base_url) || '').trim();
  const apiKey = String((req.body && req.body.api_key) || '').trim();
  if (!/^https?:\/\/.+/.test(base_url)) return fail(res, 400, 'La URL base debe empezar por http:// o https://');
  if (!apiKey) return fail(res, 400, 'Falta la API key de n8n. Genérala en n8n → Settings → API.');

  // Validar la key llamando una vez a la API. Si falla, no guardamos nada.
  try {
    await n8nApi(base_url, apiKey, 'GET', '/api/v1/workflows?limit=1');
  } catch (e) {
    return fail(res, 400, `No pude validar la API key contra n8n: ${e.message}`);
  }

  const prev = queries.getN8nConfig.get() || {};
  queries.saveN8nConfig.run({
    base_url,
    api_key_enc: encryptSecret(apiKey),
    container_id: prev.container_id || null,
    domain: prev.domain || null,
    host_port: prev.host_port || N8N_PORT,
    status: 'configured',
    created_at: prev.created_at || new Date().toISOString(),
  });
  audit(req.user.username, clientIp(req), 'n8n.config', base_url);
  ok(res);
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
  const { base_url, apiKey } = getConnectedConfig();
  return n8nApi(base_url, apiKey, method, apiPath, body);
};
```

> Nota: la ruta genérica `POST /:action` va al final; en Task 4 las rutas concretas de orquestación (`/workflows`, `/executions`) se insertarán **antes** de `POST /:action` para no quedar sombreadas.

- [ ] **Step 2: Añadir el `POST /install` (streaming) antes de `POST /:action`**

En `backend/routes/n8n.js`, **antes** de `router.post('/:action', ...)`, añadir el endpoint de instalación por streaming:

```javascript
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

    // 1. Descargar imagen.
    write(`⏳ Descargando imagen ${N8N_IMAGE}...\n`);
    const pull = await dockerRequest('POST', `/images/create?fromImage=${encodeURIComponent(N8N_IMAGE)}`);
    if (pull.statusCode >= 400) { write(`✖ Error al descargar la imagen: ${pull.body.toString()}\n`); return done(1); }
    write('✓ Imagen lista.\n');

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
```

- [ ] **Step 3: Montar el router en `server.js`**

En `backend/server.js`, junto al resto de `app.use('/api/...')` (después de `app.use('/api/docker', ...)`), añadir:

```javascript
app.use('/api/n8n', require('./routes/n8n'));
```

- [ ] **Step 4: Verificar que el servidor carga sin errores de sintaxis**

Run: `node -e "require('./backend/routes/n8n'); console.log('n8n router OK')"`
Expected: imprime `n8n router OK` (sin lanzar).

Run: `node --check backend/server.js && echo "server.js OK"`
Expected: imprime `server.js OK`.

- [ ] **Step 5: Verificación manual del estado (sin Docker en dev)**

En Windows/dev sin socket Docker, `GET /api/n8n/status` debe responder `docker:false, state:'not_installed'` sin romper. (Se probará vía UI en Task 5; aquí basta la carga sin errores del paso 4.)

- [ ] **Step 6: Commit**

```bash
git add backend/routes/n8n.js backend/server.js
git commit -m "feat(n8n): router de ciclo de vida (status, install streaming, config, acciones, borrar)"
```

---

### Task 4: Router n8n — orquestación (workflows y ejecuciones)

**Files:**
- Modify: `backend/routes/n8n.js` (añadir rutas de orquestación ANTES de `POST /:action`)

**Interfaces:**
- Consumes: helper interno `n8nApiCall(method, apiPath, body)` y `getConnectedConfig()` (Task 3).
- Produces (montadas en `/api/n8n`):
  - `GET /workflows` → `{ workflows: [{ id, name, active, tags, webhookPath|null }] }`.
  - `POST /workflows/:id/activate` · `POST /workflows/:id/deactivate` → `{ success: true }`.
  - `GET /executions` → `{ executions: [{ id, workflowName, status, startedAt }] }`.

- [ ] **Step 1: Añadir un manejador de errores de config reutilizable y las rutas de orquestación**

En `backend/routes/n8n.js`, **justo antes** de `router.post('/:action', ...)`, insertar:

```javascript
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
```

- [ ] **Step 2: Verificar que el router sigue cargando y el orden de rutas es correcto**

Run: `node -e "require('./backend/routes/n8n'); console.log('n8n orquestación OK')"`
Expected: imprime `n8n orquestación OK`.

Comprobar visualmente que en el fichero las rutas `GET /workflows`, `POST /workflows/:id/activate`, `POST /workflows/:id/deactivate` y `GET /executions` están **antes** de `router.post('/:action', ...)`.

- [ ] **Step 3: Commit**

```bash
git add backend/routes/n8n.js
git commit -m "feat(n8n): rutas de orquestacion (workflows, activar/desactivar, ejecuciones)"
```

---

### Task 5: Frontend — sección "Workflows" (vista adaptativa)

**Files:**
- Create: `frontend/views/pages/n8n.html`
- Modify: `frontend/views/sidebar.html` (enlace de navegación)
- Modify: `frontend/index.html` (contenedor `page-n8n`)
- Modify: `frontend/js/app.js` (registro de página + lógica `loadN8n` y acciones)

**Interfaces:**
- Consumes: endpoints `/api/n8n/*` (Tasks 3-4); helpers frontend existentes `req(method, path, body)`, `toast(msg, type)`, `navigate(el)`, patrón de streaming de `streamPlugin`.
- Produces: función global `loadN8n()` (invocada por `navigate` al abrir la página) y handlers `n8nInstall()`, `n8nSaveConfig()`, `n8nAction(action)`, `n8nToggleWorkflow(id, active)`, `n8nUninstall()`.

- [ ] **Step 1: Crear la plantilla de la página**

Crear `frontend/views/pages/n8n.html`:

```html
<div class="page-header">
  <h1><i class="ti ti-sitemap"></i> Workflows (n8n)</h1>
  <p class="page-desc">Automatiza flujos con n8n integrado en tu VPS. Edita en n8n; controla y monitoriza desde aquí.</p>
</div>

<!-- Estado dinámico: lo rellena loadN8n() según GET /api/n8n/status -->
<div id="n8n-body"><div class="card"><p>Cargando estado de n8n...</p></div></div>

<!-- Consola de streaming reutilizable para la instalación -->
<div class="console-wrap" id="n8n-console" style="display:none">
  <div class="console-head">
    <span id="n8n-console-title">Instalando n8n</span>
    <span id="n8n-console-spinner" class="spinner" style="display:none"></span>
  </div>
  <pre class="console-output" id="n8n-console-output"></pre>
</div>
```

- [ ] **Step 2: Registrar la página en el sidebar, index y array de páginas**

En `frontend/views/sidebar.html`, dentro de la sección `Servicios` (después del enlace de Docker), añadir:

```html
<div class="nav-item" data-page="n8n" onclick="navigate(this)">
  <i class="ti ti-sitemap"></i> Workflows
</div>
```

En `frontend/index.html`, junto a los demás `<div class="page" id="page-...">`, añadir:

```html
      <div class="page" id="page-n8n"></div>
```

En `frontend/js/app.js`, dentro de `loadTemplates()`, añadir `'n8n'` al array `pages`:

```javascript
  const pages = [
    'dashboard', 'terminal', 'websites', 'apps', 'databases',
    'docker', 'n8n', 'files', 'firewall', 'ssl', 'logs', 'plugins',
    'help', 'settings'
  ];
```

- [ ] **Step 3: Enganchar `loadN8n()` en la navegación**

En `frontend/js/app.js`, localizar la función `navigate(el)` (línea ~262) y el punto donde se despacha la carga por página (por ejemplo un `switch (page)` o los `if (page === 'plugins') loadPlugins()`). Añadir el caso para n8n siguiendo el mismo patrón que ya usan las demás páginas:

```javascript
  if (page === 'n8n') loadN8n();
```

(Colócalo junto a las otras llamadas `load*()` dentro de `navigate`.)

- [ ] **Step 4: Implementar la lógica de la sección**

En `frontend/js/app.js`, cerca del bloque de plugins (`streamPlugin`), añadir:

```javascript
// ── n8n (Workflows) ───────────────────────────────────────────
// Carga el estado y pinta la vista adaptativa (instalar / conectar / dashboard).
async function loadN8n() {
  const body = document.getElementById('n8n-body');
  body.innerHTML = '<div class="card"><p>Cargando estado de n8n...</p></div>';
  const st = await req('GET', '/n8n/status');
  if (!st) return;

  if (!st.docker) {
    body.innerHTML = `<div class="card">
      <h3>Docker no está instalado</h3>
      <p>n8n corre en un contenedor Docker. Instala Docker primero desde la sección Plugins.</p>
      <button class="btn" onclick="navigate(document.querySelector('[data-page=plugins]'))">Ir a Plugins</button>
    </div>`;
    return;
  }

  if (st.state === 'not_installed') {
    body.innerHTML = `<div class="card">
      <h3>Instalar n8n</h3>
      <p>Se creará un contenedor con volumen persistente. El dominio y el SSL son opcionales.</p>
      <div class="form-row"><label>Puerto host</label><input id="n8n-port" type="number" value="5678"></div>
      <div class="form-row"><label>Dominio (opcional)</label><input id="n8n-domain" type="text" placeholder="n8n.midominio.com"></div>
      <div class="form-row"><label>Zona horaria</label><input id="n8n-tz" type="text" value="Europe/Madrid"></div>
      <button class="btn btn-primary" onclick="n8nInstall()">Instalar n8n</button>
    </div>`;
    return;
  }

  if (st.state === 'stopped') {
    body.innerHTML = `<div class="card">
      <h3>n8n está parado</h3>
      <button class="btn btn-primary" onclick="n8nAction('start')">Iniciar</button>
      <button class="btn btn-danger" onclick="n8nUninstall()">Desinstalar</button>
    </div>`;
    return;
  }

  if (st.state === 'needs_config') {
    const url = st.base_url || '';
    body.innerHTML = `<div class="card">
      <h3>Conectar con n8n</h3>
      <ol>
        <li>Abre n8n y crea tu cuenta de propietario.</li>
        <li>Ve a <strong>Settings → API</strong> y genera tu API key.</li>
        <li>Pégala aquí abajo.</li>
      </ol>
      <a class="btn" href="${url}" target="_blank" rel="noopener">Abrir n8n</a>
      <div class="form-row"><label>URL base</label><input id="n8n-baseurl" type="text" value="${url}"></div>
      <div class="form-row"><label>API key</label><input id="n8n-apikey" type="password" placeholder="n8n_api_..."></div>
      <button class="btn btn-primary" onclick="n8nSaveConfig()">Conectar</button>
    </div>`;
    return;
  }

  // state === 'ready' → dashboard
  body.innerHTML = `<div class="card">
    <div class="card-actions">
      <a class="btn" href="${st.base_url}" target="_blank" rel="noopener">Abrir en n8n</a>
      <button class="btn" onclick="n8nAction('restart')">Reiniciar</button>
      <button class="btn" onclick="n8nAction('stop')">Detener</button>
      <button class="btn btn-danger" onclick="n8nUninstall()">Desinstalar</button>
    </div>
  </div>
  <div class="card"><h3>Workflows</h3><div id="n8n-workflows">Cargando...</div></div>
  <div class="card"><h3>Ejecuciones recientes</h3><div id="n8n-executions">Cargando...</div></div>`;

  loadN8nWorkflows(st.base_url);
  loadN8nExecutions();
}

async function loadN8nWorkflows(baseUrl) {
  const el = document.getElementById('n8n-workflows');
  const r = await req('GET', '/n8n/workflows');
  if (!r || !r.workflows) { el.textContent = 'No pude cargar los workflows.'; return; }
  if (r.workflows.length === 0) { el.textContent = 'Aún no hay workflows. Créalos en n8n.'; return; }
  el.innerHTML = '<table class="tbl"><thead><tr><th>Nombre</th><th>Tags</th><th>Estado</th><th></th></tr></thead><tbody>'
    + r.workflows.map((w) => {
      const toggle = w.active
        ? `<button class="btn btn-sm" onclick="n8nToggleWorkflow('${w.id}', true)">Desactivar</button>`
        : `<button class="btn btn-sm btn-primary" onclick="n8nToggleWorkflow('${w.id}', false)">Activar</button>`;
      const editUrl = `${baseUrl}/workflow/${w.id}`;
      const webhook = w.webhookPath
        ? `<br><small>webhook: <code>${baseUrl}/webhook/${w.webhookPath}</code></small>` : '';
      return `<tr>
        <td>${w.name}${webhook}</td>
        <td>${w.tags.join(', ') || '—'}</td>
        <td>${w.active ? '<span class="badge badge-ok">activo</span>' : '<span class="badge">inactivo</span>'}</td>
        <td>${toggle} <a class="btn btn-sm" href="${editUrl}" target="_blank" rel="noopener">Abrir en n8n</a></td>
      </tr>`;
    }).join('') + '</tbody></table>';
}

async function loadN8nExecutions() {
  const el = document.getElementById('n8n-executions');
  const r = await req('GET', '/n8n/executions');
  if (!r || !r.executions) { el.textContent = 'No pude cargar las ejecuciones.'; return; }
  if (r.executions.length === 0) { el.textContent = 'Sin ejecuciones todavía.'; return; }
  const icon = (s) => s === 'success' ? '✓' : (s === 'error' ? '✗' : '⏳');
  el.innerHTML = '<table class="tbl"><thead><tr><th>Workflow</th><th>Estado</th><th>Inicio</th></tr></thead><tbody>'
    + r.executions.map((e) => `<tr>
        <td>${e.workflowName}</td>
        <td>${icon(e.status)} ${e.status}</td>
        <td>${e.startedAt ? new Date(e.startedAt).toLocaleString() : '—'}</td>
      </tr>`).join('') + '</tbody></table>';
}

// Instalación por streaming (reutiliza el patrón de streamPlugin).
async function n8nInstall() {
  const host_port = document.getElementById('n8n-port').value;
  const domain = document.getElementById('n8n-domain').value.trim();
  const timezone = document.getElementById('n8n-tz').value.trim();
  const wrap = document.getElementById('n8n-console');
  const out = document.getElementById('n8n-console-output');
  const spinner = document.getElementById('n8n-console-spinner');
  const DONE = '__TXPL_DONE__';
  wrap.style.display = 'block'; spinner.style.display = 'inline'; out.textContent = '';
  wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  let exitCode = 1;
  try {
    const r = await fetch(API + '/api/n8n/install', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ host_port, domain, timezone }),
    });
    if (r.status === 401) { doLogout(); return; }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
      let display = buffer;
      const idx = buffer.indexOf(DONE);
      if (idx >= 0) { exitCode = parseInt(buffer.slice(idx + DONE.length).trim(), 10) || 0; display = buffer.slice(0, idx); }
      out.textContent = display; out.scrollTop = out.scrollHeight;
    }
  } catch (e) {
    out.textContent += '\n✖ Error de conexión: ' + (e?.message || e);
  }
  spinner.style.display = 'none';
  toast(exitCode === 0 ? 'n8n instalado' : 'La instalación terminó con errores', exitCode === 0 ? 'success' : 'error');
  loadN8n();
}

async function n8nSaveConfig() {
  const base_url = document.getElementById('n8n-baseurl').value.trim();
  const api_key = document.getElementById('n8n-apikey').value.trim();
  const r = await req('POST', '/n8n/config', { base_url, api_key });
  if (!r) return;
  if (r.error) { toast(r.error, 'error'); return; }
  toast('n8n conectado', 'success');
  loadN8n();
}

async function n8nAction(action) {
  const r = await req('POST', '/n8n/' + action);
  if (!r) return;
  if (r.error) { toast(r.error, 'error'); return; }
  toast('n8n: ' + action, 'success');
  loadN8n();
}

async function n8nToggleWorkflow(id, active) {
  const path = `/n8n/workflows/${id}/${active ? 'deactivate' : 'activate'}`;
  const r = await req('POST', path);
  if (!r) return;
  if (r.error) { toast(r.error, 'error'); return; }
  toast(active ? 'Workflow desactivado' : 'Workflow activado', 'success');
  loadN8nWorkflows((await req('GET', '/n8n/status')).base_url);
}

async function n8nUninstall() {
  if (!confirm('¿Desinstalar n8n? El contenedor se elimina. ¿Borrar también el volumen con tus datos?')) return;
  const removeVolume = confirm('Aceptar = BORRAR también los datos (volumen). Cancelar = conservar los datos.');
  const r = await req('DELETE', '/n8n?volume=' + (removeVolume ? 'true' : 'false'));
  if (!r) return;
  if (r.error) { toast(r.error, 'error'); return; }
  toast('n8n desinstalado', 'success');
  loadN8n();
}
```

- [ ] **Step 5: Verificación manual en el navegador**

Arrancar en dev: `npm run dev`. Entrar al panel, abrir "Workflows" en el sidebar.
Expected (dev sin Docker): la vista muestra "Docker no está instalado" con botón a Plugins, sin errores en consola del navegador. En un VPS con Docker, muestra el formulario "Instalar n8n".

- [ ] **Step 6: Commit**

```bash
git add frontend/views/pages/n8n.html frontend/views/sidebar.html frontend/index.html frontend/js/app.js
git commit -m "feat(n8n): seccion Workflows en el frontend (vista adaptativa + dashboard)"
```

---

### Task 6: Auditoría de secretos en instaladores (principio "repo público")

**Files:**
- Modify: `txpl-setup.sh` (solo si se detectan secretos fijados o falta generación)
- Modify: `.env.example` (solo si contiene secretos reales en vez de placeholders)

**Interfaces:**
- Produces: garantía de que ninguna instalación hereda secretos del autor; `JWT_SECRET`/`TXPL_SECRET_KEY` se generan frescos y `ADMIN_USER`/`ADMIN_PASS` se solicitan o generan por instalación.

- [ ] **Step 1: Buscar secretos hardcodeados en el repo**

Run: `grep -rnE "(JWT_SECRET|TXPL_SECRET_KEY|ADMIN_PASS|API_KEY|TOKEN)\s*=\s*[\"']?[A-Za-z0-9+/_-]{12,}" txpl-setup.sh txpl-update.sh .env.example 2>/dev/null`
Expected: **ningún** valor real (solo placeholders tipo `cambia-esto`, `openssl rand ...`, o vacío). Si aparece un secreto real, es un fallo a corregir en los pasos siguientes.

- [ ] **Step 2: Verificar la generación de secretos en `txpl-setup.sh`**

Run: `grep -nE "openssl rand|JWT_SECRET|TXPL_SECRET_KEY|ADMIN_PASS" txpl-setup.sh`
Expected: `JWT_SECRET` (y a poder ser `TXPL_SECRET_KEY`) se generan con algo como `openssl rand -hex 32`, y `ADMIN_PASS` se solicita (`read`) o se genera. Si `JWT_SECRET` se genera pero `TXPL_SECRET_KEY` no existe, no es un fallo (el código cae a `JWT_SECRET`); documentarlo mentalmente.

- [ ] **Step 3: Corregir si hace falta**

Si el paso 1 encontró un secreto real fijado, sustituirlo por generación fresca. Ejemplo de patrón correcto a usar en `txpl-setup.sh` al escribir el `.env`:

```bash
JWT_SECRET="$(openssl rand -hex 32)"
TXPL_SECRET_KEY="$(openssl rand -hex 32)"
```

Y para `.env.example`, dejar solo placeholders sin valores reales:

```
JWT_SECRET=genera-uno-con-openssl-rand-hex-32
ADMIN_USER=admin
ADMIN_PASS=cambia-esta-contrasena
```

Si el paso 1 no encontró nada y el paso 2 confirmó la generación, **no** modificar ningún fichero (no hay trabajo que hacer) y anotarlo en el commit del cierre.

- [ ] **Step 4: Commit (solo si hubo cambios)**

```bash
git add txpl-setup.sh .env.example
git commit -m "fix(seguridad): sin secretos hardcodeados; generacion fresca por instalacion"
```

Si no hubo cambios, omitir este commit.

---

## Self-Review

**Cobertura del spec:**
- Módulo backend dedicado `routes/n8n.js` → Tasks 3-4. ✓
- Instalación en Docker con volumen + proxy Nginx, por streaming → Task 3 (`POST /install`). ✓
- Tabla `n8n_config` (fila única) + queries → Task 1. ✓
- Asistente de conexión (validar y cifrar API key) → Task 3 (`POST /config`) + Task 5 (vista `needs_config`). ✓
- Dashboard: listar/activar/desactivar workflows, ejecuciones, deep-link, webhook URL → Task 4 + Task 5. ✓
- Helper testeable `n8nApi` + config de contenedor + lógica de estado → Task 2 con tests. ✓
- Sin secretos hardcodeados (n8n + instaladores) → Task 3 (key solicitada y cifrada) + Task 6 (auditoría). ✓
- Manejo de errores sin fallos silenciosos (Docker ausente, pull/creación, key inválida, n8n inaccesible) → Tasks 3-4 (mensajes explícitos, `withN8n` responde 409/502). ✓
- Auditoría de acciones mutadoras → `audit(...)` en install/config/action/uninstall/activate/deactivate. ✓
- Deep-link para editar (no iframe) → Task 5 (`Abrir en n8n`). ✓

**Escaneo de placeholders:** sin "TBD"/"TODO"; todos los pasos con código llevan el código real.

**Consistencia de tipos:** `buildN8nContainerConfig`, `n8nApi`, `computeN8nStatus`, `getConnectedConfig`, `n8nApiCall`, `loadN8n/loadN8nWorkflows/loadN8nExecutions` y los handlers `n8n*` se usan con los mismos nombres/firmas en las tareas que los consumen. El contenedor `txpl-n8n`, volumen `n8n_data` y puerto `5678` son consistentes en backend y tests.

**Nota de alcance:** el disparo manual de workflows queda limitado a exponer la URL de webhook (Task 5 la muestra); no se implementa `/execute` genérico (decisión del spec, YAGNI).
```

