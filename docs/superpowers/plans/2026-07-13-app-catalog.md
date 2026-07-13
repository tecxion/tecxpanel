# Catálogo one-click de aplicaciones — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Página "Catálogo" que instala WordPress, Ghost, Nextcloud, Vaultwarden y Uptime Kuma con un clic, en modo Docker, nativo (PHP-FPM) o PM2 según la app.

**Architecture:** Patrón 3 capas del repo — `lib/catalog.js` (helpers puros, unit-tested), `lib/catalogEngine.js` (efectos: Docker socket, MySQL, Nginx, PM2, filesystem), `routes/catalog.js` (HTTP + streaming `__TXPL_DONE__`). Tabla `catalog_installs` como fuente de la verdad. Generaliza el precedente de n8n.

**Tech Stack:** Node.js + Express, better-sqlite3, socket Docker nativo (`http`), `node:test`.

**Spec:** `docs/superpowers/specs/2026-07-13-app-catalog-design.md`

## Global Constraints

- Rama de trabajo: `feat/catalogo-apps` (nunca en `main`).
- Idioma español en UI, comentarios, mensajes de error y commits.
- `execFile` con arrays SIEMPRE (usar `run`/`runSafe` de `helpers.js`); procesos largos con `{ timeout: 0, maxBuffer: 64 * 1024 * 1024 }`.
- Pull de imágenes Docker SIEMPRE con tag fijado (`buildPullPath` de `lib/n8n.js`).
- Streaming: `Content-Type: text/plain`, `X-Accel-Buffering: no`, `flushHeaders()`, terminar con `__TXPL_DONE__<code>`.
- Errores de negocio con `err.http = 4xx` (los honra `wrap()`).
- Secretos cifrados con `encryptSecret`; nunca en `audit_log` ni en claro en DB.
- Nombres de recursos: contenedor/PM2 `txpl-app-<id>`, volumen `txpl_<id>_data`, vhost Nginx `txpl-app-<id>`.
- Tests con `node:test` sin dependencias externas; solo helpers puros.
- Comandos: `npm test` (todos), `node --test backend/test/catalog.test.js` (este feature).

---

### Task 0: Rama de trabajo

**Files:** ninguno.

- [ ] **Step 1: Crear la rama**

```bash
git checkout -b feat/catalogo-apps
```

---

### Task 1: Tabla `catalog_installs` + queries + exportar `mysqlExec`

**Files:**
- Modify: `backend/database.js` (bloque CREATE TABLE tras `notify_state` ~línea 196; objeto `queries` al final)
- Modify: `backend/routes/databases.js:172` (añadir export)

**Interfaces:**
- Produces: `queries.getCatalogInstall.get(app_id)`, `queries.listCatalogInstalls.all()`, `queries.insertCatalogInstall.run({...})`, `queries.deleteCatalogInstall.run(app_id)`; `require('./routes/databases').mysqlExec(sql)` → `{ ok, stdout, stderr }`.

- [ ] **Step 1: Añadir la tabla al schema de `backend/database.js`** (junto a las demás CREATE TABLE, dentro del mismo `db.exec`):

```sql
  CREATE TABLE IF NOT EXISTS catalog_installs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    app_id TEXT NOT NULL UNIQUE,
    mode TEXT NOT NULL,
    domain TEXT,
    port INTEGER,
    ref TEXT,
    db_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
```

- [ ] **Step 2: Añadir las queries preparadas al objeto `queries`** (sección nueva, al final del objeto):

```js
  // ── Catálogo de aplicaciones ──
  getCatalogInstall:    db.prepare('SELECT * FROM catalog_installs WHERE app_id = ?'),
  listCatalogInstalls:  db.prepare('SELECT * FROM catalog_installs ORDER BY created_at DESC'),
  insertCatalogInstall: db.prepare('INSERT INTO catalog_installs (app_id, mode, domain, port, ref, db_name) VALUES (@app_id, @mode, @domain, @port, @ref, @db_name)'),
  deleteCatalogInstall: db.prepare('DELETE FROM catalog_installs WHERE app_id = ?'),
```

- [ ] **Step 3: Exportar `mysqlExec` desde `backend/routes/databases.js`** (después de `module.exports = router;`):

```js
module.exports.mysqlExec = mysqlExec;
```

- [ ] **Step 4: Verificar que el servidor arranca y los tests pasan**

Run: `npm test`
Expected: PASS (los tests existentes; la tabla se crea sin error al cargar `database.js`).

- [ ] **Step 5: Commit**

```bash
git add backend/database.js backend/routes/databases.js
git commit -m "feat(catalogo): tabla catalog_installs y export de mysqlExec"
```

---

### Task 2: `lib/catalog.js` — CATALOG declarativo + nombres + validación

**Files:**
- Create: `backend/lib/catalog.js`
- Test: `backend/test/catalog.test.js`

**Interfaces:**
- Produces: `CATALOG` (array), `getEntry(id)` → entrada o `null`, `containerName(id)` → `'txpl-app-<id>'`, `pm2Name(id)` → `'txpl-app-<id>'`, `volumeName(id)` → `'txpl_<id>_data'`, `nginxConfName(id)` → `'txpl-app-<id>'`, `validateInstallOptions(entry, opts)` → `{ ok: true, opts: normalizados }` o `{ ok: false, error }`.

- [ ] **Step 1: Escribir los tests que fallan** en `backend/test/catalog.test.js`:

