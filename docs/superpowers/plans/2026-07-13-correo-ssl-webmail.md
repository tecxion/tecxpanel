# Aviso SSL + Publicar DNS de correo + Webmail Roundcube — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tres mejoras que rematan features existentes: el monitor avisa de certificados SSL a punto de caducar (15/7/1 días), un botón publica MX/SPF/DKIM/DMARC en la zona PowerDNS del panel (upsert con resumen previo), y Roundcube se instala one-click desde la página Correo.

**Architecture:** Cada mejora sigue el patrón del repo: helpers puros en `lib/` (unit-tested), efectos en el módulo que corresponde (monitor / rutas), HTTP en `routes/`, UI vanilla en `app.js`. Sin módulos nuevos de ruta: F1 amplía notifications/monitor, F2 y F5 amplían mail (+un export de dns).

**Tech Stack:** Node.js + Express, better-sqlite3, socket Docker nativo, API PowerDNS por loopback, `node:test`.

**Spec:** `docs/superpowers/specs/2026-07-13-correo-ssl-webmail-design.md`

## Global Constraints

- Rama `feat/correo-ssl-webmail` (nunca en `main`).
- Idioma español en UI, comentarios, errores y commits.
- Umbrales SSL fijos: **15, 7 y 1 días**; chequeo máx. 1 vez/24 h dentro del `tick()` del monitor.
- F2 es **upsert con resumen previo**; requiere zona existente en PowerDNS (si no, `409`).
- Imagen webmail: `roundcube/roundcubemail` **tag fijado `1.6-apache`**; contenedor `txpl-webmail`; volumen `txpl_webmail_data`; puerto publicado SOLO en `127.0.0.1`.
- Pull de imágenes SIEMPRE con tag (`pullImage` de mail.js ya lo hace).
- Errores de negocio con `err.http`; streaming termina con `__TXPL_DONE__<code>`.
- Migraciones: `try { db.exec("ALTER TABLE ...") } catch (_) {}` (patrón database.js:220).
- Tests con `node:test`: `node --test backend/test/notifications.test.js` y `backend/test/mail.test.js`; suite `npm test` (114 actuales deben seguir verdes).
- `dispatch()` de notifyExecutor nunca lanza; los errores de certbot no tumban el tick.

---

### Task 0: Rama de trabajo

**Files:** ninguno.

- [ ] **Step 1:**

```bash
git checkout -b feat/correo-ssl-webmail
```

---

### Task 1: F1 — Helpers puros `applySslThreshold` + `buildSslExpiryEvent`

**Files:**
- Modify: `backend/lib/notifications.js` (añadir antes del `module.exports` y ampliar el export)
- Test: `backend/test/notifications.test.js` (añadir al final)

**Interfaces:**
- Produces: `SSL_THRESHOLDS = [15, 7, 1]`; `applySslThreshold(prevThreshold, daysLeft)` → `{ next, event }` donde `prevThreshold` ∈ `null|15|7|1` (último umbral notificado), `daysLeft` ∈ `number|null`, `next` ∈ `null|15|7|1`, `event` ∈ `null | { type: 'threshold', threshold } | { type: 'recovered' }`; `buildSslExpiryEvent({ name, domains, daysLeft, hostname, recovered })` → evento `{ kind, hostname, title, detail, since: null }` compatible con `buildTelegramMessage`/`buildEmailMessage`.

- [ ] **Step 1: Tests que fallan** (añadir al final de `backend/test/notifications.test.js`; el fichero ya importa `node:test`/`assert` arriba — añadir los nuevos nombres al require existente de `../lib/notifications` o hacer un require adicional):

```js
const { applySslThreshold, buildSslExpiryEvent, SSL_THRESHOLDS } = require('../lib/notifications');

test('SSL_THRESHOLDS: 15/7/1', () => {
  assert.deepStrictEqual(SSL_THRESHOLDS, [15, 7, 1]);
});

test('applySslThreshold: cruza umbrales una sola vez', () => {
  // Sin aviso previo, 60 días: nada.
  assert.deepStrictEqual(applySslThreshold(null, 60), { next: null, event: null });
  // Cae a 14: avisa umbral 15.
  assert.deepStrictEqual(applySslThreshold(null, 14), { next: 15, event: { type: 'threshold', threshold: 15 } });
  // Sigue en 12 con 15 ya avisado: silencio.
  assert.deepStrictEqual(applySslThreshold(15, 12), { next: 15, event: null });
  // Cae a 6: avisa umbral 7.
  assert.deepStrictEqual(applySslThreshold(15, 6), { next: 7, event: { type: 'threshold', threshold: 7 } });
  // Cae a 1: avisa umbral 1. daysLeft 0 (caducado) también es umbral 1.
  assert.deepStrictEqual(applySslThreshold(7, 1), { next: 1, event: { type: 'threshold', threshold: 1 } });
  assert.deepStrictEqual(applySslThreshold(null, 0), { next: 1, event: { type: 'threshold', threshold: 1 } });
  assert.deepStrictEqual(applySslThreshold(1, 0), { next: 1, event: null });
});

test('applySslThreshold: recuperación y casos borde', () => {
  // Renovado (>15) tras aviso: evento recovered y reset.
  assert.deepStrictEqual(applySslThreshold(7, 88), { next: null, event: { type: 'recovered' } });
  // Renovado sin aviso previo: silencio.
  assert.deepStrictEqual(applySslThreshold(null, 88), { next: null, event: null });
  // daysLeft null (parseo desconocido): no-op conservador.
  assert.deepStrictEqual(applySslThreshold(15, null), { next: 15, event: null });
  assert.deepStrictEqual(applySslThreshold(null, null), { next: null, event: null });
});

test('buildSslExpiryEvent: aviso y recuperación', () => {
  const ev = buildSslExpiryEvent({ name: 'vps.tecxart.es', domains: ['vps.tecxart.es'], daysLeft: 6, hostname: 'vps', recovered: false });
  assert.strictEqual(ev.kind, 'down');
  assert.ok(ev.title.includes('vps.tecxart.es') && ev.title.includes('6'));
  assert.ok(ev.detail.includes('vps.tecxart.es'));
  const rec = buildSslExpiryEvent({ name: 'vps.tecxart.es', domains: ['vps.tecxart.es'], daysLeft: 89, hostname: 'vps', recovered: true });
  assert.strictEqual(rec.kind, 'recovered');
  assert.ok(rec.title.includes('renovado'));
});
```

