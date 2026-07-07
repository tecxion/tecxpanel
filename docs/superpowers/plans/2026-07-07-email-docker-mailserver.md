# Correo (docker-mailserver) Fase 1 — Plan de Implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Añadir un módulo de correo al panel basado en docker-mailserver (un contenedor): instalar/arrancar/parar/desinstalar, configurar hostname + TLS + puertos UFW, gestionar buzones y alias por la Docker socket exec API, generar DKIM y mostrar los registros DNS a añadir.

**Architecture:** Tres capas al estilo n8n: helpers puros y testeables (`lib/mail.js`), router HTTP con acceso a la Docker socket (`routes/mail.js`) y una tabla de config de fila única (`mail_config`). El contenedor `txpl-mail` es la fuente de la verdad de los buzones; el panel lo acciona ejecutando el script `setup` de docker-mailserver vía la exec API del socket de Docker.

**Tech Stack:** Node.js, Express, better-sqlite3, Docker Engine API por UNIX socket (`http` nativo), Certbot (`lib/nginx.installSsl`), UFW, `node:test`, frontend vanilla JS.

## Global Constraints

- **Idioma ESPAÑOL** en UI, comentarios, mensajes de error de API y commits.
- **Zero shell interpolation**: la exec API y los comandos reciben ARRAYS de argumentos; nunca cadenas para una shell. Validar email/dominio/contraseña antes de accionar el contenedor.
- **Contraseñas de buzón NUNCA persistidas** en la DB del panel (solo el hash vive dentro del contenedor).
- **Auditoría**: `audit(user, ip, action, detail)` en instalar/desinstalar, alta/baja de buzón, cambio de contraseña, alta/baja de alias y generación de DKIM.
- **Descarga de imagen con `&tag=` fijo** (nunca sin tag: bajaría todas las etiquetas).
- **Streaming** con centinela `__TXPL_DONE__<code>` y cabecera `X-Accel-Buffering: no` (patrón de `plugins.js`/`n8n.js`).
- **Tests** con `node:test` + `assert`, sin dependencias externas.
- No hay secretos hardcodeados (repo público).

---

## File Structure

- `backend/lib/mail.js` — **Crear.** Helpers puros: constantes, validadores, config del contenedor, constructores de argumentos del `setup`, parseo de listados y construcción de registros DNS.
- `backend/test/mail.test.js` — **Crear.** Tests unitarios de `lib/mail.js`.
- `backend/routes/mail.js` — **Crear.** Router `/api/mail`: helpers de Docker socket (request/pull/inspect/exec), ciclo de vida (status/install/config/actions/uninstall) y gestión (mailboxes/aliases/dkim/dns).
- `backend/database.js` — **Modificar.** Tabla `mail_config` + queries.
- `backend/server.js` — **Modificar.** Montar `app.use('/api/mail', require('./routes/mail'))`.
- `frontend/views/sidebar.html` — **Modificar.** Item "Correo".
- `frontend/views/pages/mail.html` — **Crear.** Plantilla de la página.
- `frontend/index.html` — **Modificar.** `<div class="page" id="page-mail"></div>`.
- `frontend/js/app.js` — **Modificar.** `loadMail()` y funciones asociadas; registrar en `pages` y `navigate()`.
- `README.md` y `CLAUDE.md` — **Modificar.** Documentar el módulo.

---

## Task 1: `lib/mail.js` — constantes, validadores y config del contenedor

**Files:**
- Create: `backend/lib/mail.js`
- Test: `backend/test/mail.test.js`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `MAIL_CONTAINER = 'txpl-mail'`, `MAIL_IMAGE = 'ghcr.io/docker-mailserver/docker-mailserver'`, `MAIL_TAG = 'latest'`, `MAIL_PORTS = [25, 465, 587, 143, 993]`.
  - `isValidEmail(addr) → boolean` — forma `local@dominio.tld`, sin espacios ni control.
  - `isValidMailDomain(d) → boolean` — hostname/dominio válido.
  - `isValidMailPassword(p) → boolean` — string de ≥ 6 chars, sin `\n`/`\r`/espacios.
  - `buildMailContainerConfig({ hostname, letsencryptDir }) → object` — config para `/containers/create`.

- [ ] **Step 1: Escribir los tests que fallan**