```js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  CATALOG, getEntry, containerName, pm2Name, volumeName, nginxConfName,
  validateInstallOptions,
} = require('../lib/catalog');

test('CATALOG: integridad de todas las entradas', () => {
  assert.ok(Array.isArray(CATALOG) && CATALOG.length === 5);
  const ids = CATALOG.map((e) => e.id);
  assert.deepStrictEqual(ids.sort(), ['ghost', 'nextcloud', 'uptime-kuma', 'vaultwarden', 'wordpress']);
  for (const e of CATALOG) {
    assert.ok(/^[a-z0-9-]+$/.test(e.id), `id inválido: ${e.id}`);
    assert.ok(e.name && e.description, `${e.id}: falta name/description`);
    assert.ok(Array.isArray(e.modes) && e.modes.length >= 1, `${e.id}: modes vacío`);
    for (const m of e.modes) assert.ok(['docker', 'native', 'pm2'].includes(m), `${e.id}: modo ${m}`);
    // Toda app con modo docker declara imagen con TAG FIJADO (nunca vacío ni 'latest' implícito)
    if (e.modes.includes('docker')) {
      assert.ok(e.docker && e.docker.image && e.docker.tag, `${e.id}: docker.image/tag`);
      assert.ok(e.docker.port > 0, `${e.id}: docker.port`);
    }
    assert.ok(e.db === 'mysql' || e.db === null, `${e.id}: db inválido`);
  }
});

test('CATALOG: modos según el diseño aprobado', () => {
  assert.deepStrictEqual(getEntry('wordpress').modes, ['docker', 'native']);
  assert.deepStrictEqual(getEntry('ghost').modes, ['docker', 'pm2']);
  assert.deepStrictEqual(getEntry('nextcloud').modes, ['docker']);
  assert.deepStrictEqual(getEntry('vaultwarden').modes, ['docker']);
  assert.deepStrictEqual(getEntry('uptime-kuma').modes, ['docker', 'pm2']);
  assert.strictEqual(getEntry('wordpress').db, 'mysql');
  assert.strictEqual(getEntry('ghost').db, 'mysql');
  assert.strictEqual(getEntry('nextcloud').db, null);
  assert.strictEqual(getEntry('no-existe'), null);
});

test('nombres de recursos', () => {
  assert.strictEqual(containerName('wordpress'), 'txpl-app-wordpress');
  assert.strictEqual(pm2Name('ghost'), 'txpl-app-ghost');
  assert.strictEqual(volumeName('uptime-kuma'), 'txpl_uptime-kuma_data');
  assert.strictEqual(nginxConfName('vaultwarden'), 'txpl-app-vaultwarden');
});

test('validateInstallOptions: casos válidos', () => {
  const wp = getEntry('wordpress');
  let r = validateInstallOptions(wp, { mode: 'docker' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.opts.domain, null);
  assert.strictEqual(r.opts.ssl, false);
  r = validateInstallOptions(wp, { mode: 'native', domain: 'blog.ejemplo.com', ssl: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.opts.domain, 'blog.ejemplo.com');
  assert.strictEqual(r.opts.ssl, true);
});

test('validateInstallOptions: casos inválidos', () => {
  const wp = getEntry('wordpress');
  assert.strictEqual(validateInstallOptions(wp, { mode: 'pm2' }).ok, false);          // modo no soportado
  assert.strictEqual(validateInstallOptions(wp, { mode: 'native' }).ok, false);       // nativo exige dominio
  assert.strictEqual(validateInstallOptions(wp, { mode: 'docker', domain: 'mal_dominio' }).ok, false);
  assert.strictEqual(validateInstallOptions(wp, { mode: 'docker', domain: null, ssl: true }).ok, false); // ssl sin dominio
  assert.strictEqual(validateInstallOptions(getEntry('nextcloud'), { mode: 'native' }).ok, false);
});
```

- [ ] **Step 2: Verificar que fallan**

Run: `node --test backend/test/catalog.test.js`
Expected: FAIL — `Cannot find module '../lib/catalog'`.

- [ ] **Step 3: Implementar `backend/lib/catalog.js`**

```js
'use strict';

// ============================================================
//  TecXPaneL — Helpers puros del Catálogo de aplicaciones
//
//  Definición DECLARATIVA de las apps instalables con un clic y
//  funciones puras (sin DB, sin efectos) para validar opciones y
//  construir configuraciones. Añadir una app nueva = añadir una
//  entrada a CATALOG + sus tests.
// ============================================================

const { isValidDomain } = require('./validators');

// Cada entrada declara: modos soportados, receta docker (imagen con TAG
// FIJADO — sin tag la Docker API descarga TODAS las etiquetas), receta
// nativa/pm2 y si necesita base de datos MySQL del host.
const CATALOG = [
  {
    id: 'wordpress',
    name: 'WordPress',
    description: 'El CMS más usado del mundo. Blogs, webs corporativas y tiendas (WooCommerce).',
    icon: 'ti-brand-wordpress',
    modes: ['docker', 'native'],
    docker: { image: 'wordpress', tag: '6.8-apache', port: 80, dataPath: '/var/www/html' },
    native: { type: 'php' },
    db: 'mysql',
  },
  {
    id: 'ghost',
    name: 'Ghost',
    description: 'Plataforma de publicación y newsletters, moderna y rápida (Node.js).',
    icon: 'ti-ghost',
    modes: ['docker', 'pm2'],
    docker: { image: 'ghost', tag: '5-alpine', port: 2368, dataPath: '/var/lib/ghost/content' },
    native: { type: 'node' },
    db: 'mysql',
  },
  {
    id: 'nextcloud',
    name: 'Nextcloud',
    description: 'Tu nube privada: archivos, fotos, calendario y contactos. (SQLite interno, válido para uso personal.)',
    icon: 'ti-cloud',
    modes: ['docker'],
    docker: { image: 'nextcloud', tag: '31-apache', port: 80, dataPath: '/var/www/html' },
    native: null,
    db: null,
  },
  {
    id: 'vaultwarden',
    name: 'Vaultwarden',
    description: 'Gestor de contraseñas compatible con Bitwarden, ligero y auto-alojado.',
    icon: 'ti-shield-lock',
    modes: ['docker'],
    docker: { image: 'vaultwarden/server', tag: '1.34.1', port: 80, dataPath: '/data' },
    native: null,
    db: null,
  },
  {
    id: 'uptime-kuma',
    name: 'Uptime Kuma',
    description: 'Monitorización de servicios con avisos: web, TCP, ping, certificados.',
    icon: 'ti-activity-heartbeat',
    modes: ['docker', 'pm2'],
    docker: { image: 'louislam/uptime-kuma', tag: '1', port: 3001, dataPath: '/app/data' },
    native: { type: 'node' },
    db: null,
  },
];

const getEntry = (id) => CATALOG.find((e) => e.id === id) || null;

const containerName = (id) => `txpl-app-${id}`;
const pm2Name = (id) => `txpl-app-${id}`;
const volumeName = (id) => `txpl_${id}_data`;
const nginxConfName = (id) => `txpl-app-${id}`;

// Valida y NORMALIZA las opciones de instalación. Devuelve
// { ok:true, opts:{ mode, domain, ssl } } o { ok:false, error }.
function validateInstallOptions(entry, raw = {}) {
  const mode = String(raw.mode || '');
  if (!entry.modes.includes(mode)) {
    return { ok: false, error: `La app ${entry.name} no soporta el modo "${mode}".` };
  }
  let domain = null;
  const domainRaw = String(raw.domain || '').trim();
  if (domainRaw) {
    if (!isValidDomain(domainRaw)) return { ok: false, error: 'Dominio inválido.' };
    domain = domainRaw;
  }
  // El modo nativo PHP escribe en /var/www/<dominio>: el dominio es obligatorio.
  if (mode === 'native' && !domain) {
    return { ok: false, error: 'El modo nativo requiere un dominio.' };
  }
  const ssl = !!raw.ssl;
  if (ssl && !domain) return { ok: false, error: 'SSL requiere un dominio.' };
  return { ok: true, opts: { mode, domain, ssl } };
}

module.exports = {
  CATALOG, getEntry,
  containerName, pm2Name, volumeName, nginxConfName,
  validateInstallOptions,
};
```

- [ ] **Step 4: Verificar que pasan**

Run: `node --test backend/test/catalog.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/lib/catalog.js backend/test/catalog.test.js
git commit -m "feat(catalogo): CATALOG declarativo, nombres de recursos y validación de opciones"
```

---

### Task 3: `lib/catalog.js` — constructores de config (contenedor, env de DB, wp-config)

**Files:**
- Modify: `backend/lib/catalog.js`
- Modify: `backend/test/catalog.test.js`

**Interfaces:**
- Consumes: `CATALOG`, `containerName`, `volumeName` (Task 2).
- Produces: `buildAppContainerConfig(entry, { hostPort, domain, dbCreds, dbHost })` → objeto para `POST /containers/create`; `buildDbEnv(entryId, dbCreds, dbHost)` → array `['VAR=valor',...]`; `buildWpConfig({ dbName, dbUser, dbPass, salts })` → string `wp-config.php`; `buildGhostConfig({ url, port, dbName, dbUser, dbPass, contentPath })` → objeto JSON de `config.production.json`.
  - `dbCreds = { name, user, password }`; `dbHost` = `'172.17.0.1'` o `'host.docker.internal'` (docker) / `'localhost'` (nativo/pm2).