- [ ] **Step 2:** Run: `node --test backend/test/notifications.test.js` — Expected: FAIL (`applySslThreshold is not a function`).

- [ ] **Step 3: Implementación** en `backend/lib/notifications.js` (antes de `module.exports`):

```js
// ── Caducidad de certificados SSL ─────────────────────────────────
// Umbrales de aviso en días. Certbot renueva solo a ~30 días: llegar
// a 15 ya significa que la renovación automática está fallando.
const SSL_THRESHOLDS = [15, 7, 1];

// applySslThreshold(prevThreshold, daysLeft) → { next, event }
//  - prevThreshold: último umbral notificado (15/7/1) o null.
//  - daysLeft: días hasta caducar (0 = caducado; null = desconocido).
// Un aviso por umbral: solo emite al cruzar un umbral MÁS bajo que el
// ya notificado. Si vuelve a >15 días (renovado) emite recuperación.
function applySslThreshold(prevThreshold, daysLeft) {
  if (daysLeft === null || daysLeft === undefined) {
    return { next: prevThreshold ?? null, event: null };
  }
  if (daysLeft > SSL_THRESHOLDS[0]) {
    return prevThreshold !== null && prevThreshold !== undefined
      ? { next: null, event: { type: 'recovered' } }
      : { next: null, event: null };
  }
  // Umbral aplicable: el más bajo que cubre daysLeft (0-1→1, 2-7→7, 8-15→15).
  const t = [...SSL_THRESHOLDS].reverse().find((x) => daysLeft <= x);
  if (prevThreshold === null || prevThreshold === undefined || t < prevThreshold) {
    return { next: t, event: { type: 'threshold', threshold: t } };
  }
  return { next: prevThreshold, event: null };
}

// Evento de caducidad/renovación con el mismo shape que buildStatusEvent.
function buildSslExpiryEvent({ name, domains, daysLeft, hostname, recovered }) {
  if (recovered) {
    return {
      kind: 'recovered', hostname,
      title: `Certificado ${name} renovado`,
      detail: `Dominios: ${(domains || []).join(', ')}`,
      since: null,
    };
  }
  const dias = daysLeft === 1 ? '1 día' : `${daysLeft} días`;
  return {
    kind: 'down', hostname,
    title: daysLeft <= 0 ? `Certificado ${name} CADUCADO` : `Certificado ${name} caduca en ${dias}`,
    detail: `Dominios: ${(domains || []).join(', ')}. Renueva desde la sección SSL del panel.`,
    since: null,
  };
}
```

Y añadir al `module.exports`: `SSL_THRESHOLDS, applySslThreshold, buildSslExpiryEvent`.

- [ ] **Step 4:** Run: `node --test backend/test/notifications.test.js` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/lib/notifications.js backend/test/notifications.test.js
git commit -m "feat(ssl-aviso): helpers puros de umbrales de caducidad y evento SSL"
```

---

### Task 2: F1 — Columna `ev_ssl_enabled` + ruta + checkbox en Ajustes

**Files:**
- Modify: `backend/database.js` (migración ~línea 228; `notify_config` schema para instalaciones nuevas; `upsertNotifyConfig`)
- Modify: `backend/routes/notifications.js:84-87` (campo en el POST de config)
- Modify: `frontend/views/pages/settings.html:71` (checkbox tras ev-security)
- Modify: `frontend/js/app.js:1656-1679` (cargar/guardar el checkbox)

**Interfaces:**
- Produces: columna `notify_config.ev_ssl_enabled INTEGER NOT NULL DEFAULT 1`, aceptada por `queries.upsertNotifyConfig` con parámetro `@ev_ssl_enabled`. Task 3 la lee como `cfg.ev_ssl_enabled`.

- [ ] **Step 1: Migración** en `backend/database.js`, junto a las demás (~línea 228):

```js
try { db.exec("ALTER TABLE notify_config ADD COLUMN ev_ssl_enabled INTEGER NOT NULL DEFAULT 1"); } catch (_) {}
```

Y en el CREATE TABLE de `notify_config` (instalaciones nuevas), tras `ev_security_enabled`:

```sql
    ev_ssl_enabled      INTEGER NOT NULL DEFAULT 1,
