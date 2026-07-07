# DNS (PowerDNS autoritativo) Fase 1 — Plan de Implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Añadir un módulo de DNS autoritativo al panel: instala PowerDNS nativo (apt) con backend SQLite y API HTTP, configura nameservers (ns1/ns2 + IP), y gestiona zonas y registros (A/AAAA/CNAME/MX/TXT) por la API de PowerDNS, con guía y verificación de delegación.

**Architecture:** Tres capas al estilo n8n/mail: helpers puros y testeables (`lib/dns.js`), router HTTP (`routes/dns.js`) y una tabla de config de fila única cifrada (`dns_config`). PowerDNS es la fuente de la verdad de zonas/registros; el panel habla con su API HTTP por loopback (`127.0.0.1:8081`, cabecera `X-API-Key`) con la api-key cifrada en reposo.

**Tech Stack:** Node.js, Express, better-sqlite3, PowerDNS Authoritative Server (apt: `pdns-server` + `pdns-backend-sqlite3`), su API HTTP, `execFile`/`spawn`, UFW, `node:test`, frontend vanilla JS.

## Global Constraints

- **Idioma ESPAÑOL** en UI, comentarios, mensajes de error de API y commits.
- **Zero shell interpolation**: instalación/comandos vía `execFile`/`spawn` con ARRAYS; la config de PowerDNS se escribe a fichero (nunca se interpola en una shell). Los scripts `bash -c` de instalación usan cadenas FIJAS (sin datos de usuario).
- **API key generada por instalación** (`crypto.randomBytes`) y **cifrada en reposo** (`encryptSecret`); nunca hardcodeada. El backend habla con PowerDNS por loopback.
- **Validación estricta** de dominios y de cada registro por tipo antes de tocar la API.
- **Auditoría**: `audit(user, ip, action, detail)` en instalar, configurar, crear/borrar zona y crear/borrar registro.
- **UFW**: solo el puerto 53 (TCP+UDP) se abre, en la instalación.
- **Streaming** de instalación con centinela `__TXPL_DONE__<code>` y `X-Accel-Buffering: no`.
- **PowerDNS bindea a la IP pública** (`local-address=<IP>`), no a 0.0.0.0 (evita el choque con `systemd-resolved` en 127.0.0.53).
- **Tests** con `node:test` + `assert`, sin dependencias externas.

---

## File Structure

- `backend/lib/dns.js` — **Crear.** Helpers puros: constantes, validadores (dominio, IP, registro por tipo), `canonical`, construcción del payload de zona, del PATCH de rrset, del contenido de registro por tipo, de los glue records, y parseo de respuestas de la API.
- `backend/test/dns.test.js` — **Crear.** Tests unitarios de `lib/dns.js`.
- `backend/routes/dns.js` — **Crear.** Router `/api/dns`: cliente `pdnsApi`, ciclo de vida (status/install/config) y gestión (zonas/registros/delegación).
- `backend/database.js` — **Modificar.** Tabla `dns_config` + queries.
- `backend/server.js` — **Modificar.** Montar `app.use('/api/dns', require('./routes/dns'))`.
- `frontend/views/sidebar.html` — **Modificar.** Item "DNS".
- `frontend/views/pages/dns.html` — **Crear.** Plantilla de la página.
- `frontend/index.html` — **Modificar.** `<div class="page" id="page-dns"></div>`.
- `frontend/js/app.js` — **Modificar.** `loadDns()` y funciones asociadas; registrar en `pages`, `navigate` y `titles`.
- `README.md` y `CLAUDE.md` — **Modificar.** Documentar el módulo.

---

## Task 1: `lib/dns.js` — constantes, validadores y `canonical`

**Files:**
- Create: `backend/lib/dns.js`
- Test: `backend/test/dns.test.js`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `SUPPORTED_TYPES = ['A','AAAA','CNAME','MX','TXT']`.
  - `canonical(name) → string` — asegura el punto final (FQDN). `canonical('a.com')==='a.com.'`, `canonical('a.com.')==='a.com.'`.
  - `isValidDnsDomain(d) → boolean` — dominio válido (sin punto final, sin espacios).
  - `isValidIpv4(ip) → boolean`, `isValidIpv6(ip) → boolean`.
  - `isValidRecord(type, value) → boolean` — por tipo: A→IPv4, AAAA→IPv6, CNAME→hostname, TXT→no vacío sin saltos de línea, MX→hostname (el host; la prioridad se valida aparte).
  - `isValidPriority(p) → boolean` — entero 0..65535.

- [ ] **Step 1: Escribir los tests que fallan**

```javascript
// backend/test/dns.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const d = require('../lib/dns');

test('SUPPORTED_TYPES y canonical', () => {
  assert.deepStrictEqual(d.SUPPORTED_TYPES, ['A', 'AAAA', 'CNAME', 'MX', 'TXT']);
  assert.strictEqual(d.canonical('ejemplo.com'), 'ejemplo.com.');
  assert.strictEqual(d.canonical('ejemplo.com.'), 'ejemplo.com.');
  assert.strictEqual(d.canonical('www.ejemplo.com'), 'www.ejemplo.com.');
});

test('isValidDnsDomain', () => {
  for (const x of ['ejemplo.com', 'sub.ejemplo.io']) assert.strictEqual(d.isValidDnsDomain(x), true, x);
  for (const x of ['', 'x', 'ejemplo', '-mal.com', 'a b.com', 'a.com.', 42]) assert.strictEqual(d.isValidDnsDomain(x), false, JSON.stringify(x));
});

test('isValidIpv4 / isValidIpv6', () => {
  assert.strictEqual(d.isValidIpv4('1.2.3.4'), true);
  assert.strictEqual(d.isValidIpv4('999.1.1.1'), false);
  assert.strictEqual(d.isValidIpv4('::1'), false);
  assert.strictEqual(d.isValidIpv6('2001:db8::1'), true);
  assert.strictEqual(d.isValidIpv6('1.2.3.4'), false);
});

test('isValidRecord por tipo', () => {
  assert.strictEqual(d.isValidRecord('A', '1.2.3.4'), true);
  assert.strictEqual(d.isValidRecord('A', 'no-ip'), false);
  assert.strictEqual(d.isValidRecord('AAAA', '2001:db8::1'), true);
  assert.strictEqual(d.isValidRecord('AAAA', '1.2.3.4'), false);
  assert.strictEqual(d.isValidRecord('CNAME', 'destino.ejemplo.com'), true);
  assert.strictEqual(d.isValidRecord('CNAME', 'no dominio'), false);
  assert.strictEqual(d.isValidRecord('MX', 'mail.ejemplo.com'), true);
  assert.strictEqual(d.isValidRecord('TXT', 'v=spf1 mx ~all'), true);
  assert.strictEqual(d.isValidRecord('TXT', ''), false);
  assert.strictEqual(d.isValidRecord('TXT', 'con\nsalto'), false);
  assert.strictEqual(d.isValidRecord('OTRO', 'x'), false);
});

test('isValidPriority', () => {
  assert.strictEqual(d.isValidPriority(10), true);
  assert.strictEqual(d.isValidPriority(0), true);
  assert.strictEqual(d.isValidPriority(65535), true);
  assert.strictEqual(d.isValidPriority(-1), false);
  assert.strictEqual(d.isValidPriority(70000), false);
  assert.strictEqual(d.isValidPriority('10'), false);
});
```