- [ ] **Step 1: Añadir los tests que fallan** al final de `backend/test/catalog.test.js`:

```js
const {
  buildAppContainerConfig, buildDbEnv, buildWpConfig, buildGhostConfig,
} = require('../lib/catalog');

const CREDS = { name: 'wpdb', user: 'txpl_wpdb', password: 'S3cr3ta' };

test('buildDbEnv: wordpress y ghost; apps sin DB devuelven []', () => {
  assert.deepStrictEqual(buildDbEnv('wordpress', CREDS, '172.17.0.1'), [
    'WORDPRESS_DB_HOST=172.17.0.1',
    'WORDPRESS_DB_NAME=wpdb',
    'WORDPRESS_DB_USER=txpl_wpdb',
    'WORDPRESS_DB_PASSWORD=S3cr3ta',
  ]);
  const ghostEnv = buildDbEnv('ghost', CREDS, '172.17.0.1');
  assert.ok(ghostEnv.includes('database__client=mysql'));
  assert.ok(ghostEnv.includes('database__connection__host=172.17.0.1'));
  assert.ok(ghostEnv.includes('database__connection__password=S3cr3ta'));
  assert.deepStrictEqual(buildDbEnv('vaultwarden', null, null), []);
});

test('buildAppContainerConfig: imagen con tag, volumen, puerto en loopback', () => {
  const entry = getEntry('wordpress');
  const cfg = buildAppContainerConfig(entry, { hostPort: 8090, domain: 'blog.com', dbCreds: CREDS, dbHost: '172.17.0.1' });
  assert.strictEqual(cfg.Image, 'wordpress:6.8-apache');
  assert.deepStrictEqual(cfg.HostConfig.Binds, ['txpl_wordpress_data:/var/www/html']);
  assert.deepStrictEqual(cfg.HostConfig.PortBindings['80/tcp'], [{ HostIp: '127.0.0.1', HostPort: '8090' }]);
  assert.strictEqual(cfg.HostConfig.RestartPolicy.Name, 'unless-stopped');
  assert.ok(cfg.Env.includes('WORDPRESS_DB_NAME=wpdb'));
  assert.strictEqual(cfg.Labels['txpl.domain'], 'blog.com');
  assert.ok(cfg.HostConfig.ExtraHosts.includes('host.docker.internal:host-gateway'));
});

test('buildAppContainerConfig: app sin DB ni dominio', () => {
  const cfg = buildAppContainerConfig(getEntry('vaultwarden'), { hostPort: 8091 });
  assert.strictEqual(cfg.Image, 'vaultwarden/server:1.34.1');
  assert.deepStrictEqual(cfg.Env, []);
  assert.deepStrictEqual(cfg.Labels, {});
});

test('buildWpConfig: credenciales y salts presentes, sin placeholders', () => {
  const salts = 'define(\'AUTH_KEY\', \'x\');';
  const conf = buildWpConfig({ dbName: 'wpdb', dbUser: 'txpl_wpdb', dbPass: 'S3cr3ta', salts });
  assert.ok(conf.includes("define( 'DB_NAME', 'wpdb' )"));
  assert.ok(conf.includes("define( 'DB_USER', 'txpl_wpdb' )"));
  assert.ok(conf.includes("define( 'DB_PASSWORD', 'S3cr3ta' )"));
  assert.ok(conf.includes("define( 'DB_HOST', 'localhost' )"));
  assert.ok(conf.includes(salts));
  assert.ok(conf.includes('$table_prefix'));
  assert.ok(!conf.includes('put your unique phrase here'));
});

test('buildGhostConfig: url, puerto y conexión MySQL', () => {
  const c = buildGhostConfig({ url: 'https://blog.com', port: 2368, dbName: 'ghostdb', dbUser: 'u', dbPass: 'p', contentPath: '/opt/txpl-apps/ghost/content' });
  assert.strictEqual(c.url, 'https://blog.com');
  assert.strictEqual(c.server.port, 2368);
  assert.strictEqual(c.server.host, '127.0.0.1');
  assert.strictEqual(c.database.client, 'mysql');
  assert.strictEqual(c.database.connection.database, 'ghostdb');
  assert.strictEqual(c.paths.contentPath, '/opt/txpl-apps/ghost/content');
});
```

- [ ] **Step 2: Verificar que fallan**

Run: `node --test backend/test/catalog.test.js`
Expected: FAIL — `buildAppContainerConfig is not a function`.

- [ ] **Step 3: Implementar en `backend/lib/catalog.js`** (antes del `module.exports`, y ampliar el export):

```js
// Env vars de conexión a la DB según la app. dbHost varía por modo:
// '172.17.0.1'/'host.docker.internal' (docker) o 'localhost' (nativo/pm2).
function buildDbEnv(entryId, dbCreds, dbHost) {
  if (!dbCreds) return [];
  if (entryId === 'wordpress') {
    return [
      `WORDPRESS_DB_HOST=${dbHost}`,
      `WORDPRESS_DB_NAME=${dbCreds.name}`,
      `WORDPRESS_DB_USER=${dbCreds.user}`,
      `WORDPRESS_DB_PASSWORD=${dbCreds.password}`,
    ];
  }
  if (entryId === 'ghost') {
    return [
      'database__client=mysql',
      `database__connection__host=${dbHost}`,
      `database__connection__database=${dbCreds.name}`,
      `database__connection__user=${dbCreds.user}`,
      `database__connection__password=${dbCreds.password}`,
    ];
  }
  return [];
}

// Config para POST /containers/create de la Docker API.
// El puerto host SIEMPRE se publica solo en 127.0.0.1: el acceso externo
// pasa por el proxy Nginx (o no existe, si el usuario no puso dominio).
function buildAppContainerConfig(entry, { hostPort, domain = null, dbCreds = null, dbHost = null } = {}) {
  const cPort = `${entry.docker.port}/tcp`;
  const env = [...buildDbEnv(entry.id, dbCreds, dbHost)];
  if (entry.id === 'ghost') {
    // Ghost necesita saber su URL pública para generar enlaces correctos.
    env.push(`url=${domain ? `https://${domain}` : `http://localhost:${hostPort}`}`);
  }
  if (entry.id === 'nextcloud' && domain) env.push(`NEXTCLOUD_TRUSTED_DOMAINS=${domain}`);
  if (entry.id === 'vaultwarden' && domain) env.push(`DOMAIN=https://${domain}`);
  return {
    Image: `${entry.docker.image}:${entry.docker.tag}`,
    Env: env,
    ExposedPorts: { [cPort]: {} },
    HostConfig: {
      RestartPolicy: { Name: 'unless-stopped' },
      PortBindings: { [cPort]: [{ HostIp: '127.0.0.1', HostPort: String(hostPort) }] },
      Binds: [`${volumeName(entry.id)}:${entry.docker.dataPath}`],
      // host-gateway permite al contenedor resolver host.docker.internal
      // hacia el host (para el MySQL del host) también en Linux.
      ExtraHosts: ['host.docker.internal:host-gateway'],
    },
    Labels: domain ? { 'txpl.domain': domain } : {},
  };
}