```

- [ ] **Step 2: `upsertNotifyConfig`** — añadir la columna en las TRES partes de la SQL (lista de columnas, VALUES y ON CONFLICT):

```sql
-- en la lista: ..., ev_services_enabled, ev_security_enabled, ev_ssl_enabled, updated_at
-- en VALUES:   ..., @ev_services_enabled, @ev_security_enabled, @ev_ssl_enabled, datetime('now')
-- en UPDATE:   ev_ssl_enabled = excluded.ev_ssl_enabled,
```

- [ ] **Step 3: Ruta** — en `backend/routes/notifications.js` donde se montan los `ev_*` (líneas 84-87), añadir:

```js
    ev_ssl_enabled: b.ev_ssl_enabled ? 1 : 0,
```

- [ ] **Step 4: Frontend** — en `frontend/views/pages/settings.html`, tras la línea del checkbox `ntf-ev-security`:

```html
  <div class="form-group"><label><input type="checkbox" id="ntf-ev-ssl"> Certificado SSL a punto de caducar (15/7/1 días)</label></div>
```

En `frontend/js/app.js`, junto a la carga de los otros (línea ~1659):

```js
  document.getElementById('ntf-ev-ssl').checked = !!r.ev_ssl_enabled;
```

Y en el guardado (línea ~1679):

```js
    ev_ssl_enabled: document.getElementById('ntf-ev-ssl').checked,
```

- [ ] **Step 5: Verificar** — Run: `npm test && node --check frontend/js/app.js` — Expected: PASS / sin errores. (La migración corre al cargar `database.js` en los tests.)

- [ ] **Step 6: Commit**

```bash
git add backend/database.js backend/routes/notifications.js frontend/views/pages/settings.html frontend/js/app.js
git commit -m "feat(ssl-aviso): flag ev_ssl_enabled en config de notificaciones y Ajustes"
```

---

### Task 3: F1 — `checkSslExpiry` en el monitor

**Files:**
- Modify: `backend/lib/monitor.js`

**Interfaces:**
- Consumes: `applySslThreshold`, `buildSslExpiryEvent` (Task 1); `parseCertbotCertificates` de `./ssl`; `queries.getNotifyState/upsertNotifyState`; `dispatch`; `cfg.ev_ssl_enabled` (Task 2).
- Produces: chequeo diario dentro de `tick()`; estado por cert en `notify_state` clave `sslexp:<name>` (`status` = `'ok'` o el umbral como texto `'15'|'7'|'1'`).

- [ ] **Step 1: Ampliar imports** (línea 17) para incluir los nuevos helpers:

```js
const { applyTick, resourceKey, buildStatusEvent, applySslThreshold, buildSslExpiryEvent } = require('./notifications');
const { parseCertbotCertificates } = require('./ssl');
```

- [ ] **Step 2: Añadir el chequeo** (tras `checkContainers`, antes de `tick`):

```js
// ── Caducidad SSL (1 vez cada 24 h) ──────────────────────────
// Estado por certificado en notify_state clave `sslexp:<name>`:
// status = 'ok' (sin aviso activo) o el umbral notificado ('15'|'7'|'1').
// Si certbot no está instalado, sale en silencio (Windows/dev o VPS sin SSL).
const SSL_CHECK_MS = 24 * 60 * 60 * 1000;
let lastSslCheck = 0;

async function checkSslExpiry(hostname) {
  const r = await runSafe('certbot', ['certificates']);
  if (!r.ok) return;
  for (const cert of parseCertbotCertificates(r.stdout || '')) {
    const key = `sslexp:${cert.name}`;
    const row = queries.getNotifyState.get(key) || null;
    const prev = row && row.status !== 'ok' ? (parseInt(row.status, 10) || null) : null;
    const days = cert.valid ? cert.daysLeft : 0; // INVALID/EXPIRED cuenta como 0
    const { next, event } = applySslThreshold(prev, days);
    if (event) {
      const ev = buildSslExpiryEvent({
        name: cert.name, domains: cert.domains, daysLeft: days,
        hostname, recovered: event.type === 'recovered',
      });
      await dispatch(ev); // nunca lanza; si falla la entrega, reavisará al cruzar el siguiente umbral
    }
    if (event || !row) {
      queries.upsertNotifyState.run({
        key,
        status: next === null ? 'ok' : String(next),
        pending_status: null,
        pending_count: 0,
        since: new Date().toISOString(),
        notified: 1,
      });
    }
  }
}
```

- [ ] **Step 3: Integrar en `tick()`** — dentro del `try`, tras el bloque de `checks` (después del `for` de `checks`, antes del `catch`):

```js
    // Caducidad SSL: chequeo barato pero no en cada tick (1 vez/24 h).
    if (cfg.ev_ssl_enabled && Date.now() - lastSslCheck >= SSL_CHECK_MS) {
      lastSslCheck = Date.now();
      await checkSslExpiry(hostname);
    }
```

- [ ] **Step 4: Verificar** — Run: `TXPL_DIR=./ node -e "require('./backend/lib/monitor')" && npm test` — Expected: carga limpia, tests PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/lib/monitor.js
git commit -m "feat(ssl-aviso): chequeo diario de caducidad SSL en el monitor"
```