```javascript
// backend/test/mail.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const m = require('../lib/mail');

test('constantes y puertos', () => {
  assert.strictEqual(m.MAIL_CONTAINER, 'txpl-mail');
  assert.strictEqual(m.MAIL_IMAGE, 'ghcr.io/docker-mailserver/docker-mailserver');
  assert.strictEqual(m.MAIL_TAG, 'latest');
  assert.deepStrictEqual(m.MAIL_PORTS, [25, 465, 587, 143, 993]);
});

test('isValidEmail', () => {
  for (const a of ['user@example.com', 'a.b-c@sub.dominio.io']) assert.strictEqual(m.isValidEmail(a), true, a);
  for (const a of ['', 'nope', 'a@b', 'a b@c.com', 'x@y.com\n', 42, 'a@@b.com']) assert.strictEqual(m.isValidEmail(a), false, JSON.stringify(a));
});

test('isValidMailDomain', () => {
  for (const d of ['example.com', 'mail.sub.dominio.io']) assert.strictEqual(m.isValidMailDomain(d), true, d);
  for (const d of ['', 'no dominio', 'x', '-bad.com', 'a.b\n', 42]) assert.strictEqual(m.isValidMailDomain(d), false, JSON.stringify(d));
});

test('isValidMailPassword', () => {
  assert.strictEqual(m.isValidMailPassword('secreta123'), true);
  for (const p of ['', 'corta', 'con espacio', 'salto\nlinea', 42]) assert.strictEqual(m.isValidMailPassword(p), false, JSON.stringify(p));
});

test('buildMailContainerConfig: imagen, hostname, puertos, volúmenes y SSL', () => {
  const c = m.buildMailContainerConfig({ hostname: 'mail.dominio.com', letsencryptDir: '/etc/letsencrypt' });
  assert.strictEqual(c.Image, 'ghcr.io/docker-mailserver/docker-mailserver:latest');
  assert.strictEqual(c.Hostname, 'mail.dominio.com');
  assert.ok(c.Env.includes('SSL_TYPE=letsencrypt'));
  assert.deepStrictEqual(c.HostConfig.RestartPolicy, { Name: 'unless-stopped' });
  for (const p of ['25/tcp', '465/tcp', '587/tcp', '143/tcp', '993/tcp']) {
    assert.ok(c.ExposedPorts[p], `expuesto ${p}`);
    assert.deepStrictEqual(c.HostConfig.PortBindings[p], [{ HostPort: p.split('/')[0] }]);
  }
  assert.ok(c.HostConfig.Binds.includes('/etc/letsencrypt:/etc/letsencrypt:ro'));
  assert.ok(c.HostConfig.Binds.some((b) => b.endsWith(':/var/mail')));
  assert.ok(c.HostConfig.Binds.some((b) => b.endsWith(':/tmp/docker-mailserver')));
});

test('buildMailContainerConfig: letsencryptDir por defecto', () => {
  const c = m.buildMailContainerConfig({ hostname: 'mail.x.com' });
  assert.ok(c.HostConfig.Binds.includes('/etc/letsencrypt:/etc/letsencrypt:ro'));
});
```

- [ ] **Step 2: Ejecutar los tests para verificar que fallan**

Run: `node --test backend/test/mail.test.js`
Expected: FAIL con "Cannot find module '../lib/mail'".

- [ ] **Step 3: Implementar la primera parte de `backend/lib/mail.js`**

```javascript
'use strict';

// ============================================================
//  TecXPaneL — Helpers puros de Correo (docker-mailserver)
//
//  Sin estado ni dependencias del servidor: constantes, validación,
//  config del contenedor Docker, constructores de argumentos del
//  script `setup`, parseo de listados y registros DNS.
// ============================================================

const MAIL_CONTAINER = 'txpl-mail';
const MAIL_IMAGE = 'ghcr.io/docker-mailserver/docker-mailserver';
const MAIL_TAG = 'latest';
const MAIL_PORTS = [25, 465, 587, 143, 993];

// Volúmenes persistentes del contenedor (rutas oficiales de docker-mailserver).
const MAIL_VOLUMES = [
  'txpl_mail_data:/var/mail',
  'txpl_mail_state:/var/mail-state',
  'txpl_mail_logs:/var/log/mail',
  'txpl_mail_config:/tmp/docker-mailserver',
];

function isValidEmail(addr) {
  if (typeof addr !== 'string') return false;
  if (/[\s\n\r]/.test(addr)) return false;
  // local@dominio.tld — un solo @, y el dominio con al menos un punto.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr);
}

function isValidMailDomain(d) {
  if (typeof d !== 'string' || /[\s\n\r]/.test(d)) return false;
  // Etiquetas alfanuméricas separadas por puntos; sin empezar/terminar en guion.
  return /^(?=.{1,253}$)(?:(?!-)[A-Za-z0-9-]{1,63}(?<!-)\.)+[A-Za-z]{2,63}$/.test(d);
}

function isValidMailPassword(p) {
  return typeof p === 'string' && p.length >= 6 && !/[\s\n\r]/.test(p);
}

// Config para la Docker API /containers/create. TLS por Let's Encrypt: se monta
// /etc/letsencrypt en solo lectura y docker-mailserver lo consume (SSL_TYPE).
function buildMailContainerConfig({ hostname, letsencryptDir = '/etc/letsencrypt' } = {}) {
  const exposed = {};
  const bindings = {};
  for (const p of MAIL_PORTS) {
    const key = `${p}/tcp`;
    exposed[key] = {};
    bindings[key] = [{ HostPort: String(p) }];
  }
  return {
    Image: `${MAIL_IMAGE}:${MAIL_TAG}`,
    Hostname: hostname,
    Env: [
      'SSL_TYPE=letsencrypt',
      'PERMIT_DOCKER=none',
      'ENABLE_RSPAMD=1',
      'ENABLE_OPENDKIM=0',
      'ENABLE_CLAMAV=0',
      'ENABLE_FAIL2BAN=0',
      'ONE_DIR=1',
    ],
    ExposedPorts: exposed,
    HostConfig: {
      RestartPolicy: { Name: 'unless-stopped' },
      PortBindings: bindings,
      Binds: [...MAIL_VOLUMES, `${letsencryptDir}:/etc/letsencrypt:ro`],
    },
  };
}

module.exports = {
  MAIL_CONTAINER, MAIL_IMAGE, MAIL_TAG, MAIL_PORTS, MAIL_VOLUMES,
  isValidEmail, isValidMailDomain, isValidMailPassword, buildMailContainerConfig,
};
```

- [ ] **Step 4: Ejecutar los tests para verificar que pasan**

Run: `node --test backend/test/mail.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/lib/mail.js backend/test/mail.test.js
git commit -m "feat(mail): helpers puros (constantes, validadores, config contenedor) + tests"
```

---

## Task 2: `lib/mail.js` — argumentos de `setup`, parsers y registros DNS

**Files:**
- Modify: `backend/lib/mail.js` (añadir funciones + exports)
- Test: `backend/test/mail.test.js` (añadir tests)