// Contenido completo de wp-config.php (modo nativo). salts = bloque de
// define() de claves (de api.wordpress.org o generado con crypto.js).
function buildWpConfig({ dbName, dbUser, dbPass, salts }) {
  return `<?php
define( 'DB_NAME', '${dbName}' );
define( 'DB_USER', '${dbUser}' );
define( 'DB_PASSWORD', '${dbPass}' );
define( 'DB_HOST', 'localhost' );
define( 'DB_CHARSET', 'utf8mb4' );
define( 'DB_COLLATE', '' );

${salts}

$table_prefix = 'wp_';
define( 'WP_DEBUG', false );

if ( ! defined( 'ABSPATH' ) ) {
\tdefine( 'ABSPATH', __DIR__ . '/' );
}
require_once ABSPATH . 'wp-settings.php';
`;
}

// config.production.json de Ghost en modo PM2.
function buildGhostConfig({ url, port, dbName, dbUser, dbPass, contentPath }) {
  return {
    url,
    server: { port, host: '127.0.0.1' },
    database: {
      client: 'mysql',
      connection: { host: 'localhost', database: dbName, user: dbUser, password: dbPass },
    },
    mail: { transport: 'Direct' },
    logging: { transports: ['file', 'stdout'] },
    process: 'local',
    paths: { contentPath },
  };
}
```

Y en el `module.exports` añadir: `buildDbEnv, buildAppContainerConfig, buildWpConfig, buildGhostConfig`.

- [ ] **Step 4: Verificar que pasan**

Run: `node --test backend/test/catalog.test.js`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/lib/catalog.js backend/test/catalog.test.js
git commit -m "feat(catalogo): constructores de config de contenedor, env de DB, wp-config y config de Ghost"
```

---

### Task 4: `lib/catalogEngine.js` — infraestructura + instalación modo Docker

**Files:**
- Create: `backend/lib/catalogEngine.js`

**Interfaces:**
- Consumes: todo `lib/catalog.js`; `buildPullPath`, `accumulatePullProgress` de `lib/n8n.js`; `mysqlExec` de `routes/databases.js`; `genPassword`, `encryptSecret` de `lib/crypto.js`; `nginx.*`; `queries`.
- Produces: `installApp(appId, opts, write)` → `Promise<number>` (exit code 0/1); helpers internos `dockerRequest`, `pullImageWithProgress`, `ensureDatabase`, `findFreePort`, `detectDbHostForDocker`, `setupProxy` (reutilizados por Tasks 5-7).

Sin test unitario propio: es capa de efectos; la lógica pura ya está testeada en Task 2-3 (convención del repo).

- [ ] **Step 1: Crear `backend/lib/catalogEngine.js`** con la infraestructura y el modo Docker:

```js
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
```

Nota: `installNativePhp` e `installPm2` se definen en Tasks 5 y 6 **en este mismo fichero**; hasta entonces, para que el módulo cargue, añadir stubs temporales encima de `installApp`:

```js
async function installNativePhp(entry, opts, write) { write('✖ Modo nativo aún no disponible.\n'); return 1; }
async function installPm2(entry, opts, write) { write('✖ Modo PM2 aún no disponible.\n'); return 1; }
```

(Se sustituyen por la implementación real en las Tasks 5-6; no llegan a `main` como stubs porque la rama se fusiona completa.)

- [ ] **Step 2: Verificar que todo carga y los tests pasan**