- [ ] **Step 2: Ejecutar los tests para verificar que fallan**

Run: `node --test backend/test/dns.test.js`
Expected: FAIL con "Cannot find module '../lib/dns'".

- [ ] **Step 3: Implementar la primera parte de `backend/lib/dns.js`**

```javascript
'use strict';

// ============================================================
//  TecXPaneL — Helpers puros de DNS (PowerDNS)
//
//  Sin estado ni dependencias del servidor: validación de dominios
//  y registros, canonicalización FQDN, y construcción de payloads
//  para la API de PowerDNS y de los registros de delegación.
// ============================================================

const SUPPORTED_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT'];

// Dominio válido SIN punto final (como lo introduce el usuario).
const RE_DOMAIN = /^(?=.{1,253}$)(?:(?!-)[A-Za-z0-9-]{1,63}(?<!-)\.)+[A-Za-z]{2,63}$/;

// Asegura el punto final (FQDN) que exige PowerDNS.
function canonical(name) {
  const s = String(name || '').trim();
  return s.endsWith('.') ? s : s + '.';
}

function isValidDnsDomain(x) {
  return typeof x === 'string' && !x.endsWith('.') && RE_DOMAIN.test(x);
}

function isValidIpv4(ip) {
  if (typeof ip !== 'string') return false;
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  return m.slice(1).every((o) => Number(o) >= 0 && Number(o) <= 255);
}

function isValidIpv6(ip) {
  if (typeof ip !== 'string' || ip.includes('.') || /[^0-9a-fA-F:]/.test(ip)) return false;
  // Debe tener al menos dos ':' o una compresión '::', y grupos hex de 1-4.
  if (!ip.includes(':')) return false;
  return ip.split(':').every((g) => g === '' || /^[0-9a-fA-F]{1,4}$/.test(g));
}

// Un hostname es un dominio válido (para CNAME/MX).
function isValidHostname(h) {
  return isValidDnsDomain(h);
}

function isValidRecord(type, value) {
  switch (type) {
    case 'A': return isValidIpv4(value);
    case 'AAAA': return isValidIpv6(value);
    case 'CNAME': return isValidHostname(value);
    case 'MX': return isValidHostname(value);
    case 'TXT': return typeof value === 'string' && value.trim() !== '' && !/[\n\r]/.test(value);
    default: return false;
  }
}

function isValidPriority(p) {
  return Number.isInteger(p) && p >= 0 && p <= 65535;
}

module.exports = {
  SUPPORTED_TYPES, canonical, isValidDnsDomain, isValidIpv4, isValidIpv6,
  isValidHostname, isValidRecord, isValidPriority,
};
```

- [ ] **Step 4: Ejecutar los tests para verificar que pasan**

Run: `node --test backend/test/dns.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/lib/dns.js backend/test/dns.test.js
git commit -m "feat(dns): helpers puros (validadores, canonical) + tests"
```

---

## Task 2: `lib/dns.js` — payloads de PowerDNS, contenido de registro, glue y parsers

**Files:**
- Modify: `backend/lib/dns.js` (añadir funciones + exports)
- Test: `backend/test/dns.test.js` (añadir tests)

**Interfaces:**
- Consumes: `canonical` (Task 1).
- Produces:
  - `buildRecordContent(type, value, priority) → string` — contenido del registro para PowerDNS: A/AAAA→value; TXT→value entre comillas si no lo está; CNAME→`canonical(value)`; MX→`${priority} ${canonical(value)}`.
  - `buildZonePayload({ domain, ns1, ns2 }) → object` — `{ name: canonical(domain), kind: 'Native', nameservers: [canonical(ns1), canonical(ns2)] }`.
  - `buildRrsetPatch({ name, type, contents, ttl, changetype }) → object` — `{ rrsets: [{ name: canonical(name), type, ttl, changetype, records: contents.map(c => ({ content: c, disabled: false })) }] }`. Para `DELETE`, `records` va vacío.
  - `buildGlueRecords({ ns1, ns2, serverIp }) → object[]` — `[{ type:'A', name: ns1, value: serverIp }, { type:'A', name: ns2, value: serverIp }]`.
  - `parseZones(json) → [{ name }]` — de la respuesta de `GET /zones` (quita el punto final).
  - `parseRecords(zoneJson) → [{ name, type, ttl, content }]` — aplana los `rrsets` de la respuesta de `GET /zones/<id>`.

- [ ] **Step 1: Añadir los tests que fallan al final de `backend/test/dns.test.js`**