**Interfaces:**
- Consumes: nada nuevo.
- Produces:
  - `setupEmailAddArgs(addr, pass) → string[]` — `['setup','email','add',addr,pass]`
  - `setupEmailDelArgs(addr) → string[]` — `['setup','email','del','-y',addr]`
  - `setupEmailUpdateArgs(addr, pass) → string[]` — `['setup','email','update',addr,pass]`
  - `setupEmailListArgs() → string[]` — `['setup','email','list']`
  - `setupAliasAddArgs(src, dst) → string[]` — `['setup','alias','add',src,dst]`
  - `setupAliasDelArgs(src, dst) → string[]` — `['setup','alias','del',src,dst]`
  - `setupAliasListArgs() → string[]` — `['setup','alias','list']`
  - `setupDkimArgs(domain) → string[]` — `['setup','config','dkim','keysize','2048','domain',domain]`
  - `parseEmailList(text) → [{ address }]` — extrae los emails del listado.
  - `parseAliasList(text) → [{ source, destination }]` — extrae los dos emails por línea.
  - `buildDnsRecords({ domain, hostname, serverIp, dkimPublic, dkimSelector }) → object[]` — registros MX/A/SPF/DKIM/DMARC/PTR.

- [ ] **Step 1: Añadir los tests que fallan al final de `backend/test/mail.test.js`**

```javascript
test('constructores de argumentos de setup', () => {
  assert.deepStrictEqual(m.setupEmailAddArgs('u@d.com', 'pass'), ['setup', 'email', 'add', 'u@d.com', 'pass']);
  assert.deepStrictEqual(m.setupEmailDelArgs('u@d.com'), ['setup', 'email', 'del', '-y', 'u@d.com']);
  assert.deepStrictEqual(m.setupEmailUpdateArgs('u@d.com', 'p2'), ['setup', 'email', 'update', 'u@d.com', 'p2']);
  assert.deepStrictEqual(m.setupEmailListArgs(), ['setup', 'email', 'list']);
  assert.deepStrictEqual(m.setupAliasAddArgs('a@d.com', 'b@d.com'), ['setup', 'alias', 'add', 'a@d.com', 'b@d.com']);
  assert.deepStrictEqual(m.setupAliasDelArgs('a@d.com', 'b@d.com'), ['setup', 'alias', 'del', 'a@d.com', 'b@d.com']);
  assert.deepStrictEqual(m.setupDkimArgs('dominio.com'), ['setup', 'config', 'dkim', 'keysize', '2048', 'domain', 'dominio.com']);
});

test('parseEmailList extrae las direcciones', () => {
  const out = m.parseEmailList('* user@dominio.com ( 0 / ~ ) [0%]\n* admin@dominio.com ( 1M / ~ )\n');
  assert.deepStrictEqual(out, [{ address: 'user@dominio.com' }, { address: 'admin@dominio.com' }]);
});

test('parseEmailList tolera ruido y vacío', () => {
  assert.deepStrictEqual(m.parseEmailList(''), []);
  assert.deepStrictEqual(m.parseEmailList('No accounts\n'), []);
});

test('parseAliasList extrae origen y destino', () => {
  const out = m.parseAliasList('* info@dominio.com admin@dominio.com\n* ventas@dominio.com user@dominio.com\n');
  assert.deepStrictEqual(out, [
    { source: 'info@dominio.com', destination: 'admin@dominio.com' },
    { source: 'ventas@dominio.com', destination: 'user@dominio.com' },
  ]);
});

test('buildDnsRecords produce MX/SPF/DKIM/DMARC/PTR', () => {
  const recs = m.buildDnsRecords({ domain: 'dominio.com', hostname: 'mail.dominio.com', serverIp: '1.2.3.4', dkimPublic: 'v=DKIM1; k=rsa; p=ABC', dkimSelector: 'mail' });
  const mx = recs.find((r) => r.type === 'MX');
  assert.strictEqual(mx.value, 'mail.dominio.com'); assert.strictEqual(mx.priority, 10); assert.strictEqual(mx.name, 'dominio.com');
  const a = recs.find((r) => r.type === 'A');
  assert.strictEqual(a.name, 'mail.dominio.com'); assert.strictEqual(a.value, '1.2.3.4');
  const spf = recs.find((r) => r.type === 'TXT' && r.name === 'dominio.com');
  assert.strictEqual(spf.value, 'v=spf1 mx ~all');
  const dkim = recs.find((r) => r.name === 'mail._domainkey.dominio.com');
  assert.strictEqual(dkim.value, 'v=DKIM1; k=rsa; p=ABC');
  const dmarc = recs.find((r) => r.name === '_dmarc.dominio.com');
  assert.match(dmarc.value, /^v=DMARC1;/);
  const ptr = recs.find((r) => r.type === 'PTR');
  assert.strictEqual(ptr.name, '1.2.3.4'); assert.strictEqual(ptr.value, 'mail.dominio.com');
});

test('buildDnsRecords sin DKIM aún: el registro DKIM lleva nota y valor vacío', () => {
  const recs = m.buildDnsRecords({ domain: 'dominio.com', hostname: 'mail.dominio.com', serverIp: '1.2.3.4', dkimPublic: null, dkimSelector: 'mail' });
  const dkim = recs.find((r) => r.name === 'mail._domainkey.dominio.com');
  assert.strictEqual(dkim.value, '');
  assert.match(dkim.note || '', /DKIM/);
});
```

- [ ] **Step 2: Ejecutar los tests para verificar que fallan**

Run: `node --test backend/test/mail.test.js`
Expected: FAIL con "m.setupEmailAddArgs is not a function".

- [ ] **Step 3: Añadir las funciones a `backend/lib/mail.js`** (antes de `module.exports`)