Run: `node -e "require('./backend/lib/catalogEngine')" && npm test`
Expected: sin error de carga; tests PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/lib/catalogEngine.js
git commit -m "feat(catalogo): motor de instalación en modo Docker con rollback"
```

---

### Task 5: Motor — modo nativo PHP (WordPress)

**Files:**
- Modify: `backend/lib/catalogEngine.js` (sustituir el stub `installNativePhp`)

**Interfaces:**
- Consumes: `ensureDatabase`, `dropDatabase`, `buildWpConfig`, `nginx.buildSite`, `nginx.enableSite`, `nginx.installSsl`, `run`/`runSafe`, `genPassword`.
- Produces: `installNativePhp(entry, opts, write)` → `Promise<0|1>`.

- [ ] **Step 1: Sustituir el stub por la implementación real**

```js
// ── Instalación modo nativo PHP (WordPress) ──────────────────
// Descarga WordPress de wordpress.org, lo extrae en /var/www/<dominio>,
// genera wp-config.php y crea el vhost PHP-FPM con el builder del panel.
async function installNativePhp(entry, opts, write) {
  const { domain, ssl } = opts;                       // domain validado como obligatorio
  const siteDir = path.join('/var/www', domain);
  const publicDir = path.join(siteDir, 'public');
  let dbCreds = null;
  try {
    if (fs.existsSync(publicDir) && fs.readdirSync(publicDir).length > 0) {
      const err = new Error(`La carpeta ${publicDir} ya existe y no está vacía.`);
      err.http = 409;
      throw err;
    }
    // PHP-FPM presente?
    const php = await runSafe('php', ['-v']);
    if (!php.ok) {
      const err = new Error('PHP no está instalado. Instálalo primero (sección Plugins o crea un sitio PHP).');
      err.http = 409;
      throw err;
    }
    dbCreds = await ensureDatabase(entry.id, write);

    write('⏳ Descargando WordPress (latest.tar.gz de wordpress.org)...\n');
    const tarball = '/tmp/txpl-wordpress.tar.gz';
    await run('curl', ['-fsSL', '-o', tarball, 'https://wordpress.org/latest.tar.gz'], LONG);
    fs.mkdirSync(siteDir, { recursive: true });
    await run('tar', ['-xzf', tarball, '-C', siteDir], LONG);
    // El tar extrae a <siteDir>/wordpress; lo renombramos a public/.
    fs.renameSync(path.join(siteDir, 'wordpress'), publicDir);
    fs.unlinkSync(tarball);
    write('✓ WordPress extraído en ' + publicDir + '.\n');

    // Salts: API oficial con fallback local (genPassword).
    write('⏳ Generando wp-config.php...\n');
    let salts;
    try {
      salts = await run('curl', ['-fsSL', 'https://api.wordpress.org/secret-key/1.1/salt/']);
    } catch (_) {
      const keys = ['AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY', 'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT'];
      salts = keys.map((k) => `define( '${k}', '${genPassword(64)}' );`).join('\n');
    }
    fs.writeFileSync(path.join(publicDir, 'wp-config.php'), buildWpConfig({
      dbName: dbCreds.name, dbUser: dbCreds.user, dbPass: dbCreds.password, salts,
    }));
    await runSafe('chown', ['-R', 'www-data:www-data', siteDir]);
    write('✓ wp-config.php listo y permisos aplicados.\n');

    // Vhost PHP con el builder estándar de sitios (dominio => listen 80).
    write(`⏳ Creando vhost Nginx PHP para ${domain}...\n`);
    await nginx.enableSite(nginxConfName(entry.id), nginx.buildSite(domain, 'php', null, {}));
    write('✓ Vhost activo.\n');
    if (ssl) {
      write(`⏳ Emitiendo SSL para ${domain}...\n`);
      try {
        await nginx.installSsl(domain, { www: true });
        write('✓ SSL emitido.\n');
      } catch (e) {
        write(`⚠ WordPress funciona, pero falló el SSL: ${e.message}\n`);
      }
    }

    queries.insertCatalogInstall.run({
      app_id: entry.id, mode: 'native', domain, port: null, ref: siteDir, db_name: dbCreds.name,
    });
    writeSummary(entry, { domain, hostPort: null, dbCreds }, write);
    write(`   Termina la instalación en http${ssl ? 's' : ''}://${domain}/wp-admin/install.php\n`);
    return 0;
  } catch (e) {
    write(`\n✖ ${e.message}\n`);
    write('⏳ Deshaciendo cambios parciales...\n');
    try { fs.rmSync(siteDir, { recursive: true, force: true }); } catch (_) {}
    try { await nginx.removeSite(nginxConfName(entry.id)); } catch (_) {}
    if (dbCreds) await dropDatabase(dbCreds.name);
    write('✓ Limpieza hecha.\n');
    return 1;
  }
}
```

- [ ] **Step 2: Verificar carga + tests**

Run: `node -e "require('./backend/lib/catalogEngine')" && npm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/lib/catalogEngine.js
git commit -m "feat(catalogo): instalación de WordPress en modo nativo PHP-FPM"
```

---

### Task 6: Motor — modo PM2 (Ghost y Uptime Kuma)

**Files:**
- Modify: `backend/lib/catalogEngine.js` (sustituir el stub `installPm2`)

**Interfaces:**
- Consumes: `ensureDatabase`, `buildGhostConfig`, `findFreePort`, `setupProxy`, `pm2Name`, `run`/`runSafe`, `LONG`, `APPS_DIR`.
- Produces: `installPm2(entry, opts, write)` → `Promise<0|1>`.

- [ ] **Step 1: Sustituir el stub por la implementación real**

```js
// ── Instalación modo PM2 (Ghost, Uptime Kuma) ────────────────
async function installPm2(entry, opts, write) {
  const { domain, ssl } = opts;
  const appDir = path.join(APPS_DIR, entry.id);
  const name = pm2Name(entry.id);
  let dbCreds = null;
  try {
    const node = await runSafe('node', ['--version']);
    if (!node.ok) { const e = new Error('Node.js no está disponible.'); e.http = 409; throw e; }
    if (fs.existsSync(appDir) && fs.readdirSync(appDir).length > 0) {
      const e = new Error(`La carpeta ${appDir} ya existe y no está vacía.`);
      e.http = 409;
      throw e;
    }
    fs.mkdirSync(appDir, { recursive: true });
    const hostPort = await findFreePort();

    if (entry.id === 'ghost') {
      dbCreds = await ensureDatabase(entry.id, write);
      write('⏳ Instalando Ghost con ghost-cli (varios minutos)...\n');
      // Solo los ficheros: nada de systemd/nginx/mysql del CLI; el panel gestiona todo.
      await run('npx', ['ghost-cli@latest', 'install',
        '--dir', appDir, '--db', 'mysql',
        '--no-setup-nginx', '--no-setup-ssl', '--no-setup-systemd', '--no-setup-mysql',
        '--no-start', '--no-enable', '--no-prompt',
        '--dbhost', 'localhost', '--dbuser', dbCreds.user, '--dbpass', dbCreds.password, '--dbname', dbCreds.name,
        '--url', domain ? `https://${domain}` : `http://localhost:${hostPort}`,
      ], { ...LONG, cwd: appDir });
      // Config de producción propia (puerto elegido, MySQL del host).
      const conf = buildGhostConfig({
        url: domain ? `https://${domain}` : `http://localhost:${hostPort}`,
        port: hostPort, dbName: dbCreds.name, dbUser: dbCreds.user, dbPass: dbCreds.password,
        contentPath: path.join(appDir, 'content'),
      });
      fs.writeFileSync(path.join(appDir, 'config.production.json'), JSON.stringify(conf, null, 2));
      write('⏳ Arrancando Ghost con PM2...\n');
      const r = await runSafe('pm2', ['start', path.join(appDir, 'current', 'index.js'), '--name', name],
        { cwd: appDir, env: { ...process.env, NODE_ENV: 'production', GHOST_CONFIG: path.join(appDir, 'config.production.json') } });
      if (!r.ok) throw new Error(`PM2 no pudo arrancar Ghost: ${r.stderr}`);
    } else if (entry.id === 'uptime-kuma') {
      write('⏳ Clonando Uptime Kuma (rama estable 1.x)...\n');
      await run('git', ['clone', '--depth', '1', '-b', '1.23.16', 'https://github.com/louislam/uptime-kuma.git', appDir], LONG);
      write('⏳ Instalando dependencias y compilando (varios minutos)...\n');
      await run('npm', ['run', 'setup'], { ...LONG, cwd: appDir });
      write('⏳ Arrancando Uptime Kuma con PM2...\n');
      const r = await runSafe('pm2', ['start', path.join(appDir, 'server', 'server.js'), '--name', name],
        { cwd: appDir, env: { ...process.env, UPTIME_KUMA_PORT: String(hostPort), UPTIME_KUMA_HOST: '127.0.0.1' } });
      if (!r.ok) throw new Error(`PM2 no pudo arrancar Uptime Kuma: ${r.stderr}`);
    } else {
      const e = new Error(`${entry.name} no soporta el modo PM2.`);
      e.http = 400;
      throw e;
    }
    await runSafe('pm2', ['save']);
    write(`✓ ${entry.name} corriendo bajo PM2 como ${name} en 127.0.0.1:${hostPort}.\n`);

    if (domain) await setupProxy(entry.id, domain, hostPort, ssl, write);

    queries.insertCatalogInstall.run({
      app_id: entry.id, mode: 'pm2', domain: domain || null, port: hostPort, ref: name,
      db_name: dbCreds ? dbCreds.name : null,
    });
    writeSummary(entry, { domain, hostPort, dbCreds }, write);
    return 0;
  } catch (e) {
    write(`\n✖ ${e.message}\n`);
    write('⏳ Deshaciendo cambios parciales...\n');
    await runSafe('pm2', ['delete', name]);
    await runSafe('pm2', ['save']);
    try { fs.rmSync(appDir, { recursive: true, force: true }); } catch (_) {}
    try { await nginx.removeSite(nginxConfName(entry.id)); } catch (_) {}
    if (dbCreds) await dropDatabase(dbCreds.name);
    write('✓ Limpieza hecha.\n');
    return 1;
  }
}
```

- [ ] **Step 2: Verificar carga + tests**

Run: `node -e "require('./backend/lib/catalogEngine')" && npm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/lib/catalogEngine.js
git commit -m "feat(catalogo): instalación de Ghost y Uptime Kuma en modo PM2"
```

---

### Task 7: Motor — desinstalar, estado y acciones

**Files:**
- Modify: `backend/lib/catalogEngine.js`

**Interfaces:**
- Produces: `uninstallApp(appId, { purgeData, purgeDb }, write)` → `Promise<0|1>`; `getInstallStatus(appId)` → `{ installed, mode, domain, port, running }`; `controlApp(appId, action)` → lanza con `e.http` o resuelve (action: `start|stop|restart`).

- [ ] **Step 1: Añadir al final del motor (antes de `module.exports`)**

```js
// ── Estado de una instalación ────────────────────────────────
async function getInstallStatus(appId) {
  const row = queries.getCatalogInstall.get(appId);
  if (!row) return { installed: false, mode: null, domain: null, port: null, running: false };
  let running = false;
  if (row.mode === 'docker') {
    try {
      const r = await dockerRequest('GET', '/containers/json?all=1');
      if (r.statusCode < 400) {
        const list = JSON.parse(r.body.toString());
        const c = list.find((x) => (x.Names || []).some((n) => n === `/${row.ref}`));
        running = !!c && c.State === 'running';
      }
    } catch (_) {}
  } else if (row.mode === 'pm2') {
    const r = await runSafe('pm2', ['jlist']);
    if (r.ok) {
      try {
        const list = JSON.parse(r.stdout);
        const p = list.find((x) => x.name === row.ref);
        running = !!p && p.pm2_env && p.pm2_env.status === 'online';
      } catch (_) {}
    }
  } else {
    // native: "corre" si el vhost está activo (lo sirve Nginx + PHP-FPM).
    running = fs.existsSync(`/etc/nginx/sites-enabled/${nginxConfName(appId)}`);
  }
  return { installed: true, mode: row.mode, domain: row.domain, port: row.port, running };
}