---

### Task 4: F2 — Export `pdnsApi` + helper puro `mailRecordsToRrsets`

**Files:**
- Modify: `backend/routes/dns.js:298` (exports extra)
- Modify: `backend/lib/mail.js` (nuevo helper + export)
- Test: `backend/test/mail.test.js` (añadir al final)

**Interfaces:**
- Produces:
  - `require('./dns').pdnsApi(method, path, apiKey, body)` y `require('./dns').getDnsConnectedConfig()` (lanza `e.http=400` si DNS no instalado) — reutilizados por mail.js en Task 5.
  - `mailRecordsToRrsets(records, zone)` (puro, en lib/mail.js) → array `{ name, type, content }`: convierte la salida de `buildDnsRecords` a contenidos listos para `buildRrsetPatch`. Excluye PTR siempre, DKIM sin valor y A sin IP.

- [ ] **Step 1: Tests que fallan** (al final de `backend/test/mail.test.js`):

```js
const { mailRecordsToRrsets } = require('../lib/mail');

test('mailRecordsToRrsets: convierte y filtra registros', () => {
  const records = [
    { type: 'A', name: 'mail.ejemplo.com', value: '1.2.3.4' },
    { type: 'MX', name: 'ejemplo.com', value: 'mail.ejemplo.com', priority: 10 },
    { type: 'TXT', name: 'ejemplo.com', value: 'v=spf1 mx ~all' },
    { type: 'TXT', name: 'mail._domainkey.ejemplo.com', value: '' },            // DKIM sin generar: fuera
    { type: 'TXT', name: '_dmarc.ejemplo.com', value: 'v=DMARC1; p=quarantine; rua=mailto:postmaster@ejemplo.com' },
    { type: 'PTR', name: '1.2.3.4', value: 'mail.ejemplo.com' },                // PTR: fuera siempre
  ];
  const rr = mailRecordsToRrsets(records, 'ejemplo.com');
  assert.deepStrictEqual(rr.map((x) => x.type), ['A', 'MX', 'TXT', 'TXT']);
  assert.deepStrictEqual(rr[0], { name: 'mail.ejemplo.com', type: 'A', content: '1.2.3.4' });
  assert.deepStrictEqual(rr[1], { name: 'ejemplo.com', type: 'MX', content: '10 mail.ejemplo.com.' });
  assert.deepStrictEqual(rr[2], { name: 'ejemplo.com', type: 'TXT', content: '"v=spf1 mx ~all"' });
  assert.ok(rr[3].name === '_dmarc.ejemplo.com' && rr[3].content.startsWith('"v=DMARC1'));
});

test('mailRecordsToRrsets: DKIM con valor entra; A sin IP fuera', () => {
  const rr = mailRecordsToRrsets([
    { type: 'A', name: 'mail.e.com', value: '' },
    { type: 'TXT', name: 'mail._domainkey.e.com', value: 'v=DKIM1; k=rsa; p=MIIB...' },
  ], 'e.com');
  assert.strictEqual(rr.length, 1);
  assert.strictEqual(rr[0].type, 'TXT');
  assert.ok(rr[0].content.includes('DKIM1'));
});
```

- [ ] **Step 2:** Run: `node --test backend/test/mail.test.js` — Expected: FAIL (`mailRecordsToRrsets is not a function`).

- [ ] **Step 3: Implementar** en `backend/lib/mail.js` (antes del `module.exports`; añadir `mailRecordsToRrsets` al export):

```js
// Convierte los registros de buildDnsRecords al formato de la API de
// PowerDNS ({ name, type, content }) reutilizando buildRecordContent de
// lib/dns.js. Excluye: PTR (se pide al proveedor del VPS, no a la zona),
// DKIM sin generar y A sin IP detectada.
const { buildRecordContent } = require('./dns');

function mailRecordsToRrsets(records, zone) {
  const out = [];
  for (const r of records || []) {
    if (r.type === 'PTR') continue;
    if (!r.value) continue;
    out.push({
      name: r.name,
      type: r.type,
      content: buildRecordContent(r.type, r.value, r.priority || 10),
    });
  }
  return out;
}
```

- [ ] **Step 4: Exports en `backend/routes/dns.js`** (tras `module.exports = router;`):

```js
// Reutilizados por routes/mail.js para publicar los registros de correo
// en la zona del panel (patrón export mysqlExec de databases.js).
module.exports.pdnsApi = pdnsApi;
module.exports.getDnsConnectedConfig = getConnectedConfig;
```