```javascript
// ── Constructores de argumentos del script `setup` de docker-mailserver ──
function setupEmailAddArgs(addr, pass) { return ['setup', 'email', 'add', addr, pass]; }
function setupEmailDelArgs(addr) { return ['setup', 'email', 'del', '-y', addr]; }
function setupEmailUpdateArgs(addr, pass) { return ['setup', 'email', 'update', addr, pass]; }
function setupEmailListArgs() { return ['setup', 'email', 'list']; }
function setupAliasAddArgs(src, dst) { return ['setup', 'alias', 'add', src, dst]; }
function setupAliasDelArgs(src, dst) { return ['setup', 'alias', 'del', src, dst]; }
function setupAliasListArgs() { return ['setup', 'alias', 'list']; }
function setupDkimArgs(domain) { return ['setup', 'config', 'dkim', 'keysize', '2048', 'domain', domain]; }

const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/g;

// Extrae las direcciones de la salida de `setup email list`.
function parseEmailList(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m1 = line.match(EMAIL_RE);
    if (m1 && m1.length) out.push({ address: m1[0] });
  }
  return out;
}

// Extrae origen/destino de la salida de `setup alias list` (dos emails por línea).
function parseAliasList(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m1 = line.match(EMAIL_RE);
    if (m1 && m1.length >= 2) out.push({ source: m1[0], destination: m1[1] });
  }
  return out;
}

// Construye los registros DNS a mostrar para que el usuario los cree.
function buildDnsRecords({ domain, hostname, serverIp, dkimPublic, dkimSelector }) {
  return [
    { type: 'A', name: hostname, value: serverIp || '', note: 'IP pública del servidor de correo.' },
    { type: 'MX', name: domain, value: hostname, priority: 10 },
    { type: 'TXT', name: domain, value: 'v=spf1 mx ~all', note: 'SPF.' },
    {
      type: 'TXT',
      name: `${dkimSelector || 'mail'}._domainkey.${domain}`,
      value: dkimPublic || '',
      note: dkimPublic ? 'DKIM.' : 'Genera primero el DKIM para obtener este valor.',
    },
    { type: 'TXT', name: `_dmarc.${domain}`, value: `v=DMARC1; p=quarantine; rua=mailto:postmaster@${domain}`, note: 'DMARC.' },
    { type: 'PTR', name: serverIp || '', value: hostname, note: 'rDNS: se solicita al proveedor del VPS, no en tu DNS.' },
  ];
}
```

Y añade estos nombres al `module.exports`:

```javascript
  setupEmailAddArgs, setupEmailDelArgs, setupEmailUpdateArgs, setupEmailListArgs,
  setupAliasAddArgs, setupAliasDelArgs, setupAliasListArgs, setupDkimArgs,
  parseEmailList, parseAliasList, buildDnsRecords,
```

- [ ] **Step 4: Ejecutar los tests para verificar que pasan**

Run: `node --test backend/test/mail.test.js`
Expected: PASS (12 tests en total).

- [ ] **Step 5: Commit**

```bash
git add backend/lib/mail.js backend/test/mail.test.js
git commit -m "feat(mail): argumentos de setup, parsers de listados y registros DNS + tests"
```

---

## Task 3: Esquema SQLite y queries

**Files:**
- Modify: `backend/database.js` (tabla `mail_config` + queries)

**Interfaces:**
- Consumes: nada.
- Produces (en `queries`):
  - `getMailConfig` → `SELECT * FROM mail_config WHERE id = 1`
  - `saveMailConfig` → upsert `ON CONFLICT(id)` sobre `mail_config`
  - `clearMailConfig` → `DELETE FROM mail_config WHERE id = 1`

- [ ] **Step 1: Añadir la tabla al bloque `CREATE TABLE` de `database.js`** (tras `cron_jobs`)

```sql
  CREATE TABLE IF NOT EXISTS mail_config (
    id            INTEGER PRIMARY KEY CHECK (id = 1),
    hostname      TEXT,
    domain        TEXT,
    container_id  TEXT,
    status        TEXT DEFAULT 'not_installed',
    dkim_selector TEXT DEFAULT 'mail',
    dkim_public   TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );
```

- [ ] **Step 2: Añadir las queries al objeto `queries`** (junto a las de cron/backups)