// ── start / stop / restart ───────────────────────────────────
async function controlApp(appId, action) {
  const row = queries.getCatalogInstall.get(appId);
  if (!row) { const e = new Error('La app no está instalada.'); e.http = 404; throw e; }
  if (row.mode === 'docker') {
    const r = await dockerRequest('POST', `/containers/${row.ref}/${action}`);
    if (r.statusCode >= 400) { const e = new Error(`Error al ${action}: ${r.body.toString()}`); e.http = 502; throw e; }
  } else if (row.mode === 'pm2') {
    const r = await runSafe('pm2', [action === 'start' ? 'start' : action, row.ref]);
    if (!r.ok) { const e = new Error(`PM2 falló al ${action}: ${r.stderr}`); e.http = 502; throw e; }
  } else {
    const e = new Error('El modo nativo se gestiona con Nginx/PHP-FPM (sección Sitios web).');
    e.http = 400;
    throw e;
  }
}

// ── Desinstalación ───────────────────────────────────────────
// purgeData/purgeDb SIEMPRE opt-in: por defecto los datos y la DB se conservan.
async function uninstallApp(appId, { purgeData = false, purgeDb = false } = {}, write) {
  const entry = getEntry(appId);
  const row = queries.getCatalogInstall.get(appId);
  if (!entry || !row) { const e = new Error('La app no está instalada.'); e.http = 404; throw e; }
  write(`▶ Desinstalando ${entry.name}...\n`);
  try {
    if (row.mode === 'docker') {
      write('⏳ Parando y borrando el contenedor...\n');
      await dockerRequest('DELETE', `/containers/${row.ref}?force=1&v=0`).catch(() => {});
      if (purgeData) {
        write(`⏳ Borrando volumen ${volumeName(appId)}...\n`);
        await dockerRequest('DELETE', `/volumes/${volumeName(appId)}`).catch(() => {});
      }
    } else if (row.mode === 'pm2') {
      write('⏳ Parando el proceso PM2...\n');
      await runSafe('pm2', ['delete', row.ref]);
      await runSafe('pm2', ['save']);
      if (purgeData) {
        write(`⏳ Borrando ${path.join(APPS_DIR, appId)}...\n`);
        try { fs.rmSync(path.join(APPS_DIR, appId), { recursive: true, force: true }); } catch (_) {}
      }
    } else { // native
      if (purgeData && row.ref && row.ref.startsWith('/var/www/')) {
        write(`⏳ Borrando ${row.ref}...\n`);
        try { fs.rmSync(row.ref, { recursive: true, force: true }); } catch (_) {}
      }
    }
    try { await nginx.removeSite(nginxConfName(appId)); write('✓ Vhost Nginx retirado.\n'); } catch (_) {}
    if (purgeDb && row.db_name) {
      write(`⏳ Borrando base de datos ${row.db_name}...\n`);
      await dropDatabase(row.db_name);
    } else if (row.db_name) {
      write(`ℹ La base de datos ${row.db_name} se conserva (bórrala desde Bases de datos si quieres).\n`);
    }
    queries.deleteCatalogInstall.run(appId);
    write(`\n✅ ${entry.name} desinstalado.\n`);
    return 0;
  } catch (e) {
    write(`\n✖ ${e.message}\n`);
    return 1;
  }
}
```

Y añadir al `module.exports`: `uninstallApp, getInstallStatus, controlApp`.

- [ ] **Step 2: Verificar carga + tests**

Run: `node -e "require('./backend/lib/catalogEngine')" && npm test`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add backend/lib/catalogEngine.js
git commit -m "feat(catalogo): estado, control start/stop/restart y desinstalación con purga opt-in"
```

---

### Task 8: `routes/catalog.js` + montaje en `server.js`

**Files:**
- Create: `backend/routes/catalog.js`
- Modify: `backend/server.js:91` (añadir `app.use` tras notifications)

**Interfaces:**
- Consumes: `installApp`, `uninstallApp`, `getInstallStatus`, `controlApp` del motor; `CATALOG`, `getEntry`, `validateInstallOptions` de `lib/catalog.js`.
- Produces: API REST `/api/catalog` (la consume el frontend de Task 9): `GET /`, `POST /:id/install` (streaming), `POST /:id/:action`, `DELETE /:id` (streaming).

- [ ] **Step 1: Crear `backend/routes/catalog.js`**

```js
'use strict';

// ============================================================
//  TecXPaneL — Catálogo de aplicaciones (HTTP)
//
//  Lista el catálogo con su estado, instala en el modo elegido
//  (streaming con centinela __TXPL_DONE__), controla y desinstala.
//  JWT ya aplicado por el middleware global de /api.
// ============================================================

const express = require('express');
const { ok, fail, clientIp, wrap } = require('../lib/helpers');
const { CATALOG, getEntry, validateInstallOptions } = require('../lib/catalog');
const engine = require('../lib/catalogEngine');
const { audit } = require('../database');

const router = express.Router();

// Cabeceras + helpers de streaming (patrón plugins/n8n).
function startStream(res) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  return {
    write: (s) => res.write(s),
    done: (code) => res.end(`\n__TXPL_DONE__${code}`),
  };
}

// GET / — catálogo completo + estado de instalación de cada app.
router.get('/', wrap(async (req, res) => {
  const apps = [];
  for (const e of CATALOG) {
    const st = await engine.getInstallStatus(e.id);
    apps.push({
      id: e.id, name: e.name, description: e.description, icon: e.icon,
      modes: e.modes, db: e.db, ...st,
    });
  }
  ok(res, { apps });
}));

// POST /:id/install — body { mode, domain?, ssl? }. Respuesta en streaming.
router.post('/:id/install', wrap(async (req, res) => {
  const entry = getEntry(req.params.id);
  if (!entry) return fail(res, 404, 'App no encontrada en el catálogo.');
  const v = validateInstallOptions(entry, req.body || {});
  if (!v.ok) return fail(res, 400, v.error);

  audit(req.user.username, clientIp(req), 'catalog.install', `${entry.id} (${v.opts.mode})`);
  const { write, done } = startStream(res);
  write(`▶ Instalando ${entry.name} en modo ${v.opts.mode}...\n\n`);
  try {
    const code = await engine.installApp(entry.id, v.opts, write);
    return done(code);
  } catch (e) {
    write(`\n✖ ${e.message}\n`);
    return done(1);
  }
}));

// POST /:id/:action — start | stop | restart.
router.post('/:id/:action', wrap(async (req, res) => {
  const action = req.params.action;
  if (!['start', 'stop', 'restart'].includes(action)) return fail(res, 400, 'Acción no permitida.');
  await engine.controlApp(req.params.id, action);
  audit(req.user.username, clientIp(req), `catalog.${action}`, req.params.id);
  ok(res);
}));

// DELETE /:id — query purgeData=true|false & purgeDb=true|false. Streaming.
router.delete('/:id', wrap(async (req, res) => {
  const purgeData = req.query.purgeData === 'true';
  const purgeDb = req.query.purgeDb === 'true';
  audit(req.user.username, clientIp(req), 'catalog.uninstall',
    `${req.params.id}${purgeData ? ' +datos' : ''}${purgeDb ? ' +db' : ''}`);
  const { write, done } = startStream(res);
  try {
    const code = await engine.uninstallApp(req.params.id, { purgeData, purgeDb }, write);
    return done(code);
  } catch (e) {
    write(`\n✖ ${e.message}\n`);
    return done(1);
  }
}));

module.exports = router;
```