- [ ] **Step 5:** Run: `node --test backend/test/mail.test.js && npm test` — Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/lib/mail.js backend/routes/dns.js backend/test/mail.test.js
git commit -m "feat(correo-dns): helper mailRecordsToRrsets y export del cliente PowerDNS"
```

---

### Task 5: F2 — Endpoints `GET /dns/preview` y `POST /dns/publish`

**Files:**
- Modify: `backend/routes/mail.js` (tras el `GET /dns` existente, línea ~337)

**Interfaces:**
- Consumes: `pdnsApi`/`getDnsConnectedConfig` (Task 4), `mailRecordsToRrsets` + `buildDnsRecords` (lib/mail), `canonical`/`buildRrsetPatch`/`parseRecords` de `lib/dns`, `queries.getMailConfig`, `audit`.
- Produces: `GET /api/mail/dns/preview` → `{ zone, items: [{ type, name, value, action: 'crear'|'sobrescribir'|'igual' }], skipped: [nota…] }`; `POST /api/mail/dns/publish` → `{ success: true, applied: N }`. Ambos `409` si correo sin configurar, DNS sin instalar o zona inexistente.

- [ ] **Step 1: Añadir imports** al principio de `backend/routes/mail.js` (junto a los require existentes):

```js
const D = require('../lib/dns');
const { mailRecordsToRrsets } = require('../lib/mail'); // añadir al require existente de lib/mail
```

(Nota: `buildDnsRecords` ya está importado; añadir `mailRecordsToRrsets` a esa misma línea de require.)

- [ ] **Step 2: Helper local + endpoints** (pegar tras el `router.get('/dns', ...)` existente):

```js
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
```

**Nota de orden de rutas:** el `GET /dns` existente es un path exacto de un segmento; `/dns/preview` y `/dns/publish` tienen dos segmentos — no hay conflicto en Express, da igual el orden.

- [ ] **Step 3: Verificar** — Run: `TXPL_DIR=./ node -e "require('./backend/routes/mail')" && npm test` — Expected: carga limpia, PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/routes/mail.js
git commit -m "feat(correo-dns): preview y publicación upsert de MX/SPF/DKIM/DMARC en PowerDNS"
```

---

### Task 6: F2 — Botón "Publicar en DNS del panel" en la página Correo

**Files:**
- Modify: `frontend/js/app.js` (zona del render de `mail-dns`, ~línea 2822)

**Interfaces:**
- Consumes: `GET /mail/dns/preview`, `POST /mail/dns/publish` (Task 5); helpers `req`, `esc`, `toast`, `closeModal`, patrón de modal dinámica (`editFile`, app.js ~1416).

- [ ] **Step 1:** Localizar la función que pinta `#mail-dns` (app.js ~2822) y añadir al final de su HTML (tras la tabla de registros):

```js
  el.innerHTML += `
    <div style="margin-top:10px">
      <button class="btn btn-sm btn-primary" onclick="mailDnsPreview()"><i class="ti ti-world-upload"></i> Publicar en DNS del panel</button>
      <span class="muted" style="font-size:12px;margin-left:8px">Requiere el DNS del panel instalado y la zona creada.</span>
    </div>`;
```

- [ ] **Step 2: Funciones nuevas** (junto a las demás funciones de mail en app.js):

```js
// mailDnsPreview: pide el resumen y muestra la modal de confirmación.
async function mailDnsPreview() {
  const r = await req('GET', '/mail/dns/preview');
  if (!r || r.error) { toast(r?.error || 'No se pudo calcular el resumen', 'error'); return; }
  const ACTION_BADGE = { crear: 'badge-green', sobrescribir: 'badge-yellow', igual: 'badge' };
  const rows = r.items.map((i) => `
    <tr><td><span class="badge ${ACTION_BADGE[i.action]}">${esc(i.action)}</span></td>
    <td>${esc(i.type)}</td><td>${esc(i.name)}</td>
    <td style="font-family:var(--mono);font-size:11px;word-break:break-all">${esc(i.value)}</td></tr>`).join('');
  const skipped = (r.skipped || []).map((s) => `<p class="muted" style="font-size:12px">⚠ ${esc(s)}</p>`).join('');
  const modal = document.createElement('div');
  modal.className = 'modal-overlay open';
  modal.id = 'modal-mail-dns';
  modal.dataset.dynamic = 'true';
  modal.innerHTML = `
    <div class="modal" style="max-width:720px">
      <div class="modal-header">
        <div class="modal-title"><i class="ti ti-world-upload"></i> Publicar registros en la zona ${esc(r.zone)}</div>
        <button class="btn btn-sm" onclick="closeModal('modal-mail-dns')"><i class="ti ti-x"></i></button>
      </div>
      <div style="padding:1rem;max-height:50vh;overflow:auto">
        <table class="table"><thead><tr><th>Acción</th><th>Tipo</th><th>Nombre</th><th>Valor</th></tr></thead>
        <tbody>${rows}</tbody></table>
        ${skipped}
      </div>
      <div class="modal-footer">
        <button class="btn" onclick="closeModal('modal-mail-dns')">Cancelar</button>
        <button class="btn btn-primary" onclick="mailDnsPublish()"><i class="ti ti-check"></i> Publicar</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