```javascript
test('buildRecordContent por tipo', () => {
  assert.strictEqual(d.buildRecordContent('A', '1.2.3.4'), '1.2.3.4');
  assert.strictEqual(d.buildRecordContent('AAAA', '2001:db8::1'), '2001:db8::1');
  assert.strictEqual(d.buildRecordContent('CNAME', 'destino.ejemplo.com'), 'destino.ejemplo.com.');
  assert.strictEqual(d.buildRecordContent('MX', 'mail.ejemplo.com', 10), '10 mail.ejemplo.com.');
  assert.strictEqual(d.buildRecordContent('TXT', 'v=spf1 mx ~all'), '"v=spf1 mx ~all"');
  assert.strictEqual(d.buildRecordContent('TXT', '"ya-con-comillas"'), '"ya-con-comillas"');
});

test('buildZonePayload', () => {
  const p = d.buildZonePayload({ domain: 'ejemplo.com', ns1: 'ns1.mio.com', ns2: 'ns2.mio.com' });
  assert.strictEqual(p.name, 'ejemplo.com.');
  assert.strictEqual(p.kind, 'Native');
  assert.deepStrictEqual(p.nameservers, ['ns1.mio.com.', 'ns2.mio.com.']);
});

test('buildRrsetPatch REPLACE y DELETE', () => {
  const rep = d.buildRrsetPatch({ name: 'www.ejemplo.com', type: 'A', contents: ['1.2.3.4'], ttl: 3600, changetype: 'REPLACE' });
  assert.deepStrictEqual(rep, { rrsets: [{ name: 'www.ejemplo.com.', type: 'A', ttl: 3600, changetype: 'REPLACE', records: [{ content: '1.2.3.4', disabled: false }] }] });
  const del = d.buildRrsetPatch({ name: 'www.ejemplo.com', type: 'A', contents: [], ttl: 3600, changetype: 'DELETE' });
  assert.strictEqual(del.rrsets[0].changetype, 'DELETE');
  assert.deepStrictEqual(del.rrsets[0].records, []);
});

test('buildGlueRecords', () => {
  const g = d.buildGlueRecords({ ns1: 'ns1.mio.com', ns2: 'ns2.mio.com', serverIp: '1.2.3.4' });
  assert.deepStrictEqual(g, [
    { type: 'A', name: 'ns1.mio.com', value: '1.2.3.4' },
    { type: 'A', name: 'ns2.mio.com', value: '1.2.3.4' },
  ]);
});

test('parseZones', () => {
  const out = d.parseZones([{ id: 'ejemplo.com.', name: 'ejemplo.com.', kind: 'Native' }, { name: 'otro.io.' }]);
  assert.deepStrictEqual(out, [{ name: 'ejemplo.com' }, { name: 'otro.io' }]);
});

test('parseRecords aplana rrsets', () => {
  const zoneJson = { rrsets: [
    { name: 'ejemplo.com.', type: 'A', ttl: 3600, records: [{ content: '1.2.3.4', disabled: false }] },
    { name: 'ejemplo.com.', type: 'MX', ttl: 3600, records: [{ content: '10 mail.ejemplo.com.', disabled: false }] },
  ] };
  const out = d.parseRecords(zoneJson);
  assert.deepStrictEqual(out, [
    { name: 'ejemplo.com', type: 'A', ttl: 3600, content: '1.2.3.4' },
    { name: 'ejemplo.com', type: 'MX', ttl: 3600, content: '10 mail.ejemplo.com.' },
  ]);
});
```

- [ ] **Step 2: Ejecutar los tests para verificar que fallan**

Run: `node --test backend/test/dns.test.js`
Expected: FAIL con "d.buildRecordContent is not a function".

- [ ] **Step 3: Añadir las funciones a `backend/lib/dns.js`** (antes de `module.exports`)

```javascript
// Contenido del registro tal como lo espera PowerDNS.
function buildRecordContent(type, value, priority) {
  if (type === 'CNAME') return canonical(value);
  if (type === 'MX') return `${priority} ${canonical(value)}`;
  if (type === 'TXT') {
    const v = String(value);
    return v.startsWith('"') && v.endsWith('"') ? v : `"${v}"`;
  }
  return String(value); // A, AAAA
}

// Cuerpo para crear una zona en la API de PowerDNS. PowerDNS crea el SOA y los
// registros NS automáticamente a partir de `nameservers`.
function buildZonePayload({ domain, ns1, ns2 }) {
  return {
    name: canonical(domain),
    kind: 'Native',
    nameservers: [canonical(ns1), canonical(ns2)],
  };
}

// Cuerpo PATCH para crear/reemplazar (REPLACE) o borrar (DELETE) un rrset.
function buildRrsetPatch({ name, type, contents, ttl, changetype }) {
  return {
    rrsets: [{
      name: canonical(name),
      type,
      ttl,
      changetype,
      records: (contents || []).map((c) => ({ content: c, disabled: false })),
    }],
  };
}

// Registros que el operador debe crear en su REGISTRADOR (glue): ns1/ns2 -> IP.
function buildGlueRecords({ ns1, ns2, serverIp }) {
  return [
    { type: 'A', name: ns1, value: serverIp },
    { type: 'A', name: ns2, value: serverIp },
  ];
}

const stripDot = (s) => String(s || '').replace(/\.$/, '');

function parseZones(json) {
  return (Array.isArray(json) ? json : []).map((z) => ({ name: stripDot(z.name) }));
}

function parseRecords(zoneJson) {
  const out = [];
  for (const rr of (zoneJson && zoneJson.rrsets) || []) {
    for (const rec of rr.records || []) {
      out.push({ name: stripDot(rr.name), type: rr.type, ttl: rr.ttl, content: rec.content });
    }
  }
  return out;
}
```

Y añade estos nombres al `module.exports`:

```javascript
  buildRecordContent, buildZonePayload, buildRrsetPatch, buildGlueRecords,
  parseZones, parseRecords,
```

- [ ] **Step 4: Ejecutar los tests para verificar que pasan**

Run: `node --test backend/test/dns.test.js`
Expected: PASS (11 tests en total).

- [ ] **Step 5: Commit**

```bash
git add backend/lib/dns.js backend/test/dns.test.js
git commit -m "feat(dns): payloads de zona/rrset, contenido de registro, glue y parsers + tests"
```

---

## Task 3: Esquema SQLite y queries

**Files:**
- Modify: `backend/database.js` (tabla `dns_config` + queries)

**Interfaces:**
- Consumes: nada.
- Produces (en `queries`):
  - `getDnsConfig` → `SELECT * FROM dns_config WHERE id = 1`
  - `saveDnsConfig` → upsert `ON CONFLICT(id)` sobre `dns_config`

- [ ] **Step 1: Añadir la tabla al bloque `CREATE TABLE` de `database.js`** (tras `mail_config`)

```sql
  CREATE TABLE IF NOT EXISTS dns_config (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    api_key_enc TEXT,
    ns1         TEXT,
    ns2         TEXT,
    server_ip   TEXT,
    status      TEXT DEFAULT 'not_installed',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
```

- [ ] **Step 2: Añadir las queries al objeto `queries`** (junto a las de mail)