- [ ] **Step 2: Montar en `backend/server.js`** (tras la línea de notifications):

```js
app.use('/api/catalog', require('./routes/catalog'));
```

- [ ] **Step 3: Verificar arranque + tests**

Run: `npm test && node -e "process.env.TXPL_DIR='./'; process.env.FRONTEND_DIR='./frontend'; require('./backend/routes/catalog');"`
Expected: PASS, sin errores de carga.

- [ ] **Step 4: Commit**

```bash
git add backend/routes/catalog.js backend/server.js
git commit -m "feat(catalogo): API REST /api/catalog con instalación en streaming"
```

---

### Task 9: Frontend — página Catálogo

**Files:**
- Modify: `frontend/views/sidebar.html:32` (nueva entrada tras Workflows)
- Modify: `frontend/index.html:154` (nuevo div de página tras page-n8n)
- Modify: `frontend/js/app.js` (título en `navigate()` ~línea 283, dispatch ~línea 302, funciones nuevas al final)

**Interfaces:**
- Consumes: API `/api/catalog` (Task 8); helpers existentes del frontend: `api()` (fetch autenticado), patrón de streaming con `__TXPL_DONE__` (copiar de la instalación de n8n ~línea 1917).
- Produces: página `page-catalog` con `loadCatalog()`.

- [ ] **Step 1: Sidebar** — en `frontend/views/sidebar.html`, tras la línea de Workflows:

```html
<div class="nav-item" data-page="catalog" onclick="navigate(this)">
  <i class="ti ti-apps"></i> Catálogo
</div>
```

- [ ] **Step 2: Página** — en `frontend/index.html`, tras `<div class="page" id="page-n8n"></div>`:

```html
      <div class="page" id="page-catalog"></div>
```

- [ ] **Step 3: `app.js`** — en el objeto `titles` de `navigate()` añadir `catalog: 'Catálogo de aplicaciones',`; en el bloque de dispatch añadir `if (page === 'catalog') loadCatalog();`. Después, al final del fichero, las funciones (usar el mismo helper `api()` y el patrón de streaming del fichero — leer cómo lo hace la instalación de n8n en ~línea 1917 y calcar el bucle de lectura del stream):

```js
// ── Catálogo de aplicaciones ─────────────────────────────────
const MODE_LABELS = { docker: 'Docker', native: 'Nativo (PHP)', pm2: 'PM2 (Node)' };

async function loadCatalog() {
  const el = document.getElementById('page-catalog');
  el.innerHTML = '<div class="card"><p>Cargando catálogo...</p></div>';
  const data = await api('/catalog');
  if (!data || !data.apps) { el.innerHTML = '<div class="card"><p>Error al cargar el catálogo.</p></div>'; return; }
  el.innerHTML = `<div class="grid grid-3">` + data.apps.map((a) => `
    <div class="card">
      <h3><i class="ti ${a.icon}"></i> ${a.name}</h3>
      <p style="min-height:48px">${a.description}</p>
      <p>${a.modes.map((m) => `<span class="badge">${MODE_LABELS[m]}</span>`).join(' ')}
         ${a.db ? '<span class="badge">MySQL</span>' : ''}</p>
      ${a.installed ? `
        <p><span class="badge ${a.running ? 'badge-green' : 'badge-red'}">${a.running ? 'En marcha' : 'Parado'}</span>
           <span class="badge">${MODE_LABELS[a.mode]}</span>
           ${a.domain ? `<a href="https://${a.domain}" target="_blank">${a.domain}</a>` : (a.port ? `puerto ${a.port}` : '')}</p>
        <div class="btn-row">
          ${a.mode !== 'native' ? `
            <button class="btn btn-sm" onclick="catalogAction('${a.id}','${a.running ? 'stop' : 'start'}')">${a.running ? 'Parar' : 'Iniciar'}</button>
            <button class="btn btn-sm" onclick="catalogAction('${a.id}','restart')">Reiniciar</button>` : ''}
          <button class="btn btn-sm btn-danger" onclick="catalogUninstall('${a.id}','${a.name.replace(/'/g, '')}', ${!!a.db})">Desinstalar</button>
        </div>` : `
        <button class="btn btn-primary" onclick="catalogInstallModal('${a.id}')">Instalar</button>`}
    </div>`).join('') + `</div>
    <div class="card" id="catalog-output-card" style="display:none;margin-top:16px">
      <h3>Instalación</h3>
      <pre id="catalog-output" style="max-height:400px;overflow:auto"></pre>
    </div>`;
  window._catalogApps = data.apps;
}

function catalogInstallModal(id) {
  const app = (window._catalogApps || []).find((a) => a.id === id);
  if (!app) return;
  const modes = app.modes.map((m, i) =>
    `<label style="display:block;margin:4px 0"><input type="radio" name="cat-mode" value="${m}" ${i === 0 ? 'checked' : ''}> ${MODE_LABELS[m]}</label>`).join('');
  showModal(`Instalar ${app.name}`, `
    <p>Modo de despliegue:</p>${modes}
    <label style="display:block;margin-top:10px">Dominio (opcional salvo modo nativo):
      <input type="text" id="cat-domain" placeholder="app.midominio.com"></label>
    <label style="display:block;margin-top:6px"><input type="checkbox" id="cat-ssl"> Emitir SSL (requiere DNS apuntando aquí)</label>
    ${app.db ? '<p style="margin-top:8px">ℹ Se creará una base de datos MySQL gestionada por el panel.</p>' : ''}
    <button class="btn btn-primary" style="margin-top:12px" onclick="catalogInstall('${app.id}')">Instalar</button>`);
}

async function catalogInstall(id) {
  const mode = document.querySelector('input[name="cat-mode"]:checked')?.value;
  const domain = document.getElementById('cat-domain').value.trim();
  const ssl = document.getElementById('cat-ssl').checked;
  closeModal();
  await catalogStream(`/catalog/${id}/install`, { method: 'POST', body: JSON.stringify({ mode, domain, ssl }) });
}

async function catalogAction(id, action) {
  const r = await api(`/catalog/${id}/${action}`, { method: 'POST' });
  if (r && r.error) alert(r.error);
  loadCatalog();
}

function catalogUninstall(id, name, hasDb) {
  showModal(`Desinstalar ${name}`, `
    <p>Se parará y retirará la aplicación.</p>
    <label style="display:block"><input type="checkbox" id="cat-purge-data"> Borrar también los DATOS (volumen/carpeta) — irreversible</label>
    ${hasDb ? '<label style="display:block"><input type="checkbox" id="cat-purge-db"> Borrar también la BASE DE DATOS — irreversible</label>' : ''}
    <button class="btn btn-danger" style="margin-top:12px" onclick="catalogUninstallGo('${id}')">Desinstalar</button>`);
}

async function catalogUninstallGo(id) {
  const purgeData = document.getElementById('cat-purge-data')?.checked || false;
  const purgeDb = document.getElementById('cat-purge-db')?.checked || false;
  if ((purgeData || purgeDb) && !confirm('¿Seguro? Los datos marcados se borrarán de forma IRREVERSIBLE.')) return;
  closeModal();
  await catalogStream(`/catalog/${id}?purgeData=${purgeData}&purgeDb=${purgeDb}`, { method: 'DELETE' });
}

// Lee un endpoint en streaming y lo vuelca al <pre>, hasta el centinela.
async function catalogStream(apiPath, opts) {
  const card = document.getElementById('catalog-output-card');
  const out = document.getElementById('catalog-output');
  card.style.display = 'block';
  out.textContent = '';
  const DONE = '__TXPL_DONE__';
  const res = await fetch('/api' + apiPath, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let acc = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    acc += dec.decode(value, { stream: true });
    // Progreso de pull: quedarnos solo con la última línea de %.
    const shown = acc
      .split('\n')
      .filter((l, i, arr) => !l.startsWith('__TXPL_PROGRESS__') || i === arr.length - 1 || !arr.slice(i + 1).some((x) => x.startsWith('__TXPL_PROGRESS__')))
      .map((l) => l.startsWith('__TXPL_PROGRESS__') ? `Descargando... ${l.slice(17)}%` : l)
      .join('\n');
    out.textContent = shown.split(DONE)[0];
    out.scrollTop = out.scrollHeight;
  }
  loadCatalog();
}
```