// mailDnsPublish: confirma el upsert.
async function mailDnsPublish() {
  closeModal('modal-mail-dns');
  const r = await req('POST', '/mail/dns/publish');
  if (r?.success) toast(`${r.applied} registros publicados en el DNS`, 'success');
  else toast(r?.error || 'Error al publicar', 'error');
}
```

- [ ] **Step 3: Verificar** — Run: `node --check frontend/js/app.js` — Expected: sin errores. Manual: `npm run dev`, página Correo (con correo sin configurar el botón devuelve el 409 con mensaje claro en toast).

- [ ] **Step 4: Commit**

```bash
git add frontend/js/app.js
git commit -m "feat(correo-dns): botón publicar registros con resumen previo en la página Correo"
```

---

### Task 7: F5 — Helper puro `buildWebmailContainerConfig`

**Files:**
- Modify: `backend/lib/mail.js`
- Test: `backend/test/mail.test.js`

**Interfaces:**
- Produces: `WEBMAIL_CONTAINER = 'txpl-webmail'`, `WEBMAIL_IMAGE = 'roundcube/roundcubemail'`, `WEBMAIL_TAG = '1.6-apache'`, `WEBMAIL_VOLUME = 'txpl_webmail_data'`; `buildWebmailContainerConfig({ hostPort, mailHostname, domain })` → config JSON para `POST /containers/create`.

- [ ] **Step 1: Tests que fallan** (al final de `backend/test/mail.test.js`):

```js
const { buildWebmailContainerConfig, WEBMAIL_CONTAINER, WEBMAIL_IMAGE, WEBMAIL_TAG, WEBMAIL_VOLUME } = require('../lib/mail');

test('webmail: constantes', () => {
  assert.strictEqual(WEBMAIL_CONTAINER, 'txpl-webmail');
  assert.strictEqual(WEBMAIL_IMAGE, 'roundcube/roundcubemail');
  assert.strictEqual(WEBMAIL_TAG, '1.6-apache');
  assert.strictEqual(WEBMAIL_VOLUME, 'txpl_webmail_data');
});

test('buildWebmailContainerConfig: imagen fijada, IMAP/SMTP por hostname, loopback', () => {
  const c = buildWebmailContainerConfig({ hostPort: 8110, mailHostname: 'mail.ejemplo.com', domain: 'webmail.ejemplo.com' });
  assert.strictEqual(c.Image, 'roundcube/roundcubemail:1.6-apache');
  assert.ok(c.Env.includes('ROUNDCUBEMAIL_DEFAULT_HOST=ssl://mail.ejemplo.com'));
  assert.ok(c.Env.includes('ROUNDCUBEMAIL_DEFAULT_PORT=993'));
  assert.ok(c.Env.includes('ROUNDCUBEMAIL_SMTP_SERVER=tls://mail.ejemplo.com'));
  assert.ok(c.Env.includes('ROUNDCUBEMAIL_SMTP_PORT=587'));
  assert.deepStrictEqual(c.HostConfig.PortBindings['80/tcp'], [{ HostIp: '127.0.0.1', HostPort: '8110' }]);
  assert.deepStrictEqual(c.HostConfig.Binds, ['txpl_webmail_data:/var/roundcube/config']);
  assert.strictEqual(c.HostConfig.RestartPolicy.Name, 'unless-stopped');
  assert.strictEqual(c.Labels['txpl.domain'], 'webmail.ejemplo.com');
});

test('buildWebmailContainerConfig: sin dominio => sin label', () => {
  const c = buildWebmailContainerConfig({ hostPort: 8110, mailHostname: 'mail.e.com' });
  assert.deepStrictEqual(c.Labels, {});
});
```

- [ ] **Step 2:** Run: `node --test backend/test/mail.test.js` — Expected: FAIL.

- [ ] **Step 3: Implementar** en `backend/lib/mail.js` (constantes junto a las de MAIL_*, función antes del export; ampliar `module.exports`):

```js
// ── Webmail (Roundcube) ──────────────────────────────────────
const WEBMAIL_CONTAINER = 'txpl-webmail';
const WEBMAIL_IMAGE = 'roundcube/roundcubemail';
// Tag fijado a minor (mismo criterio que el catálogo): nunca latest implícito.
const WEBMAIL_TAG = '1.6-apache';
const WEBMAIL_VOLUME = 'txpl_webmail_data';

// Config del contenedor Roundcube. Conecta al mailserver por su hostname
// PÚBLICO (TLS válido con el cert de Let's Encrypt del mailserver); el
// puerto web solo se publica en loopback (el acceso externo va por Nginx).
function buildWebmailContainerConfig({ hostPort, mailHostname, domain = null } = {}) {
  return {
    Image: `${WEBMAIL_IMAGE}:${WEBMAIL_TAG}`,
    Env: [
      `ROUNDCUBEMAIL_DEFAULT_HOST=ssl://${mailHostname}`,
      'ROUNDCUBEMAIL_DEFAULT_PORT=993',
      `ROUNDCUBEMAIL_SMTP_SERVER=tls://${mailHostname}`,
      'ROUNDCUBEMAIL_SMTP_PORT=587',
    ],
    ExposedPorts: { '80/tcp': {} },
    HostConfig: {
      RestartPolicy: { Name: 'unless-stopped' },
      PortBindings: { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: String(hostPort) }] },
      Binds: [`${WEBMAIL_VOLUME}:/var/roundcube/config`],
    },
    Labels: domain ? { 'txpl.domain': domain } : {},
  };
}
```

- [ ] **Step 4:** Run: `node --test backend/test/mail.test.js && npm test` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/lib/mail.js backend/test/mail.test.js
git commit -m "feat(webmail): config declarativa del contenedor Roundcube (tag fijado)"
```

---

### Task 8: F5 — Migración `webmail_*` + endpoints webmail

**Files:**
- Modify: `backend/database.js` (migraciones + 2 queries)
- Modify: `backend/routes/mail.js` (bloque webmail antes de `module.exports`)