```javascript
  // ── DNS (PowerDNS) ───────────────────────────────────────
  getDnsConfig: db.prepare('SELECT * FROM dns_config WHERE id = 1'),
  saveDnsConfig: db.prepare(`
    INSERT INTO dns_config (id, api_key_enc, ns1, ns2, server_ip, status, created_at)
    VALUES (1, @api_key_enc, @ns1, @ns2, @server_ip, @status, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      api_key_enc = @api_key_enc, ns1 = @ns1, ns2 = @ns2,
      server_ip = @server_ip, status = @status`),
```

- [ ] **Step 3: Verificar que el esquema carga y las queries existen**

Run: `TXPL_DIR=./ JWT_SECRET=$(printf 'x%.0s' {1..40}) node -e "const {queries}=require('./backend/database'); ['getDnsConfig','saveDnsConfig'].forEach(k=>{if(!queries[k])throw new Error('falta '+k)}); console.log('OK queries dns')"; rm -rf data`
Expected: imprime `OK queries dns`.

- [ ] **Step 4: Commit**

```bash
git add backend/database.js
git commit -m "feat(dns): tabla dns_config + queries"
```

---

## Task 4: Router `/api/dns` — API client + ciclo de vida (status/install/config) + montaje

**Files:**
- Create: `backend/routes/dns.js`
- Modify: `backend/server.js` (montar tras `/api/mail`)

**Interfaces:**
- Consumes: helpers de Tasks 1-2 (`D.*`); `queries`, `audit` (Task 3); `ok`/`fail`/`clientIp`/`runSafe`/`wrap` (`helpers.js`); `encryptSecret`/`decryptSecret` (`lib/crypto.js`).
- Produces (endpoints bajo `/api/dns`, JWT ya aplicado; y helpers en ámbito de módulo para Task 5: `pdnsApi`, `getConnectedConfig`):
  - `GET /status` → `{ installed, state, ns1, ns2, server_ip }`
  - `POST /install` (streaming) → apt + api-key + esquema + config + UFW + arranque.
  - `POST /config` → guarda ns1/ns2/server_ip (+ reescribe local-address si cambia la IP).

- [ ] **Step 1: Implementar `backend/routes/dns.js`**

```javascript
'use strict';

// ============================================================
//  TecXPaneL — DNS (PowerDNS autoritativo)
//  Instala PowerDNS nativo (apt) con backend SQLite y API HTTP.
//  El panel gestiona zonas/registros por la API por loopback; la
//  api-key se guarda cifrada. PowerDNS bindea a la IP pública.
// ============================================================

const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const express = require('express');
const { ok, fail, clientIp, runSafe, wrap } = require('../lib/helpers');
const { queries, audit } = require('../database');
const { encryptSecret, decryptSecret } = require('../lib/crypto');
const D = require('../lib/dns');

const router = express.Router();
const PDNS_CONF = '/etc/powerdns/pdns.d/txpl.conf';
const PDNS_DB = '/var/lib/powerdns/pdns.sqlite3';
const PDNS_API = { host: '127.0.0.1', port: 8081 };

// Cliente HTTP a la API de PowerDNS por loopback. path relativo a
// /api/v1/servers/localhost. Devuelve { statusCode, json }.
function pdnsApi(method, path, apiKey, body = null) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      host: PDNS_API.host, port: PDNS_API.port, method,
      path: '/api/v1/servers/localhost' + path,
      headers: { 'X-API-Key': apiKey, 'Accept': 'application/json' },
    };
    if (data) options.headers['Content-Type'] = 'application/json';
    const rq = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString();
        let json = null; try { json = txt ? JSON.parse(txt) : null; } catch (_) { json = txt; }
        resolve({ statusCode: res.statusCode, json });
      });
    });
    rq.on('error', reject);
    if (data) rq.write(data);
    rq.end();
  });
}

// Config conectada con la api-key descifrada, o lanza si no está lista.
function getConnectedConfig() {
  const cfg = queries.getDnsConfig.get();
  if (!cfg || !cfg.api_key_enc) { const e = new Error('DNS no está instalado.'); e.http = 400; throw e; }
  return { apiKey: decryptSecret(cfg.api_key_enc), ns1: cfg.ns1, ns2: cfg.ns2, server_ip: cfg.server_ip, cfg };
}

// Ejecuta un comando transmitiendo su salida al cliente; resuelve con el código.
function streamRun(cmd, args, write) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, { env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } }); }
    catch (e) { write('[error] ' + e.message + '\n'); return resolve(1); }
    child.stdout.on('data', (d) => write(d));
    child.stderr.on('data', (d) => write(d));
    child.on('error', (e) => { write('[error] ' + e.message + '\n'); resolve(1); });
    child.on('close', (code) => resolve(code === null ? 1 : code));
  });
}

// Contenido de la config de PowerDNS. serverIp: IP pública a la que bindear.
function pdnsConfContent(apiKey, serverIp) {
  return [
    'launch=gsqlite3',
    `gsqlite3-database=${PDNS_DB}`,
    'api=yes',
    `api-key=${apiKey}`,
    'webserver=yes',
    'webserver-address=127.0.0.1',
    'webserver-port=8081',
    'webserver-allow-from=127.0.0.1',
    `local-address=${serverIp}`,
    '',
  ].join('\n');
}

function startStream(res) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
}

// Detecta la IP pública del servidor (para local-address y glue).
async function detectServerIp() {
  const r = await runSafe('bash', ['-c', "curl -s https://api.ipify.org || hostname -I | awk '{print $1}'"]);
  return (r.stdout || '').trim();
}

function computeState(cfg, installed) {
  if (!installed) return 'not_installed';
  if (!cfg || !cfg.ns1 || !cfg.ns2) return 'needs_config';
  return 'ready';
}

// ¿Está PowerDNS instalado? (dpkg del paquete).
async function pdnsInstalled() {
  const r = await runSafe('dpkg', ['-s', 'pdns-server']);
  return r.ok;
}

// ── Estado ───────────────────────────────────────────────────
router.get('/status', wrap(async (req, res) => {
  const installed = await pdnsInstalled();
  const cfg = queries.getDnsConfig.get();
  ok(res, {
    installed,
    state: computeState(cfg, installed),
    ns1: (cfg && cfg.ns1) || null,
    ns2: (cfg && cfg.ns2) || null,
    server_ip: (cfg && cfg.server_ip) || null,
  });
}));

// ── Instalar (streaming) ─────────────────────────────────────
router.post('/install', wrap(async (req, res) => {
  if (await pdnsInstalled()) return fail(res, 409, 'PowerDNS ya está instalado.');
  audit(req.user?.username || 'system', clientIp(req), 'dns.install', 'powerdns');
  startStream(res);
  const done = (code) => res.end(`\n__TXPL_DONE__${code}`);
  try {
    const apiKey = crypto.randomBytes(32).toString('hex');
    res.write('🌐 Detectando la IP pública del servidor...\n');
    const serverIp = await detectServerIp();
    if (!D.isValidIpv4(serverIp)) { res.write('[error] No se pudo detectar una IPv4 pública.\n'); return done(1); }
    res.write(`   IP: ${serverIp}\n`);

    res.write('📥 Instalando PowerDNS (apt)...\n');
    const aptCode = await streamRun('apt-get', ['install', '-y', 'pdns-server', 'pdns-backend-sqlite3'], (t) => res.write(t));
    if (aptCode !== 0) { res.write('[error] Falló la instalación por apt.\n'); return done(1); }

    res.write('🗄️  Inicializando la base de datos de zonas...\n');
    // Script FIJO (sin datos de usuario): crea el dir, localiza el esquema del
    // paquete e inicializa la DB SQLite si está vacía.
    const initScript = [
      'set -e',
      'mkdir -p /var/lib/powerdns',
      `if [ ! -s ${PDNS_DB} ]; then`,
      "  SCHEMA=$(find /usr/share -name 'schema.sqlite3.sql' 2>/dev/null | head -1)",
      `  [ -n "$SCHEMA" ] && sqlite3 ${PDNS_DB} < "$SCHEMA"`,
      'fi',
      `chown -R pdns:pdns /var/lib/powerdns || true`,
    ].join('\n');
    const initR = await runSafe('bash', ['-c', initScript]);
    if (!initR.ok || !fs.existsSync(PDNS_DB)) { res.write('[error] No se pudo inicializar el esquema: ' + (initR.stderr || '').slice(0, 200) + '\n'); return done(1); }

    res.write('⚙️  Escribiendo la configuración...\n');
    fs.mkdirSync('/etc/powerdns/pdns.d', { recursive: true });
    fs.writeFileSync(PDNS_CONF, pdnsConfContent(apiKey, serverIp));

    res.write('🔥 Abriendo el puerto 53 en el firewall...\n');
    await runSafe('ufw', ['allow', '53/tcp']);
    await runSafe('ufw', ['allow', '53/udp']);

    res.write('▶️  Arrancando PowerDNS...\n');
    const restart = await runSafe('systemctl', ['restart', 'pdns']);
    if (!restart.ok) { res.write('[error] No arrancó el servicio: ' + (restart.stderr || '').slice(0, 200) + '\n'); return done(1); }
    await runSafe('systemctl', ['enable', 'pdns']);

    queries.saveDnsConfig.run({ api_key_enc: encryptSecret(apiKey), ns1: null, ns2: null, server_ip: serverIp, status: 'needs_config' });
    res.write('✅ PowerDNS instalado. Configura tus nameservers (ns1/ns2).\n');
    done(0);
  } catch (e) {
    res.write('[error] ' + e.message + '\n');
    done(1);
  }
}));

// ── Configurar nameservers ───────────────────────────────────
router.post('/config', wrap(async (req, res) => {
  const ns1 = String((req.body && req.body.ns1) || '').trim().toLowerCase();
  const ns2 = String((req.body && req.body.ns2) || '').trim().toLowerCase();
  const serverIp = String((req.body && req.body.server_ip) || '').trim();
  if (!D.isValidDnsDomain(ns1) || !D.isValidDnsDomain(ns2)) return fail(res, 400, 'Nameservers inválidos (ej. ns1.tudominio.com).');
  if (!D.isValidIpv4(serverIp)) return fail(res, 400, 'IP del servidor inválida.');
  const prev = queries.getDnsConfig.get();
  if (!prev || !prev.api_key_enc) return fail(res, 400, 'Instala PowerDNS primero.');

  // Si cambia la IP, reescribir local-address y reiniciar.
  if (prev.server_ip !== serverIp) {
    fs.writeFileSync(PDNS_CONF, pdnsConfContent(decryptSecret(prev.api_key_enc), serverIp));
    await runSafe('systemctl', ['restart', 'pdns']);
  }
  queries.saveDnsConfig.run({ api_key_enc: prev.api_key_enc, ns1, ns2, server_ip: serverIp, status: 'ready' });
  audit(req.user?.username || 'system', clientIp(req), 'dns.config', `${ns1}, ${ns2}`);
  ok(res, { ns1, ns2, server_ip: serverIp });
}));

module.exports = router;
```

> **Nota:** `pdnsApi`, `getConnectedConfig` y `D` quedan en el ámbito del módulo;
> la Task 5 añade endpoints en este mismo archivo y los usa directamente.

- [ ] **Step 2: Montar el router en `backend/server.js`** (tras la línea de `/api/mail`)

```javascript
app.use('/api/dns', require('./routes/dns'));
```

- [ ] **Step 3: Verificar que el router carga sin errores**

Run: `TXPL_DIR=./ JWT_SECRET=$(printf 'x%.0s' {1..40}) node -e "require('./backend/routes/dns'); console.log('router dns OK')"; rm -rf data`
Expected: imprime `router dns OK`.

- [ ] **Step 4: Ejecutar la batería de tests**

Run: `node --test "backend/test/**/*.test.js"`
Expected: PASS (incluye los 11 de dns.test.js).

- [ ] **Step 5: Commit**

```bash
git add backend/routes/dns.js backend/server.js
git commit -m "feat(dns): router /api/dns — API client + instalación + config de nameservers"
```

---

## Task 5: Router `/api/dns` — zonas, registros y delegación

**Files:**
- Modify: `backend/routes/dns.js` (añadir endpoints antes de `module.exports`)

**Interfaces:**
- Consumes: `pdnsApi`, `getConnectedConfig`, `D` (Task 4/1/2); `queries`, `audit`; `ok`/`fail`/`clientIp`/`runSafe`/`wrap`.
- Produces (endpoints bajo `/api/dns`):
  - `GET /zones` → `{ zones: [{name}] }`
  - `POST /zones` (body `{ domain }`)
  - `DELETE /zones/:zone`
  - `GET /zones/:zone/records` → `{ records: [{name,type,ttl,content}] }`
  - `POST /zones/:zone/records` (body `{ name, type, value, ttl, priority }`)
  - `DELETE /zones/:zone/records` (body `{ name, type }`)
  - `GET /zones/:zone/delegation` → `{ glue: [...], delegated: bool, ns_found: [...] }`

- [ ] **Step 1: Añadir estos endpoints a `backend/routes/dns.js`** (justo antes de `module.exports = router;`)

```javascript
// Valida que :zone sea un dominio y devuelve su forma canónica para la API.
function zoneId(param) {
  const z = String(param || '').trim().toLowerCase().replace(/\.$/, '');
  if (!D.isValidDnsDomain(z)) { const e = new Error('Zona inválida.'); e.http = 400; throw e; }
  return { z, id: encodeURIComponent(D.canonical(z)) };
}

// ── Zonas ────────────────────────────────────────────────────
router.get('/zones', wrap(async (req, res) => {
  const { apiKey } = getConnectedConfig();
  const r = await pdnsApi('GET', '/zones', apiKey);
  if (r.statusCode >= 400) return fail(res, 502, 'PowerDNS: ' + JSON.stringify(r.json));
  ok(res, { zones: D.parseZones(r.json) });
}));

router.post('/zones', wrap(async (req, res) => {
  const { apiKey, ns1, ns2 } = getConnectedConfig();
  if (!ns1 || !ns2) return fail(res, 400, 'Configura los nameservers primero.');
  const domain = String((req.body && req.body.domain) || '').trim().toLowerCase();
  if (!D.isValidDnsDomain(domain)) return fail(res, 400, 'Dominio inválido.');
  const r = await pdnsApi('POST', '/zones', apiKey, D.buildZonePayload({ domain, ns1, ns2 }));
  if (r.statusCode >= 400) return fail(res, 502, 'PowerDNS: ' + JSON.stringify(r.json));
  audit(req.user?.username || 'system', clientIp(req), 'dns.zone.add', domain);
  ok(res);
}));

router.delete('/zones/:zone', wrap(async (req, res) => {
  const { apiKey } = getConnectedConfig();
  const { z, id } = zoneId(req.params.zone);
  const r = await pdnsApi('DELETE', `/zones/${id}`, apiKey);
  if (r.statusCode >= 400) return fail(res, 502, 'PowerDNS: ' + JSON.stringify(r.json));
  audit(req.user?.username || 'system', clientIp(req), 'dns.zone.del', z);
  ok(res);
}));

// ── Registros ────────────────────────────────────────────────
router.get('/zones/:zone/records', wrap(async (req, res) => {
  const { apiKey } = getConnectedConfig();
  const { id } = zoneId(req.params.zone);
  const r = await pdnsApi('GET', `/zones/${id}`, apiKey);
  if (r.statusCode >= 400) return fail(res, 502, 'PowerDNS: ' + JSON.stringify(r.json));
  ok(res, { records: D.parseRecords(r.json) });
}));

router.post('/zones/:zone/records', wrap(async (req, res) => {
  const { apiKey } = getConnectedConfig();
  const { z, id } = zoneId(req.params.zone);
  const { name, type, value, ttl = 3600, priority = 10 } = req.body || {};
  if (!D.SUPPORTED_TYPES.includes(type)) return fail(res, 400, 'Tipo de registro no soportado.');
  if (!D.isValidDnsDomain(String(name || '').replace(/\.$/, ''))) return fail(res, 400, 'Nombre de registro inválido.');
  if (!D.isValidRecord(type, value)) return fail(res, 400, 'Valor de registro inválido para el tipo ' + type + '.');
  if (type === 'MX' && !D.isValidPriority(+priority)) return fail(res, 400, 'Prioridad MX inválida (0-65535).');
  const content = D.buildRecordContent(type, value, +priority);
  const patch = D.buildRrsetPatch({ name, type, contents: [content], ttl: +ttl || 3600, changetype: 'REPLACE' });
  const r = await pdnsApi('PATCH', `/zones/${id}`, apiKey, patch);
  if (r.statusCode >= 400) return fail(res, 502, 'PowerDNS: ' + JSON.stringify(r.json));
  audit(req.user?.username || 'system', clientIp(req), 'dns.record.add', `${z}: ${type} ${name}`);
  ok(res);
}));

router.delete('/zones/:zone/records', wrap(async (req, res) => {
  const { apiKey } = getConnectedConfig();
  const { z, id } = zoneId(req.params.zone);
  const { name, type } = req.body || {};
  if (!D.SUPPORTED_TYPES.includes(type)) return fail(res, 400, 'Tipo de registro no soportado.');
  const patch = D.buildRrsetPatch({ name, type, contents: [], ttl: 3600, changetype: 'DELETE' });
  const r = await pdnsApi('PATCH', `/zones/${id}`, apiKey, patch);
  if (r.statusCode >= 400) return fail(res, 502, 'PowerDNS: ' + JSON.stringify(r.json));
  audit(req.user?.username || 'system', clientIp(req), 'dns.record.del', `${z}: ${type} ${name}`);
  ok(res);
}));

// ── Delegación (glue + verificación por DNS público) ─────────
router.get('/zones/:zone/delegation', wrap(async (req, res) => {
  const { ns1, ns2, server_ip } = getConnectedConfig();
  const { z } = zoneId(req.params.zone);
  const glue = D.buildGlueRecords({ ns1, ns2, serverIp: server_ip });
  // Consulta el DNS público para ver a qué NS está delegado el dominio.
  const dig = await runSafe('dig', ['+short', 'NS', z]);
  const nsFound = (dig.stdout || '').split('\n').map((s) => s.trim().replace(/\.$/, '')).filter(Boolean);
  const delegated = nsFound.includes(ns1) && nsFound.includes(ns2);
  ok(res, { glue, delegated, ns_found: nsFound });
}));
```

- [ ] **Step 2: Verificar que el router sigue cargando**

Run: `TXPL_DIR=./ JWT_SECRET=$(printf 'x%.0s' {1..40}) node -e "require('./backend/routes/dns'); console.log('router dns OK')"; rm -rf data`
Expected: imprime `router dns OK`.

- [ ] **Step 3: Ejecutar la batería de tests**

Run: `node --test "backend/test/**/*.test.js"`
Expected: PASS (sin cambios respecto a Task 4; estos endpoints se verifican en VPS).

- [ ] **Step 4: Commit**

```bash
git add backend/routes/dns.js
git commit -m "feat(dns): endpoints de zonas, registros y delegación"
```

---

## Task 6: Frontend — sección "DNS"

**Files:**
- Modify: `frontend/views/sidebar.html` (item de navegación)
- Create: `frontend/views/pages/dns.html`
- Modify: `frontend/index.html` (contenedor de página)
- Modify: `frontend/js/app.js` (`pages`, `navigate`, `titles`, `loadDns` y acciones)

**Interfaces:**
- Consumes: endpoints de Tasks 4-5; helpers `req()`, `esc()`, `API`, `TOKEN`, `doLogout()`.
- Produces: `dnsStream`, `loadDns`, `dnsInstall`, `dnsSaveConfig`, `loadDnsZones`, `dnsAddZone`, `dnsDeleteZone`, `dnsOpenZone`, `loadDnsRecords`, `dnsAddRecord`, `dnsDeleteRecord`, `dnsDelegation`.

- [ ] **Step 1: Añadir el item al sidebar** (`frontend/views/sidebar.html`, tras el de "Correo")

```html
<div class="nav-item" data-page="dns" onclick="navigate(this)"><i class="ti ti-world"></i> DNS</div>
```

- [ ] **Step 2: Añadir el contenedor de página** (`frontend/index.html`, junto a los demás `page-*`)

```html
<div class="page" id="page-dns"></div>
```

- [ ] **Step 3: Crear la plantilla** `frontend/views/pages/dns.html`

```html
<div class="page-header">
  <h1><i class="ti ti-world"></i> DNS</h1>
</div>
<div id="dns-body">Cargando…</div>
<div class="console" id="dns-console" style="display:none"></div>
```

- [ ] **Step 4: Registrar la página en `loadTemplates`, `navigate` y `titles`** (`frontend/js/app.js`)

En el array `pages` de `loadTemplates()` añade `'dns'`. En `navigate()` añade `if (page === 'dns') loadDns();`. En el objeto `titles` añade `dns: 'DNS'`.

- [ ] **Step 5: Implementar las funciones** (`frontend/js/app.js`, junto a las de otras secciones)

```javascript
// Streaming reutilizable (mismo patrón que mailStream).
async function dnsStream(path, body, el) {
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

async function loadDns() {
  const st = await req('GET', '/dns/status');
  if (!st) return;
  const body = document.getElementById('dns-body');
  if (st.state === 'not_installed') {
    body.innerHTML = `<div class="card">
      <h3>Instalar DNS (PowerDNS)</h3>
      <p class="muted">Convierte este VPS en servidor DNS autoritativo. Abrirá el puerto 53 (TCP/UDP).</p>
      <button class="btn btn-primary" onclick="dnsInstall()"><i class="ti ti-download"></i> Instalar PowerDNS</button>
    </div>`;
    return;
  }
  if (st.state === 'needs_config') {
    body.innerHTML = `<div class="card">
      <h3>Configurar nameservers</h3>
      <p class="muted">Define dos nameservers (ambos apuntando a este servidor) y confirma la IP.</p>
      <div class="form-row"><input type="text" id="dns-ns1" placeholder="ns1.tudominio.com" style="width:240px"></div>
      <div class="form-row"><input type="text" id="dns-ns2" placeholder="ns2.tudominio.com" style="width:240px"></div>
      <div class="form-row"><input type="text" id="dns-ip" placeholder="IP del servidor" value="${esc(st.server_ip || '')}" style="width:180px"></div>
      <button class="btn btn-primary" onclick="dnsSaveConfig()"><i class="ti ti-device-floppy"></i> Guardar</button>
    </div>`;
    return;
  }
  // ready
  body.innerHTML = `
    <div class="card">
      <h3><i class="ti ti-server"></i> Nameservers</h3>
      <p><b>${esc(st.ns1)}</b> y <b>${esc(st.ns2)}</b> → <code>${esc(st.server_ip)}</code></p>
    </div>
    <div class="card">
      <h3><i class="ti ti-list"></i> Zonas (dominios)</h3>
      <div class="form-row">
        <input type="text" id="dns-zone-name" placeholder="tudominio.com" style="width:240px">
        <button class="btn btn-primary" onclick="dnsAddZone()">Añadir dominio</button>
      </div>
      <div id="dns-zones">Cargando…</div>
    </div>
    <div class="card" id="dns-zone-detail" style="display:none">
      <h3><i class="ti ti-list-details"></i> Registros de <span id="dns-current-zone"></span></h3>
      <div class="form-row">
        <input type="text" id="dns-rec-name" placeholder="nombre (ej. www.tudominio.com)" style="width:220px">
        <select id="dns-rec-type" onchange="dnsRecTypeChange()">
          <option>A</option><option>AAAA</option><option>CNAME</option><option>MX</option><option>TXT</option>
        </select>
        <input type="text" id="dns-rec-value" placeholder="valor" style="width:200px">
        <input type="number" id="dns-rec-prio" placeholder="prioridad" value="10" style="width:90px;display:none">
        <input type="number" id="dns-rec-ttl" placeholder="TTL" value="3600" style="width:80px">
        <button class="btn btn-primary" onclick="dnsAddRecord()">Añadir</button>
      </div>
      <div id="dns-records">Cargando…</div>
      <h4 style="margin-top:16px"><i class="ti ti-arrow-guide"></i> Delegación</h4>
      <div id="dns-delegation"></div>
    </div>`;
  loadDnsZones();
}

async function dnsInstall() {
  const con = document.getElementById('dns-console');
  con.style.display = 'block'; con.textContent = '';
  await dnsStream('/dns/install', {}, con);
  loadDns();
}

async function dnsSaveConfig() {
  const body = {
    ns1: document.getElementById('dns-ns1').value.trim(),
    ns2: document.getElementById('dns-ns2').value.trim(),
    server_ip: document.getElementById('dns-ip').value.trim(),
  };
  const r = await req('POST', '/dns/config', body);
  if (r && r.error) { alert(r.error); return; }
  loadDns();
}

async function loadDnsZones() {
  const r = await req('GET', '/dns/zones');
  const el = document.getElementById('dns-zones'); if (!el) return;
  if (!r || r.error) { el.innerHTML = `<p class="muted">${esc((r && r.error) || 'No se pudieron cargar')}</p>`; return; }
  if (!r.zones.length) { el.innerHTML = '<p class="muted">Aún no hay dominios.</p>'; return; }
  el.innerHTML = '<table class="table"><tbody>' + r.zones.map((z) => `<tr>
    <td>${esc(z.name)}</td>
    <td style="text-align:right">
      <button class="btn btn-sm" onclick="dnsOpenZone('${esc(z.name)}')"><i class="ti ti-edit"></i> Registros</button>
      <button class="btn btn-sm btn-danger" onclick="dnsDeleteZone('${esc(z.name)}')"><i class="ti ti-trash"></i></button>
    </td></tr>`).join('') + '</tbody></table>';
}

async function dnsAddZone() {
  const domain = document.getElementById('dns-zone-name').value.trim();
  const r = await req('POST', '/dns/zones', { domain });
  if (r && r.error) { alert(r.error); return; }
  document.getElementById('dns-zone-name').value = '';
  loadDnsZones();
}

async function dnsDeleteZone(zone) {
  if (!confirm(`¿Borrar el dominio ${zone} y todos sus registros?`)) return;
  await req('DELETE', `/dns/zones/${encodeURIComponent(zone)}`);
  document.getElementById('dns-zone-detail').style.display = 'none';
  loadDnsZones();
}

let _dnsZone = null;
function dnsOpenZone(zone) {
  _dnsZone = zone;
  document.getElementById('dns-zone-detail').style.display = 'block';
  document.getElementById('dns-current-zone').textContent = zone;
  document.getElementById('dns-rec-name').value = zone;
  loadDnsRecords(); dnsDelegation();
}

function dnsRecTypeChange() {
  const t = document.getElementById('dns-rec-type').value;
  document.getElementById('dns-rec-prio').style.display = (t === 'MX') ? '' : 'none';
}

async function loadDnsRecords() {
  const r = await req('GET', `/dns/zones/${encodeURIComponent(_dnsZone)}/records`);
  const el = document.getElementById('dns-records'); if (!el) return;
  if (!r || r.error) { el.innerHTML = `<p class="muted">${esc((r && r.error) || 'No se pudieron cargar')}</p>`; return; }
  el.innerHTML = '<table class="table"><thead><tr><th>Nombre</th><th>Tipo</th><th>TTL</th><th>Valor</th><th></th></tr></thead><tbody>' +
    r.records.map((rec) => `<tr>
      <td><code>${esc(rec.name)}</code></td>
      <td>${esc(rec.type)}</td>
      <td>${esc(String(rec.ttl))}</td>
      <td><code>${esc(rec.content)}</code></td>
      <td style="text-align:right">${rec.type === 'SOA' || rec.type === 'NS' ? '' : `<button class="btn btn-sm btn-danger" onclick="dnsDeleteRecord('${esc(rec.name)}','${esc(rec.type)}')"><i class="ti ti-trash"></i></button>`}</td>
    </tr>`).join('') + '</tbody></table>';
}

async function dnsAddRecord() {
  const body = {
    name: document.getElementById('dns-rec-name').value.trim(),
    type: document.getElementById('dns-rec-type').value,
    value: document.getElementById('dns-rec-value').value.trim(),
    ttl: +document.getElementById('dns-rec-ttl').value || 3600,
    priority: +document.getElementById('dns-rec-prio').value || 10,
  };
  const r = await req('POST', `/dns/zones/${encodeURIComponent(_dnsZone)}/records`, body);
  if (r && r.error) { alert(r.error); return; }
  document.getElementById('dns-rec-value').value = '';
  loadDnsRecords();
}

async function dnsDeleteRecord(name, type) {
  if (!confirm(`¿Borrar el registro ${type} ${name}?`)) return;
  await req('DELETE', `/dns/zones/${encodeURIComponent(_dnsZone)}/records`, { name, type });
  loadDnsRecords();
}

async function dnsDelegation() {
  const r = await req('GET', `/dns/zones/${encodeURIComponent(_dnsZone)}/delegation`);
  const el = document.getElementById('dns-delegation'); if (!el) return;
  if (!r || r.error) { el.innerHTML = `<p class="muted">${esc((r && r.error) || 'No disponible')}</p>`; return; }
  const estado = r.delegated
    ? '<span style="color:#16a34a">✅ Delegación activa</span>'
    : '<span style="color:#d97706">⚠️ Pendiente: cambia los NS del dominio en tu registrador</span>';
  el.innerHTML = `<p>${estado}</p>
    <p class="muted">Crea estos <b>glue records</b> en tu registrador y apunta los NS del dominio a ellos:</p>
    <table class="table"><tbody>` +
    r.glue.map((g) => `<tr><td>${esc(g.type)}</td><td><code>${esc(g.name)}</code></td><td><code>${esc(g.value)}</code></td></tr>`).join('') +
    `</tbody></table>` +
    (r.ns_found && r.ns_found.length ? `<p class="muted">NS detectados ahora: ${esc(r.ns_found.join(', '))}</p>` : '');
}
```

- [ ] **Step 6: Verificar que `app.js` sigue parseando**

Run: `node --check frontend/js/app.js && echo "app.js OK"`
Expected: `app.js OK`.

- [ ] **Step 7: Commit**

```bash
git add frontend/views/sidebar.html frontend/views/pages/dns.html frontend/index.html frontend/js/app.js
git commit -m "feat(dns): sección DNS en el frontend (instalar, nameservers, zonas, registros, delegación)"
```

---

## Task 7: Documentación (README + CLAUDE.md)

**Files:**
- Modify: `README.md` (bullet de característica + sección dedicada)
- Modify: `CLAUDE.md` (router `dns.js` + `lib/dns.js`)

- [ ] **Step 1: Añadir el bullet de característica en README** (en "🚀 Características Principales", tras el de Correo)

```markdown
- 🌐 **DNS Autoritativo**: Convierte el VPS en servidor DNS con **PowerDNS**. Configura tus nameservers (ns1/ns2), crea **zonas** (dominios) y gestiona **registros** (A, AAAA, CNAME, MX, TXT) desde el panel. Incluye los **glue records** a poner en tu registrador y una **verificación de delegación**.
```

- [ ] **Step 2: Añadir la sección dedicada en README** (tras la sección "## 📧 Correo Electrónico")

```markdown
---

## 🌐 DNS Autoritativo (PowerDNS)

TecXPaneL puede convertir tu VPS en un **servidor DNS autoritativo** con PowerDNS
—como hace Hostinger/Plesk— para gestionar el DNS de tus dominios desde el panel.

> [!NOTE]
> PowerDNS se instala de forma nativa (apt), corre como servicio y escucha en el
> puerto 53. El panel lo gestiona por su API HTTP local con una clave cifrada.

**Flujo de uso:**

1.  En **DNS** pulsa **Instalar PowerDNS**: se instala, se abre el puerto 53 y
    arranca el servicio.
2.  Configura tus **nameservers** `ns1.tudominio.com` y `ns2.tudominio.com` (ambos
    apuntando a la IP de este VPS).
3.  Añade tus **dominios** (zonas) y gestiona sus **registros** (A/AAAA/CNAME/MX/TXT).
4.  En tu **registrador**, crea los **glue records** que el panel te muestra y
    cambia los **NS** del dominio a los tuyos. El panel **verifica** si la
    delegación ya está activa.

> [!WARNING]
> Crear los glue records y cambiar los nameservers en el **registrador** del
> dominio siempre lo haces tú (es externo al VPS). Hasta que la delegación esté
> propagada, el DNS del panel no responderá para ese dominio en Internet.
```

- [ ] **Step 3: Actualizar CLAUDE.md** (listas de `backend/routes/` y `backend/lib/`)

Añade a la lista de routers:

```markdown
  - `dns.js` — DNS autoritativo (PowerDNS). Instala PowerDNS nativo (apt) con backend SQLite y API HTTP (install streaming: apt + api-key cifrada + esquema + config con `local-address` a la IP pública + UFW 53). Gestiona nameservers (`dns_config`), y zonas/registros (A/AAAA/CNAME/MX/TXT) por la API de PowerDNS por loopback (`X-API-Key`). Incluye glue records y verificación de delegación (`dig NS`). Helpers puros en `lib/dns.js`.
```

Añade a la lista de `lib/`:

```markdown
- `backend/lib/dns.js` — Helpers puros de DNS (validadores de dominio/IP/registro por tipo, `canonical` FQDN, construcción de payloads de zona y de rrset para la API de PowerDNS, contenido de registro por tipo, glue records y parseo de respuestas), unit-tested en `backend/test/dns.test.js`.
```

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs(dns): documentar el módulo de DNS autoritativo (PowerDNS) en README y CLAUDE"
```

---

## Notas de verificación en VPS (post-implementación)

1. `npm run dev` local: la sección "DNS" carga (estado not_installed); los helpers puros pasan sus tests.
2. En VPS: **Instalar** → verificar `dpkg -s pdns-server`, que el servicio `pdns` arranca (`systemctl status pdns`), que el puerto 53 escucha en la IP pública (`ss -tulpn | grep :53`) y que la API responde (`curl -H "X-API-Key: <key>" http://127.0.0.1:8081/api/v1/servers/localhost/zones`).
3. Configurar nameservers, añadir una zona y varios registros; confirmar con `dig @<IP> <registro>`.
4. Verificar la pantalla de delegación (glue + estado) y, tras delegar en el registrador, que `delegated` pasa a true.
5. Comprobar la coexistencia con `systemd-resolved` (el bind a la IP pública no debe chocar con 127.0.0.53).