**Nota para el implementador:** antes de pegar, comprobar en `frontend/js/app.js` los nombres reales de los helpers `api()`, `showModal()`, `closeModal()` y la variable del token (`token`); si difieren (p. ej. `apiFetch`, `openModal`), adaptar las llamadas. El patrón de streaming de referencia está en la instalación de n8n (~línea 1917) y de mail (~línea 2218).

- [ ] **Step 4: Añadir `'catalog'`** a la lista de páginas de ayuda contextual en `app.js` ~línea 3180 (array con `'docker', 'n8n', ...`).

- [ ] **Step 5: Verificar manualmente**

Run: `npm run dev` y abrir `http://localhost:8585` → login → página Catálogo.
Expected: grid con las 5 apps, modal de instalación abre y muestra los modos correctos por app. (En macOS/Windows la instalación real fallará de forma controlada — Docker socket/MySQL ausentes — con mensaje claro en el `<pre>`.)

- [ ] **Step 6: Commit**

```bash
git add frontend/views/sidebar.html frontend/index.html frontend/js/app.js
git commit -m "feat(catalogo): página Catálogo con instalación en streaming y desinstalación con purga opt-in"
```

---

### Task 10: Docs + verificación final + merge

**Files:**
- Modify: `README.md` (sección de características: añadir "Catálogo de aplicaciones one-click")
- Modify: `CLAUDE.md` (añadir `catalog.js` a la lista de rutas y libs en Architecture; añadir el módulo a la descripción de "What is TecXPaneL")

- [ ] **Step 1: `CLAUDE.md`** — en la lista de `backend/routes/`, tras `notifications.js`:

```markdown
  - `catalog.js` — Catálogo de aplicaciones one-click (WordPress, Ghost, Nextcloud, Vaultwarden, Uptime Kuma). Instala en modo Docker (socket + pull con tag fijado + volumen persistente), nativo PHP-FPM (WordPress en /var/www/<dominio>) o PM2 (Ghost, Uptime Kuma en /opt/txpl-apps), según los modos declarados por app. DB MySQL del host creada vía el módulo databases (usuario con acceso desde 172.17.% para contenedores). Streaming con `__TXPL_DONE__`, rollback best-effort si falla a mitad, registro en `catalog_installs` solo al éxito. Desinstalación con purga de datos/DB opt-in. Helpers puros en `lib/catalog.js`, motor en `lib/catalogEngine.js`.
```

Y en la lista de libs, tras `lib/notifications.js`:

```markdown
- `backend/lib/catalog.js` — Helpers puros del catálogo (CATALOG declarativo con imagen:tag fijado por app, validación de opciones, config de contenedor, env de DB, wp-config.php, config de Ghost), unit-tested en `backend/test/catalog.test.js`.
- `backend/lib/catalogEngine.js` — Motor del catálogo: instala/desinstala según modo (docker/native/pm2), crea la DB, configura proxy Nginx + SSL y hace rollback si falla.
```

En "What is TecXPaneL" añadir `catálogo de apps one-click (WordPress, Ghost, Nextcloud, Vaultwarden, Uptime Kuma)` a la enumeración.

- [ ] **Step 2: `README.md`** — añadir a la lista de características:

```markdown
- **Catálogo de aplicaciones**: instala WordPress, Ghost, Nextcloud, Vaultwarden y Uptime Kuma con un clic, en Docker, nativo (PHP-FPM) o PM2 según prefieras, con dominio + SSL opcionales y base de datos gestionada.
```

- [ ] **Step 3: Verificación final**

Run: `npm test`
Expected: PASS todos (incluye `catalog.test.js`).

- [ ] **Step 4: Commit + merge a main**

```bash
git add README.md CLAUDE.md
git commit -m "docs(catalogo): README y CLAUDE.md"
git checkout main
git merge feat/catalogo-apps
npm test
git branch -d feat/catalogo-apps
```

---

## Self-review

- **Cobertura del spec:** catálogo 5 apps ✓ (Task 2), modos por app ✓ (Tasks 4-6), MySQL del host + usuario 172.17.% ✓ (Task 4), tabla fuente de verdad escrita solo al éxito ✓, rollback ✓, streaming ✓ (Task 8), purga opt-in con confirmación doble ✓ (Tasks 7, 9), credenciales una sola vez ✓, página Catálogo ✓ (Task 9), docs ✓ (Task 10).
- **Placeholders:** los stubs de Task 4 están explícitamente marcados y se sustituyen en Tasks 5-6 dentro de la misma rama.
- **Consistencia de tipos:** `installApp(appId, opts, write)` devuelve código 0/1 y las rutas lo pasan a `done()`; `opts` siempre es el objeto normalizado de `validateInstallOptions`.