**Interfaces:**
- Consumes: `buildWebmailContainerConfig`, `WEBMAIL_*` (Task 7); `dockerRequest`, `pullImage`, `startStream` locales de mail.js; `findFreePort` de `../lib/catalogEngine`; `nginx.buildProxy/enableSite/removeSite/installSsl`.
- Produces: columnas `mail_config.webmail_domain TEXT`, `webmail_port INTEGER`, `webmail_container TEXT`; `queries.setMailWebmail.run(domain, port, container)` y `queries.clearMailWebmail.run()`; endpoints `GET /api/mail/webmail/status`, `POST /webmail/install` (streaming), `POST /webmail/:action(start|stop|restart)`, `DELETE /webmail?volume=true|false` (streaming).

- [ ] **Step 1: Migraciones** en `backend/database.js` (~línea 228):

```js
try { db.exec("ALTER TABLE mail_config ADD COLUMN webmail_domain TEXT"); } catch (_) {}
try { db.exec("ALTER TABLE mail_config ADD COLUMN webmail_port INTEGER"); } catch (_) {}
try { db.exec("ALTER TABLE mail_config ADD COLUMN webmail_container TEXT"); } catch (_) {}
```

Queries (sección mail del objeto `queries`):

```js
  setMailWebmail:   db.prepare('UPDATE mail_config SET webmail_domain = ?, webmail_port = ?, webmail_container = ? WHERE id = 1'),
  clearMailWebmail: db.prepare('UPDATE mail_config SET webmail_domain = NULL, webmail_port = NULL, webmail_container = NULL WHERE id = 1'),
```

- [ ] **Step 2: Endpoints** en `backend/routes/mail.js` (antes de `module.exports`; añadir al require de lib/mail: `buildWebmailContainerConfig, WEBMAIL_CONTAINER, WEBMAIL_TAG, WEBMAIL_IMAGE, WEBMAIL_VOLUME`; y `const { findFreePort } = require('../lib/catalogEngine');` arriba):

```js
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
    await dockerRequest('DELETE', `/containers/${WEBMAIL_CONTAINER}?force=1`).catch(() => {});
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
  write('▶ Desinstalando webmail...\n');
  await dockerRequest('DELETE', `/containers/${WEBMAIL_CONTAINER}?force=1&v=0`).catch(() => {});
  if (removeVolume) {
    write(`⏳ Borrando volumen ${WEBMAIL_VOLUME}...\n`);
    await dockerRequest('DELETE', `/volumes/${WEBMAIL_VOLUME}`).catch(() => {});
  }
  try { await nginx.removeSite(WEBMAIL_CONF); } catch (_) {}
  queries.clearMailWebmail.run();
  write('\n✅ Webmail desinstalado.\n');
  return done(0);
}));
```

**Nota de orden:** los paths `/webmail/...` tienen dos segmentos y `DELETE /webmail` es exacto — no chocan con `POST /:action(start|stop|restart)` (regex-limitado) ni con `DELETE /`. Pegar el bloque antes de `module.exports` es seguro.

- [ ] **Step 3: Verificar** — Run: `TXPL_DIR=./ node -e "require('./backend/routes/mail')" && npm test` — Expected: carga limpia, PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/database.js backend/routes/mail.js
git commit -m "feat(webmail): endpoints de instalación streaming, control y desinstalación de Roundcube"
```

---

### Task 9: F5 — Tarjeta Webmail en la página Correo

**Files:**
- Modify: `frontend/js/app.js` (dentro del HTML que monta `loadMail()` cuando el correo está instalado, ~línea 2726, y funciones nuevas)

**Interfaces:**
- Consumes: `GET /mail/webmail/status`, `POST /mail/webmail/install` (streaming vía el helper `mailStream` existente), `POST /mail/webmail/:action`, `DELETE /mail/webmail`; helpers `req`, `esc`, `toast`, `confirm`, `mailStream(path, body, consoleEl)`.

- [ ] **Step 1:** En el HTML de `loadMail()` (vista "instalado"), añadir tras la sección DNS (`<div id="mail-dns"></div>`):

```js
      <h3 style="margin-top:1.5rem"><i class="ti ti-inbox"></i> Webmail (Roundcube)</h3>
      <div id="mail-webmail">Cargando…</div>
```

Y al final de `loadMail()` (junto a `loadMailboxes(); loadAliases();`): `loadWebmail();`

- [ ] **Step 2: Funciones** (junto a las demás de mail):

```js
// loadWebmail: pinta la tarjeta según el estado del contenedor Roundcube.
async function loadWebmail() {
  const el = document.getElementById('mail-webmail');
  if (!el) return;
  const st = await req('GET', '/mail/webmail/status');
  if (!st) return;
  if (!st.installed) {
    el.innerHTML = `
      <p class="muted" style="font-size:13px">Interfaz web para leer y enviar correo con los buzones de este servidor.</p>
      <div class="form-row">
        <input type="text" id="webmail-domain" placeholder="webmail.tudominio.com (opcional)" style="width:280px">
        <label style="margin-left:8px"><input type="checkbox" id="webmail-ssl"> SSL</label>
        <button class="btn btn-primary btn-sm" style="margin-left:8px" onclick="webmailInstall()"><i class="ti ti-download"></i> Instalar webmail</button>
      </div>`;
    return;
  }
  const url = st.domain ? `https://${st.domain}` : `http://127.0.0.1:${st.port}`;
  el.innerHTML = `
    <p><span class="badge ${st.running ? 'badge-green' : 'badge-red'}">${st.running ? 'En marcha' : 'Parado'}</span>
       ${st.domain ? `<a href="${esc(url)}" target="_blank">${esc(st.domain)}</a>` : `puerto ${st.port} (loopback)`}</p>
    <div class="form-row">
      <button class="btn btn-sm" onclick="webmailAction('${st.running ? 'stop' : 'start'}')">${st.running ? 'Parar' : 'Iniciar'}</button>
      <button class="btn btn-sm" onclick="webmailAction('restart')">Reiniciar</button>
      <button class="btn btn-sm btn-danger" onclick="webmailUninstall()"><i class="ti ti-trash"></i> Desinstalar</button>
    </div>`;
}