```javascript
  // ── Correo (docker-mailserver) ───────────────────────────
  getMailConfig: db.prepare('SELECT * FROM mail_config WHERE id = 1'),
  saveMailConfig: db.prepare(`
    INSERT INTO mail_config (id, hostname, domain, container_id, status, dkim_selector, dkim_public, created_at)
    VALUES (1, @hostname, @domain, @container_id, @status, @dkim_selector, @dkim_public, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      hostname = @hostname, domain = @domain, container_id = @container_id,
      status = @status, dkim_selector = @dkim_selector, dkim_public = @dkim_public`),
  clearMailConfig: db.prepare('DELETE FROM mail_config WHERE id = 1'),
```

- [ ] **Step 3: Verificar que el esquema carga y las queries existen**

Run: `TXPL_DIR=./ JWT_SECRET=$(printf 'x%.0s' {1..40}) node -e "const {queries}=require('./backend/database'); ['getMailConfig','saveMailConfig','clearMailConfig'].forEach(k=>{if(!queries[k])throw new Error('falta '+k)}); console.log('OK queries mail')"; rm -rf data`
Expected: imprime `OK queries mail`.

- [ ] **Step 4: Commit**

```bash
git add backend/database.js
git commit -m "feat(mail): tabla mail_config + queries"
```

---

## Task 4: Router `/api/mail` — Docker helpers + ciclo de vida + montaje

**Files:**
- Create: `backend/routes/mail.js`
- Modify: `backend/server.js` (montar tras `/api/cron`)

**Interfaces:**
- Consumes: `MAIL_CONTAINER`, `MAIL_IMAGE`, `MAIL_TAG`, `MAIL_PORTS`, `buildMailContainerConfig` (Task 1); `queries`, `audit` (Task 3); `ok`/`fail`/`clientIp`/`run`/`runSafe`/`wrap` (`helpers.js`); `nginx` (`lib/nginx.js`).
- Produces (endpoints bajo `/api/mail`, JWT ya aplicado):
  - `GET /status` → `{ docker, state, installed, running, configured, hostname, domain }`
  - `POST /install` (streaming) → descarga imagen + crea contenedor + abre UFW + arranca.
  - `POST /config` → guarda hostname/dominio; emite el cert TLS (best-effort) y reinicia el contenedor.
  - `POST /:action` → start/stop/restart.
  - `DELETE /` → para y elimina el contenedor (conserva los volúmenes de datos); limpia `mail_config`.
  - Helpers exportados internamente para Task 5: `dockerRequest`, `dockerExec`, `inspectContainer`, y el `router`.

- [ ] **Step 1: Implementar `backend/routes/mail.js`**

```javascript
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
```

> **Nota:** `dockerExec`, `inspectContainer` y `dockerRequest` quedan en el ámbito
> del módulo; la Task 5 añade endpoints en este mismo archivo y los usa
> directamente (no hace falta exportarlos).

- [ ] **Step 2: Montar el router en `backend/server.js`** (tras la línea de `/api/cron`)

```javascript
app.use('/api/mail', require('./routes/mail'));
```

- [ ] **Step 3: Verificar que el router carga sin errores**

Run: `TXPL_DIR=./ JWT_SECRET=$(printf 'x%.0s' {1..40}) node -e "require('./backend/routes/mail'); console.log('router mail OK')"; rm -rf data`
Expected: imprime `router mail OK`.

- [ ] **Step 4: Ejecutar la batería de tests (no debe romperse nada)**

Run: `node --test "backend/test/**/*.test.js"`
Expected: PASS (incluye los 12 de mail.test.js).

- [ ] **Step 5: Commit**

```bash
git add backend/routes/mail.js backend/server.js
git commit -m "feat(mail): router /api/mail — ciclo de vida (install/config/actions/uninstall)"
```

---

## Task 5: Router `/api/mail` — buzones, alias, DKIM y DNS

**Files:**
- Modify: `backend/routes/mail.js` (añadir endpoints antes de `module.exports`)

**Interfaces:**
- Consumes: los helpers de Task 4 (`dockerExec`, `inspectContainer`, `dockerRequest`); `queries`, `audit`; los helpers puros de `lib/mail.js` (`setup*Args`, `parseEmailList`, `parseAliasList`, `buildDnsRecords`, validadores).
- Produces (endpoints bajo `/api/mail`):
  - `GET /mailboxes` → `{ mailboxes: [{address}] }`
  - `POST /mailboxes` (body `{ address, password }`)
  - `PUT /mailboxes` (body `{ address, password }` — cambia contraseña)
  - `DELETE /mailboxes` (body `{ address }`)
  - `GET /aliases` → `{ aliases: [{source,destination}] }`
  - `POST /aliases` (body `{ source, destination }`)
  - `DELETE /aliases` (body `{ source, destination }`)
  - `POST /dkim` → genera DKIM, guarda la clave pública.
  - `GET /dns` → `{ records: [...] }`

- [ ] **Step 1: Añadir los imports y endpoints a `backend/routes/mail.js`**

Amplía la línea de import de `../lib/mail` para traer también los helpers nuevos:

```javascript
const {
  MAIL_CONTAINER, MAIL_IMAGE, MAIL_TAG, MAIL_PORTS, buildMailContainerConfig, isValidMailDomain,
  isValidEmail, isValidMailPassword,
  setupEmailAddArgs, setupEmailDelArgs, setupEmailUpdateArgs, setupEmailListArgs,
  setupAliasAddArgs, setupAliasDelArgs, setupAliasListArgs, setupDkimArgs,
  parseEmailList, parseAliasList, buildDnsRecords,
} = require('../lib/mail');
```

Añade estos endpoints **justo antes** de `module.exports = router;`:

```javascript
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
    const r = await dockerExec(insp.id, ['sh', '-c', `cat /tmp/docker-mailserver/rspamd/dkim/*.public.dkim.txt 2>/dev/null | tr -d '\\n\\t"' `]);
    pub = (r.output || '').replace(/.*p=/, 'v=DKIM1; k=rsa; p=').trim();
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
```

> **Nota de implementación (DKIM):** la ruta y el formato exactos del fichero de
> clave pública DKIM dependen de la versión de docker-mailserver (con Rspamd
> suele estar bajo `/tmp/docker-mailserver/rspamd/dkim/`). El código lee cualquier
> `*.public.dkim.txt` de esa carpeta y normaliza a `v=DKIM1; k=rsa; p=...`. Si el
> formato difiere en tu versión, el valor puede requerir ajuste — pero el flujo
> (generar → leer → guardar → mostrar) es correcto. No inventes otra ruta: usa la
> del glob indicado.

- [ ] **Step 2: Verificar que el router sigue cargando**

Run: `TXPL_DIR=./ JWT_SECRET=$(printf 'x%.0s' {1..40}) node -e "require('./backend/routes/mail'); console.log('router mail OK')"; rm -rf data`
Expected: imprime `router mail OK`.

- [ ] **Step 3: Ejecutar la batería de tests**

Run: `node --test "backend/test/**/*.test.js"`
Expected: PASS (sin cambios respecto a Task 4; estos endpoints no tienen unit test, se verifican en VPS).

- [ ] **Step 4: Commit**

```bash
git add backend/routes/mail.js
git commit -m "feat(mail): endpoints de buzones, alias, DKIM y registros DNS"
```

---

## Task 6: Frontend — sección "Correo"

**Files:**
- Modify: `frontend/views/sidebar.html` (item de navegación)
- Create: `frontend/views/pages/mail.html`
- Modify: `frontend/index.html` (contenedor de página)
- Modify: `frontend/js/app.js` (`pages`, `navigate`, `loadMail` y acciones)

**Interfaces:**
- Consumes: endpoints de Tasks 4-5; helpers `req()`, `esc()`, la constante `API`, la global `TOKEN`, `doLogout()`.
- Produces: `loadMail()`, `mailInstall()`, `mailAction(action)`, `mailUninstall()`, `mailSaveConfig()`, `mailAddMailbox()`, `mailPassword(addr)`, `mailDeleteMailbox(addr)`, `mailAddAlias()`, `mailDeleteAlias(src,dst)`, `mailGenDkim()`, `mailLoadDns()`.

- [ ] **Step 1: Añadir el item al sidebar** (`frontend/views/sidebar.html`, tras el de "Tareas programadas")

```html
<div class="nav-item" data-page="mail" onclick="navigate(this)"><i class="ti ti-mail"></i> Correo</div>
```

- [ ] **Step 2: Añadir el contenedor de página** (`frontend/index.html`, junto a los demás `page-*`)

```html
<div class="page" id="page-mail"></div>
```

- [ ] **Step 3: Crear la plantilla** `frontend/views/pages/mail.html`

```html
<div class="page-header">
  <h1><i class="ti ti-mail"></i> Correo</h1>
</div>
<div id="mail-body">Cargando…</div>
<div class="console" id="mail-console" style="display:none"></div>
```

- [ ] **Step 4: Registrar la página en `loadTemplates` y `navigate`** (`frontend/js/app.js`)

En el array `pages` de `loadTemplates()` añade `'mail'`. En `navigate()` añade:

```javascript
  if (page === 'mail') loadMail();
```

Y añade `mail: 'Correo'` al objeto `titles` (junto a las demás secciones), para el título de la barra superior.

- [ ] **Step 5: Implementar las funciones** (`frontend/js/app.js`, junto a las de otras secciones)

```javascript
// Streaming reutilizable (mismo patrón que streamConsole de backups).
async function mailStream(path, body, el) {
  const DONE = '__TXPL_DONE__';
  const r = await fetch(API + '/api' + path, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (r.status === 401) { doLogout(); return 1; }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', code = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let show = buf;
    const idx = buf.indexOf(DONE);
    if (idx >= 0) { code = parseInt(buf.slice(idx + DONE.length).trim(), 10) || 0; show = buf.slice(0, idx); }
    el.textContent = show; el.scrollTop = el.scrollHeight;
  }
  return code;
}

async function loadMail() {
  const st = await req('GET', '/mail/status');
  if (!st) return;
  const body = document.getElementById('mail-body');
  if (!st.docker) {
    body.innerHTML = '<div class="card"><p>El correo necesita <b>Docker</b>. Instálalo desde <a href="#" onclick="navigate(document.querySelector(\'[data-page=plugins]\'));return false">Plugins</a>.</p></div>';
    return;
  }
  if (st.state === 'not_installed') {
    body.innerHTML = `<div class="card">
      <h3>Instalar correo</h3>
      <p class="muted">Instala docker-mailserver (un contenedor). Necesita ~1 GB de RAM y abrirá los puertos 25/465/587/143/993.</p>
      <button class="btn btn-primary" onclick="mailInstall()"><i class="ti ti-download"></i> Instalar correo</button>
    </div>`;
    return;
  }
  if (st.state === 'stopped') {
    body.innerHTML = `<div class="card"><p>El correo está instalado pero parado.</p>
      <button class="btn btn-success" onclick="mailAction('start')"><i class="ti ti-player-play"></i> Arrancar</button>
      <button class="btn btn-danger" onclick="mailUninstall()"><i class="ti ti-trash"></i> Desinstalar</button></div>`;
    return;
  }
  if (st.state === 'needs_config') {
    body.innerHTML = `<div class="card">
      <h3>Configurar el correo</h3>
      <p class="muted">Indica el hostname del correo (ej. <code>mail.tudominio.com</code>). El panel emitirá el certificado TLS con Certbot.</p>
      <div class="form-row"><input type="text" id="mail-hostname" placeholder="mail.tudominio.com" style="width:320px"></div>
      <button class="btn btn-primary" onclick="mailSaveConfig()"><i class="ti ti-device-floppy"></i> Guardar y emitir TLS</button>
    </div>`;
    return;
  }
  // ready
  body.innerHTML = `
    <div class="card">
      <h3><i class="ti ti-settings"></i> Configuración</h3>
      <p>Hostname: <b>${esc(st.hostname)}</b> · Dominio: <b>${esc(st.domain)}</b></p>
      <button class="btn btn-sm" onclick="mailAction('restart')"><i class="ti ti-refresh"></i> Reiniciar</button>
      <button class="btn btn-sm btn-danger" onclick="mailUninstall()"><i class="ti ti-trash"></i> Desinstalar</button>
    </div>
    <div class="card">
      <h3><i class="ti ti-inbox"></i> Buzones</h3>
      <div class="form-row">
        <input type="text" id="mb-addr" placeholder="usuario@${esc(st.domain)}" style="width:240px">
        <input type="password" id="mb-pass" placeholder="Contraseña" style="width:180px">
        <button class="btn btn-primary" onclick="mailAddMailbox()">Crear</button>
      </div>
      <div id="mail-mailboxes">Cargando…</div>
    </div>
    <div class="card">
      <h3><i class="ti ti-arrows-right"></i> Alias</h3>
      <div class="form-row">
        <input type="text" id="al-src" placeholder="info@${esc(st.domain)}" style="width:220px">
        <input type="text" id="al-dst" placeholder="destino@${esc(st.domain)}" style="width:220px">
        <button class="btn btn-primary" onclick="mailAddAlias()">Crear alias</button>
      </div>
      <div id="mail-aliases">Cargando…</div>
    </div>
    <div class="card">
      <h3><i class="ti ti-shield-lock"></i> DKIM y DNS</h3>
      <button class="btn" onclick="mailGenDkim()"><i class="ti ti-key"></i> Generar DKIM</button>
      <button class="btn" onclick="mailLoadDns()"><i class="ti ti-list"></i> Ver registros DNS</button>
      <div id="mail-dns"></div>
    </div>`;
  loadMailboxes(); loadAliases();
}

async function mailInstall() {
  const con = document.getElementById('mail-console');
  con.style.display = 'block'; con.textContent = '';
  await mailStream('/mail/install', {}, con);
  loadMail();
}

async function mailAction(a) { await req('POST', `/mail/${a}`); loadMail(); }
async function mailUninstall() {
  if (!confirm('¿Desinstalar el correo? Se elimina el contenedor (los datos de correo se conservan en su volumen).')) return;
  await req('DELETE', '/mail'); loadMail();
}

async function mailSaveConfig() {
  const hostname = document.getElementById('mail-hostname').value.trim();
  const r = await req('POST', '/mail/config', { hostname });
  if (r && r.error) { alert(r.error); return; }
  if (r && r.tls && r.tls !== 'ok') alert('Guardado. TLS ' + r.tls);
  loadMail();
}

async function loadMailboxes() {
  const r = await req('GET', '/mail/mailboxes');
  const el = document.getElementById('mail-mailboxes'); if (!el) return;
  if (!r || r.error) { el.innerHTML = `<p class="muted">${esc((r && r.error) || 'No se pudieron cargar')}</p>`; return; }
  if (!r.mailboxes.length) { el.innerHTML = '<p class="muted">Aún no hay buzones.</p>'; return; }
  el.innerHTML = '<table class="table"><tbody>' + r.mailboxes.map((b) => `<tr>
    <td>${esc(b.address)}</td>
    <td style="text-align:right">
      <button class="btn btn-sm" onclick="mailPassword('${esc(b.address)}')"><i class="ti ti-key"></i></button>
      <button class="btn btn-sm btn-danger" onclick="mailDeleteMailbox('${esc(b.address)}')"><i class="ti ti-trash"></i></button>
    </td></tr>`).join('') + '</tbody></table>';
}

async function mailAddMailbox() {
  const address = document.getElementById('mb-addr').value.trim();
  const password = document.getElementById('mb-pass').value;
  const r = await req('POST', '/mail/mailboxes', { address, password });
  if (r && r.error) { alert(r.error); return; }
  document.getElementById('mb-addr').value = ''; document.getElementById('mb-pass').value = '';
  loadMailboxes();
}

async function mailPassword(addr) {
  const password = prompt(`Nueva contraseña para ${addr} (mínimo 6, sin espacios):`);
  if (!password) return;
  const r = await req('PUT', '/mail/mailboxes', { address: addr, password });
  if (r && r.error) alert(r.error); else alert('Contraseña actualizada.');
}

async function mailDeleteMailbox(addr) {
  if (!confirm(`¿Borrar el buzón ${addr}?`)) return;
  await req('DELETE', '/mail/mailboxes', { address: addr });
  loadMailboxes();
}

async function loadAliases() {
  const r = await req('GET', '/mail/aliases');
  const el = document.getElementById('mail-aliases'); if (!el) return;
  if (!r || r.error) { el.innerHTML = `<p class="muted">${esc((r && r.error) || 'No se pudieron cargar')}</p>`; return; }
  if (!r.aliases.length) { el.innerHTML = '<p class="muted">Aún no hay alias.</p>'; return; }
  el.innerHTML = '<table class="table"><tbody>' + r.aliases.map((a) => `<tr>
    <td>${esc(a.source)} → ${esc(a.destination)}</td>
    <td style="text-align:right"><button class="btn btn-sm btn-danger" onclick="mailDeleteAlias('${esc(a.source)}','${esc(a.destination)}')"><i class="ti ti-trash"></i></button></td>
    </tr>`).join('') + '</tbody></table>';
}

async function mailAddAlias() {
  const source = document.getElementById('al-src').value.trim();
  const destination = document.getElementById('al-dst').value.trim();
  const r = await req('POST', '/mail/aliases', { source, destination });
  if (r && r.error) { alert(r.error); return; }
  document.getElementById('al-src').value = ''; document.getElementById('al-dst').value = '';
  loadAliases();
}

async function mailDeleteAlias(source, destination) {
  if (!confirm(`¿Borrar el alias ${source} → ${destination}?`)) return;
  await req('DELETE', '/mail/aliases', { source, destination });
  loadAliases();
}

async function mailGenDkim() {
  const r = await req('POST', '/mail/dkim');
  if (r && r.error) { alert(r.error); return; }
  alert('DKIM generado. Pulsa "Ver registros DNS" para copiar el valor.');
  mailLoadDns();
}

async function mailLoadDns() {
  const r = await req('GET', '/mail/dns');
  const el = document.getElementById('mail-dns'); if (!el) return;
  if (!r || r.error) { el.innerHTML = `<p class="muted">${esc((r && r.error) || 'No disponible')}</p>`; return; }
  el.innerHTML = '<table class="table"><thead><tr><th>Tipo</th><th>Nombre</th><th>Valor</th></tr></thead><tbody>' +
    r.records.map((rec) => `<tr>
      <td>${esc(rec.type)}${rec.priority ? ' (' + rec.priority + ')' : ''}</td>
      <td><code>${esc(rec.name)}</code></td>
      <td><code>${esc(rec.value || '—')}</code>${rec.note ? `<br><span class="muted">${esc(rec.note)}</span>` : ''}</td>
    </tr>`).join('') + '</tbody></table>';
}
```

> **Nota:** `req()` (antepone `/api`), `esc()`, `API`, `TOKEN`, `doLogout()` ya
> existen en `app.js`. `req` acepta un body también en GET/DELETE (lo serializa a
> JSON), que es como estos endpoints reciben `{address}`/`{source,destination}`.
> Verifícalo mirando la firma de `req` antes de asumir; si `req` no envía body en
> DELETE, usa `fetch` directo con el patrón de `mailStream` para esos casos.

- [ ] **Step 6: Verificar que `app.js` sigue parseando**

Run: `node --check frontend/js/app.js && echo "app.js OK"`
Expected: `app.js OK`.

- [ ] **Step 7: Commit**

```bash
git add frontend/views/sidebar.html frontend/views/pages/mail.html frontend/index.html frontend/js/app.js
git commit -m "feat(mail): sección Correo en el frontend (ciclo de vida, buzones, alias, DKIM/DNS)"
```

---

## Task 7: Documentación (README + CLAUDE.md)

**Files:**
- Modify: `README.md` (bullet de característica + sección dedicada)
- Modify: `CLAUDE.md` (router `mail.js` + `lib/mail.js`)

- [ ] **Step 1: Añadir el bullet de característica en README** (en "🚀 Características Principales", tras el de Tareas Programadas)

```markdown
- 📧 **Correo Electrónico**: Servidor de correo autohospedado con **docker-mailserver** (Postfix + Dovecot + Rspamd + DKIM) en un solo contenedor. Instálalo desde el panel, configura el hostname con **TLS automático** (Certbot), gestiona **buzones** y **alias**, genera **DKIM** y consulta los **registros DNS** (MX/SPF/DKIM/DMARC) a añadir.
```

- [ ] **Step 2: Añadir la sección dedicada en README** (tras la sección "## ⏰ Tareas Programadas (Cron)")

```markdown
---

## 📧 Correo Electrónico

TecXPaneL integra **docker-mailserver** (un contenedor ligero: Postfix, Dovecot,
Rspamd, DKIM) gestionado desde el panel — sin editar ficheros de configuración.

> [!NOTE]
> Requiere **Docker** (desde Plugins) y ~1 GB de RAM para el contenedor.

**Flujo de uso:**

1.  En **Correo** pulsa **Instalar**: el panel descarga docker-mailserver, crea el
    contenedor y abre los puertos SMTP/IMAP (25/465/587/143/993) en el firewall.
2.  Indica el **hostname** del correo (ej. `mail.tudominio.com`); el panel emite el
    **certificado TLS** con Certbot y lo monta en el contenedor.
3.  Crea **buzones** (con contraseña) y **alias** desde la UI.
4.  Genera el **DKIM** y añade en tu proveedor DNS los registros que el panel te
    muestra: **MX**, **SPF**, **DKIM**, **DMARC** (y el **PTR/rDNS** en tu proveedor
    de VPS).

> [!WARNING]
> El correo autohospedado **no funciona hasta que el DNS esté correcto** (sobre
> todo MX y el PTR/rDNS). Además, enviar a Gmail/Outlook desde una IP de VPS nueva
> puede acabar en spam hasta que la IP gane reputación. El cifrado del propio
> tráfico y la autenticación (SPF/DKIM/DMARC) mitigan esto una vez configurados.
```

- [ ] **Step 3: Actualizar CLAUDE.md** (listas de `backend/routes/` y `backend/lib/`)

Añade a la lista de routers:

```markdown
  - `mail.js` — Correo (docker-mailserver). Instala/gestiona un contenedor `txpl-mail` por el socket de Docker: ciclo de vida (install streaming, config con TLS vía Certbot, start/stop/restart/uninstall), y gestión de buzones/alias/DKIM ejecutando el script `setup` dentro del contenedor por la exec API. El contenedor es la fuente de la verdad; las contraseñas no se persisten. Config (hostname/dominio/dkim) en la tabla `mail_config`. Helpers puros en `lib/mail.js`.
```

Añade a la lista de `lib/`:

```markdown
- `backend/lib/mail.js` — Helpers puros de correo (validadores de email/dominio/contraseña, config del contenedor docker-mailserver, constructores de argumentos del `setup`, parseo de listados de buzones/alias, y construcción de registros DNS), unit-tested en `backend/test/mail.test.js`.
```

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs(mail): documentar el módulo de correo (docker-mailserver) en README y CLAUDE"
```

---

## Notas de verificación en VPS (post-implementación)

1. `npm run dev` local: la sección "Correo" carga; sin Docker muestra el aviso; los helpers puros pasan sus tests.
2. En VPS con Docker: **Instalar** → verificar que la imagen baja, el contenedor `txpl-mail` arranca y UFW abre los puertos.
3. **Configurar** hostname con DNS ya apuntando: el cert TLS se emite y el contenedor reinicia.
4. Crear un buzón y comprobar login IMAP/SMTP con un cliente; crear un alias y comprobar el reenvío.
5. **Generar DKIM** y confirmar que `GET /dns` muestra el valor DKIM real; publicar MX/SPF/DKIM/DMARC y probar envío/recepción.
6. Desinstalar y confirmar que el contenedor se elimina pero el volumen `txpl_mail_data` persiste.