async function webmailInstall() {
  const domain = document.getElementById('webmail-domain').value.trim();
  const ssl = document.getElementById('webmail-ssl').checked;
  const con = document.getElementById('mail-console');
  con.style.display = 'block'; con.textContent = '';
  await mailStream('/mail/webmail/install', { domain, ssl }, con);
  loadWebmail();
}

async function webmailAction(a) {
  const r = await req('POST', `/mail/webmail/${a}`);
  if (r?.error) toast(r.error, 'error');
  loadWebmail();
}

async function webmailUninstall() {
  const purge = confirm('¿Borrar también la configuración guardada de Roundcube (volumen)? Aceptar = sí, Cancelar = conservar.');
  if (!confirm('¿Desinstalar el webmail?')) return;
  const con = document.getElementById('mail-console');
  con.style.display = 'block'; con.textContent = '';
  await mailStreamDelete(`/mail/webmail?volume=${purge}`, con);
  loadWebmail();
}
```

**Nota para el implementador:** revisar la firma real de `mailStream` en app.js; si solo soporta POST, añadir un `mailStreamDelete(path, consoleEl)` calcándolo con `method: 'DELETE'` (o generalizar `mailStream(path, body, con, method='POST')` y usarla para ambos). El orden de los dos `confirm` de `webmailUninstall` es intencional: primero decide la purga, después confirma la acción.

- [ ] **Step 3: Verificar** — Run: `node --check frontend/js/app.js`. Manual con `npm run dev`: la tarjeta aparece en Correo; sin Docker/mail el flujo falla limpio.

- [ ] **Step 4: Commit**

```bash
git add frontend/js/app.js
git commit -m "feat(webmail): tarjeta Roundcube en la página Correo"
```

---

### Task 10: Docs + verificación final + merge

**Files:**
- Modify: `CLAUDE.md` (línea de `mail.js` y `notifications.js` en Architecture)
- Modify: `README.md` (características)

- [ ] **Step 1: `CLAUDE.md`** — ampliar la línea de `mail.js` añadiendo al final:

```markdown
 Incluye publicación one-click de los registros DNS de correo en la zona PowerDNS del panel (upsert con resumen previo, `/dns/preview` + `/dns/publish`) y webmail Roundcube (`txpl-webmail`, tag fijado, endpoints `/webmail/*`).
```

Y la de `notifications.js` añadiendo:

```markdown
 El monitor también avisa de certificados SSL a punto de caducar (umbrales 15/7/1 días, chequeo diario, estado en `notify_state` clave `sslexp:<name>`, flag `ev_ssl_enabled`).
```

- [ ] **Step 2: `README.md`** — en la lista de características, ampliar la línea de Correo (o añadir bullet):

```markdown
- 📬 **Webmail Roundcube**: interfaz web de correo instalable con un clic desde la página Correo, y publicación automática de los registros DNS (MX/SPF/DKIM/DMARC) en el DNS del panel. Avisos por Telegram/email cuando un certificado SSL está a punto de caducar.
```

- [ ] **Step 3: Verificación final** — Run: `npm test` — Expected: PASS (todas, con las nuevas de notifications y mail).

- [ ] **Step 4: Commit + merge**

```bash
git add README.md CLAUDE.md
git commit -m "docs(correo-ssl-webmail): README y CLAUDE.md"
git checkout main
git merge --ff-only feat/correo-ssl-webmail
npm test
git branch -d feat/correo-ssl-webmail
git push origin main
```

---

## Self-review

- **Cobertura del spec:** F1 umbrales 15/7/1 + 24h + anti-repetición + recuperación + flag + checkbox ✓ (Tasks 1-3); F2 upsert con preview, 409s de correo/DNS/zona, DKIM omitido con nota, audit ✓ (Tasks 4-6); F5 tag fijado 1.6-apache, hostname público IMAP/SMTP, loopback, volumen, dominio+SSL opcional, purga opt-in, migración mail_config ✓ (Tasks 7-9); docs ✓ (Task 10).
- **Placeholders:** ninguno; la única adaptación delegada (firma de `mailStream`) está explícita con las dos alternativas concretas.
- **Consistencia:** `applySslThreshold(prev, daysLeft)` usada igual en Task 1 y 3; `mailRecordsToRrsets(records, zone)` igual en 4 y 5; `buildWebmailContainerConfig({hostPort, mailHostname, domain})` igual en 7 y 8; `setMailWebmail.run(domain, port, container)` posicional coherente.
