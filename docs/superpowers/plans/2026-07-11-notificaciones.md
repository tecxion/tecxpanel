# Notificaciones (Telegram + Email) — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** El panel avisa por Telegram y/o email cuando el disco supera un umbral, un servicio o contenedor cae, o hay eventos de seguridad (fuerza bruta, IP nueva) — con transición+recuperación y anti-flapping.

**Architecture:** 3 capas (patrón n8n/mail): `lib/notifications.js` (helpers puros unit-tested), `lib/notifyExecutor.js` (efectos: fetch a Telegram, nodemailer, DB), `lib/monitor.js` (setInterval 60 s en el proceso del panel), `routes/notifications.js` (HTTP). Hooks puntuales en `auth.js`. Config en fila única `notify_config` con secretos AES-256-GCM; estado por recurso en `notify_state`.

**Tech Stack:** Node ≥ 18 (`fetch` nativo), nodemailer (única dependencia nueva), better-sqlite3, node:test.

**Spec:** `docs/superpowers/specs/2026-07-11-notificaciones-design.md`

## Global Constraints

- Rama de trabajo: `feat/notificaciones` (nunca en `main`).
- UI, comentarios, mensajes de error y commits en **español**.
- Secretos (token Telegram, contraseña SMTP) cifrados con `encryptSecret`/`decryptSecret` (AES-256-GCM); **jamás** en logs, `audit_log` ni respuestas HTTP.
- Comandos externos solo con `run`/`runSafe` (execFile + arrays), nunca interpolación shell.
- Intervalo del monitor: 60 s. Anti-flapping: `CONFIRM_TICKS = 2`. Umbral de disco por defecto: 90 (rango válido 50–99).
- Telegram por `fetch` con `AbortSignal.timeout(10_000)`; nodemailer con timeouts acotados. Ningún tick puede quedar colgado.
- En Windows/dev los chequeos Linux se omiten sin reventar (runSafe devuelve `ok:false`).
- `ok(res, data)` responde `{ success:true, ...data }`; errores de negocio con `fail(res, código, msg)` o `err.http`.
- Tests con `node:test` solo sobre los helpers puros (`backend/test/notifications.test.js`).

---

### Task 1: Rama + dependencia nodemailer

**Files:**
- Modify: `package.json` (añade `nodemailer` a dependencies)

**Interfaces:**
- Produces: rama `feat/notificaciones`; `require('nodemailer')` disponible para la Task 6.

- [ ] **Step 1: Crear la rama**

```bash
cd /Users/kikomontero/Documents/tecxpanel
git checkout -b feat/notificaciones
```

- [ ] **Step 2: Instalar nodemailer**

```bash
npm install nodemailer@^6
```

Expected: `package.json` gana `"nodemailer": "^6.x.x"` en dependencies; `package-lock.json` actualizado.

- [ ] **Step 3: Verificar que carga y que la suite sigue verde**

```bash
node -e "console.log(typeof require('nodemailer').createTransport)"
npm test
```

Expected: `function` y todos los tests PASS.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "build(notificaciones): añade nodemailer para el canal de email"
```

---

### Task 2: Helpers puros — validadores y claves de recurso

**Files:**
- Create: `backend/lib/notifications.js`
- Create: `backend/test/notifications.test.js`

**Interfaces:**
- Produces: `isValidTelegramToken(t) → boolean`, `isValidChatId(id) → boolean`, `isValidSmtpConfig({host,port,from,to}) → boolean`, `resourceKey.disk() → 'disk'`, `resourceKey.service(name) → 'service:<name>'`, `resourceKey.container(name) → 'container:<name>'`, `CONFIRM_TICKS = 2`.

- [ ] **Step 1: Escribir los tests que fallan**

Crea `backend/test/notifications.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const ntf = require('../lib/notifications');

// ── Validadores ──────────────────────────────────────────────────

test('isValidTelegramToken: acepta el formato <digitos>:<hash> de BotFather', () => {
  assert.ok(ntf.isValidTelegramToken('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1'));
  assert.ok(ntf.isValidTelegramToken(' 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1 '), 'tolera espacios alrededor');
});

test('isValidTelegramToken: rechaza tokens malformados', () => {
  assert.strictEqual(ntf.isValidTelegramToken(''), false);
  assert.strictEqual(ntf.isValidTelegramToken('sin-dos-puntos'), false);
  assert.strictEqual(ntf.isValidTelegramToken('abc:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1'), false, 'la parte izquierda debe ser numérica');
  assert.strictEqual(ntf.isValidTelegramToken('123:corto'), false, 'hash demasiado corto');
  assert.strictEqual(ntf.isValidTelegramToken(null), false);
  assert.strictEqual(ntf.isValidTelegramToken(12345), false);
});

test('isValidChatId: numérico, admite negativos (grupos)', () => {
  assert.ok(ntf.isValidChatId('123456789'));
  assert.ok(ntf.isValidChatId('-1001234567890'));
  assert.ok(ntf.isValidChatId(987654));
  assert.strictEqual(ntf.isValidChatId(''), false);
  assert.strictEqual(ntf.isValidChatId('abc'), false);
  assert.strictEqual(ntf.isValidChatId('12.5'), false);
  assert.strictEqual(ntf.isValidChatId(null), false);
});

test('isValidSmtpConfig: exige host, puerto 1-65535 y emails de/para', () => {
  const good = { host: 'smtp.ejemplo.com', port: 587, from: 'panel@ejemplo.com', to: 'admin@ejemplo.com' };
  assert.ok(ntf.isValidSmtpConfig(good));
  assert.strictEqual(ntf.isValidSmtpConfig({ ...good, host: '' }), false);
  assert.strictEqual(ntf.isValidSmtpConfig({ ...good, host: 'con espacios' }), false);
  assert.strictEqual(ntf.isValidSmtpConfig({ ...good, port: 0 }), false);
  assert.strictEqual(ntf.isValidSmtpConfig({ ...good, port: 70000 }), false);
  assert.strictEqual(ntf.isValidSmtpConfig({ ...good, port: 'abc' }), false);
  assert.strictEqual(ntf.isValidSmtpConfig({ ...good, from: 'no-es-email' }), false);
  assert.strictEqual(ntf.isValidSmtpConfig({ ...good, to: '' }), false);
  assert.strictEqual(ntf.isValidSmtpConfig(null), false);
});

// ── Claves de recurso ────────────────────────────────────────────

test('resourceKey: claves estables por tipo', () => {
  assert.strictEqual(ntf.resourceKey.disk(), 'disk');
  assert.strictEqual(ntf.resourceKey.service('nginx'), 'service:nginx');
  assert.strictEqual(ntf.resourceKey.container('txpl-n8n'), 'container:txpl-n8n');
});

test('CONFIRM_TICKS es 2 (anti-flapping)', () => {
  assert.strictEqual(ntf.CONFIRM_TICKS, 2);
});
```

- [ ] **Step 2: Ejecutar y ver que falla**

```bash
node --test backend/test/notifications.test.js
```

Expected: FAIL — `Cannot find module '../lib/notifications'`.

- [ ] **Step 3: Implementación mínima**

Crea `backend/lib/notifications.js`:

```js
'use strict';

// ─────────────────────────────────────────────────────────────────
//  notifications.js — Helpers PUROS de notificaciones.
//  Sin estado, sin DB, sin red: solo funciones deterministas.
//  Unit-tested en backend/test/notifications.test.js.
// ─────────────────────────────────────────────────────────────────

// Anti-flapping: nº de ticks consecutivos en el nuevo estado antes de emitir.
const CONFIRM_TICKS = 2;

// ── Validadores de configuración ─────────────────────────────────

// Token de BotFather: "<id numérico>:<hash de 30+ chars url-safe>"
const TELEGRAM_TOKEN_RE = /^\d+:[A-Za-z0-9_-]{30,}$/;
function isValidTelegramToken(t) {
  return typeof t === 'string' && TELEGRAM_TOKEN_RE.test(t.trim());
}

// Chat ID: entero (negativo en grupos/supergrupos)
function isValidChatId(id) {
  if (id === null || id === undefined) return false;
  return /^-?\d+$/.test(String(id).trim());
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidSmtpConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return false;
  if (typeof cfg.host !== 'string' || !cfg.host.trim() || /\s/.test(cfg.host.trim())) return false;
  const port = Number(cfg.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  if (typeof cfg.from !== 'string' || !EMAIL_RE.test(cfg.from)) return false;
  if (typeof cfg.to !== 'string' || !EMAIL_RE.test(cfg.to)) return false;
  return true;
}

// ── Claves de recurso para notify_state ──────────────────────────

const resourceKey = {
  disk: () => 'disk',
  service: (name) => `service:${name}`,
  container: (name) => `container:${name}`,
};

module.exports = {
  CONFIRM_TICKS,
  isValidTelegramToken,
  isValidChatId,
  isValidSmtpConfig,
  resourceKey,
};
```

- [ ] **Step 4: Ejecutar y ver que pasa**

```bash
node --test backend/test/notifications.test.js
```

Expected: PASS (todos).

- [ ] **Step 5: Commit**

```bash
git add backend/lib/notifications.js backend/test/notifications.test.js
git commit -m "feat(notificaciones): validadores puros y claves de recurso"
```

---

### Task 3: Helpers puros — transiciones de estado (applyTick)

**Files:**
- Modify: `backend/lib/notifications.js`
- Modify: `backend/test/notifications.test.js`

**Interfaces:**
- Consumes: `CONFIRM_TICKS` (Task 2).
- Produces: `applyTick(prev, currentStatus, now) → { next, event }` donde:
  - `prev`: `null` o `{ status:'ok'|'down', pending_status:string|null, pending_count:number, since:string|null, notified:0|1 }`
  - `currentStatus`: `'ok' | 'down'`; `now`: string ISO.
  - `event`: `null | 'down' | 'recovered'`. Cuando `event !== null`, `next.notified === 0` (el monitor lo pone a 1 tras entregar).

- [ ] **Step 1: Añadir los tests que fallan**

Añade al final de `backend/test/notifications.test.js`:

```js
// ── applyTick: transiciones + anti-flapping + reintento ──────────

const NOW = '2026-07-11T12:00:00.000Z';
const okState = { status: 'ok', pending_status: null, pending_count: 0, since: NOW, notified: 1 };
const downState = { status: 'down', pending_status: null, pending_count: 0, since: NOW, notified: 1 };

test('applyTick: recurso nuevo adopta el estado SIN notificar (primer avistamiento)', () => {
  const down = ntf.applyTick(null, 'down', NOW);
  assert.strictEqual(down.event, null);
  assert.strictEqual(down.next.status, 'down');
  assert.strictEqual(down.next.notified, 1);
  const okr = ntf.applyTick(null, 'ok', NOW);
  assert.strictEqual(okr.event, null);
  assert.strictEqual(okr.next.status, 'ok');
});

test('applyTick: ok→down requiere 2 ticks consecutivos', () => {
  const t1 = ntf.applyTick(okState, 'down', NOW);
  assert.strictEqual(t1.event, null, 'primer tick: aún no');
  assert.strictEqual(t1.next.status, 'ok', 'el estado confirmado no cambia todavía');
  assert.strictEqual(t1.next.pending_status, 'down');
  assert.strictEqual(t1.next.pending_count, 1);

  const t2 = ntf.applyTick(t1.next, 'down', NOW);
  assert.strictEqual(t2.event, 'down', 'segundo tick consecutivo: emite');
  assert.strictEqual(t2.next.status, 'down');
  assert.strictEqual(t2.next.pending_status, null);
  assert.strictEqual(t2.next.notified, 0, 'queda pendiente de entrega hasta que el monitor confirme');
});

test('applyTick: flapping suprimido (ok→down→ok no emite nada)', () => {
  const t1 = ntf.applyTick(okState, 'down', NOW);
  const t2 = ntf.applyTick(t1.next, 'ok', NOW);
  assert.strictEqual(t2.event, null);
  assert.strictEqual(t2.next.status, 'ok');
  assert.strictEqual(t2.next.pending_status, null, 'el pendiente se resetea');
  assert.strictEqual(t2.next.pending_count, 0);
});

test('applyTick: down→ok (2 ticks) emite recovered', () => {
  const t1 = ntf.applyTick(downState, 'ok', NOW);
  assert.strictEqual(t1.event, null);
  const t2 = ntf.applyTick(t1.next, 'ok', NOW);
  assert.strictEqual(t2.event, 'recovered');
  assert.strictEqual(t2.next.status, 'ok');
  assert.strictEqual(t2.next.notified, 0);
});

test('applyTick: estado estable no emite y no toca el estado', () => {
  const r = ntf.applyTick(okState, 'ok', NOW);
  assert.strictEqual(r.event, null);
  assert.deepStrictEqual(r.next, okState);
});

test('applyTick: notified=0 con estado estable re-emite (reintento de entrega)', () => {
  const unsent = { ...downState, notified: 0 };
  const r = ntf.applyTick(unsent, 'down', NOW);
  assert.strictEqual(r.event, 'down', 're-emite el evento no entregado');
  assert.strictEqual(r.next.notified, 0);
  const unsentOk = { ...okState, notified: 0 };
  const r2 = ntf.applyTick(unsentOk, 'ok', NOW);
  assert.strictEqual(r2.event, 'recovered');
});

test('applyTick: al confirmar el cambio, since se actualiza al now del tick', () => {
  const LATER = '2026-07-11T13:00:00.000Z';
  const t1 = ntf.applyTick(okState, 'down', LATER);
  const t2 = ntf.applyTick(t1.next, 'down', LATER);
  assert.strictEqual(t2.next.since, LATER);
});
```

- [ ] **Step 2: Ejecutar y ver que falla**

```bash
node --test backend/test/notifications.test.js
```

Expected: FAIL — `ntf.applyTick is not a function`.

- [ ] **Step 3: Implementar applyTick**

Añade a `backend/lib/notifications.js`, antes del `module.exports`:

```js
// ── Transiciones de estado (anti-flapping + reintento) ───────────
//
// applyTick(prev, currentStatus, now) → { next, event }
//   - prev: fila de notify_state (o null si el recurso es nuevo).
//   - currentStatus: 'ok' | 'down' según el chequeo de este tick.
//   - event: null | 'down' | 'recovered'. Si emite, next.notified=0 y
//     el monitor lo pondrá a 1 cuando algún canal entregue.
//
// Reglas:
//   1. Recurso nuevo: adopta el estado sin notificar (evita spam en
//      instalaciones con servicios parados a propósito).
//   2. Cambio de estado: exige CONFIRM_TICKS ticks consecutivos
//      (anti-flapping: reiniciar nginx desde el panel no notifica).
//   3. Estado estable con notified=0: re-emite (la entrega falló en
//      un tick anterior y no se puede perder el aviso).

function applyTick(prev, currentStatus, now) {
  // 1. Primer avistamiento
  if (!prev) {
    return {
      next: { status: currentStatus, pending_status: null, pending_count: 0, since: now, notified: 1 },
      event: null,
    };
  }

  if (currentStatus === prev.status) {
    // 3. Reintento de entrega pendiente
    if (!prev.notified) {
      return { next: { ...prev, notified: 0 }, event: prev.status === 'down' ? 'down' : 'recovered' };
    }
    // Flapping suprimido: había un cambio a medio confirmar que no se consolidó
    if (prev.pending_status) {
      return { next: { ...prev, pending_status: null, pending_count: 0 }, event: null };
    }
    return { next: prev, event: null };
  }

  // 2. Cambio respecto al estado confirmado: contar confirmaciones
  const count = prev.pending_status === currentStatus ? prev.pending_count + 1 : 1;
  if (count >= CONFIRM_TICKS) {
    return {
      next: { status: currentStatus, pending_status: null, pending_count: 0, since: now, notified: 0 },
      event: currentStatus === 'down' ? 'down' : 'recovered',
    };
  }
  return { next: { ...prev, pending_status: currentStatus, pending_count: count }, event: null };
}
```

Y añade `applyTick` al `module.exports`:

```js
module.exports = {
  CONFIRM_TICKS,
  isValidTelegramToken,
  isValidChatId,
  isValidSmtpConfig,
  resourceKey,
  applyTick,
};
```

- [ ] **Step 4: Ejecutar y ver que pasa**

```bash
node --test backend/test/notifications.test.js
```

Expected: PASS (todos).

- [ ] **Step 5: Commit**

```bash
git add backend/lib/notifications.js backend/test/notifications.test.js
git commit -m "feat(notificaciones): lógica pura de transiciones con anti-flapping y reintento"
```

---

### Task 4: Helpers puros — constructores de eventos y mensajes

**Files:**
- Modify: `backend/lib/notifications.js`
- Modify: `backend/test/notifications.test.js`

**Interfaces:**
- Consumes: `resourceKey` (Task 2).
- Produces (objeto evento común `ev = { kind, hostname, title, detail, since }` con `kind ∈ 'down'|'recovered'|'security'|'test'`):
  - `buildStatusEvent({ key, event, hostname, since, detail }) → ev`
  - `buildSecurityEvent(hostname, title, detail) → ev`
  - `buildTestEvent(hostname) → ev`
  - `buildTelegramMessage(ev) → string`
  - `buildEmailMessage(ev) → { subject, text }`

- [ ] **Step 1: Añadir los tests que fallan**

Añade al final de `backend/test/notifications.test.js`:

```js
// ── Constructores de eventos y mensajes ──────────────────────────

test('buildStatusEvent: servicio caído y recuperado', () => {
  const down = ntf.buildStatusEvent({ key: 'service:nginx', event: 'down', hostname: 'mi-vps', since: NOW, detail: null });
  assert.strictEqual(down.kind, 'down');
  assert.strictEqual(down.hostname, 'mi-vps');
  assert.strictEqual(down.title, 'Servicio nginx caído');
  const up = ntf.buildStatusEvent({ key: 'service:nginx', event: 'recovered', hostname: 'mi-vps', since: NOW, detail: null });
  assert.strictEqual(up.title, 'Servicio nginx recuperado');
});

test('buildStatusEvent: contenedor y disco', () => {
  const c = ntf.buildStatusEvent({ key: 'container:txpl-n8n', event: 'down', hostname: 'vps', since: NOW, detail: null });
  assert.strictEqual(c.title, 'Contenedor txpl-n8n caído');
  const d = ntf.buildStatusEvent({ key: 'disk', event: 'down', hostname: 'vps', since: NOW, detail: 'Uso: 93% (umbral 90%)' });
  assert.strictEqual(d.title, 'Disco por encima del umbral');
  assert.strictEqual(d.detail, 'Uso: 93% (umbral 90%)');
  const dr = ntf.buildStatusEvent({ key: 'disk', event: 'recovered', hostname: 'vps', since: NOW, detail: null });
  assert.strictEqual(dr.title, 'Disco de nuevo bajo el umbral');
});

test('buildSecurityEvent y buildTestEvent', () => {
  const s = ntf.buildSecurityEvent('vps', 'Bloqueo por fuerza bruta', 'IP 1.2.3.4 bloqueada 15 min');
  assert.strictEqual(s.kind, 'security');
  assert.strictEqual(s.title, 'Bloqueo por fuerza bruta');
  assert.strictEqual(s.since, null);
  const t = ntf.buildTestEvent('vps');
  assert.strictEqual(t.kind, 'test');
  assert.ok(t.title.length > 0);
});

test('buildTelegramMessage: emoji + hostname + título + detalle + desde', () => {
  const ev = ntf.buildStatusEvent({ key: 'service:nginx', event: 'down', hostname: 'mi-vps', since: NOW, detail: null });
  const text = ntf.buildTelegramMessage(ev);
  assert.ok(text.startsWith('🔴 [mi-vps] Servicio nginx caído'), text);
  assert.ok(text.includes('Desde:'), 'incluye la marca temporal');
  const up = ntf.buildTelegramMessage({ ...ev, kind: 'recovered', title: 'Servicio nginx recuperado' });
  assert.ok(up.startsWith('✅ '));
  const sec = ntf.buildTelegramMessage(ntf.buildSecurityEvent('vps', 'IP nueva', 'admin desde 1.2.3.4'));
  assert.ok(sec.startsWith('🛡️ [vps] IP nueva'));
  assert.ok(sec.includes('admin desde 1.2.3.4'));
  assert.ok(!sec.includes('Desde:'), 'los eventos puntuales no llevan "Desde:"');
});

test('buildEmailMessage: subject = línea de Telegram, body multilínea con firma', () => {
  const ev = ntf.buildStatusEvent({ key: 'disk', event: 'down', hostname: 'vps', since: NOW, detail: 'Uso: 93% (umbral 90%)' });
  const { subject, text } = ntf.buildEmailMessage(ev);
  assert.strictEqual(subject, '🔴 [vps] Disco por encima del umbral');
  assert.ok(text.includes('Uso: 93% (umbral 90%)'));
  assert.ok(text.includes('— TecXPaneL'));
});
```

- [ ] **Step 2: Ejecutar y ver que falla**

```bash
node --test backend/test/notifications.test.js
```

Expected: FAIL — `ntf.buildStatusEvent is not a function`.

- [ ] **Step 3: Implementar los constructores**

Añade a `backend/lib/notifications.js`, antes del `module.exports`:

```js
// ── Constructores de eventos y mensajes ──────────────────────────

const EVENT_EMOJI = { down: '🔴', recovered: '✅', security: '🛡️', test: '🔔' };

// Marca temporal legible; los tests no asertan el formato exacto
// (depende del ICU del sistema), solo que aparece tras "Desde:".
function fmtTime(iso) {
  try { return new Date(iso).toLocaleString('es-ES', { hour12: false }); }
  catch (_) { return String(iso); }
}

// Evento de estado a partir de la clave de recurso.
function buildStatusEvent({ key, event, hostname, since, detail }) {
  const [type, name] = key.includes(':') ? key.split(':') : [key, null];
  let title;
  if (type === 'disk') {
    title = event === 'down' ? 'Disco por encima del umbral' : 'Disco de nuevo bajo el umbral';
  } else if (type === 'service') {
    title = `Servicio ${name} ${event === 'down' ? 'caído' : 'recuperado'}`;
  } else {
    title = `Contenedor ${name} ${event === 'down' ? 'caído' : 'recuperado'}`;
  }
  return { kind: event, hostname, title, detail: detail || null, since: since || null };
}

// Evento puntual de seguridad (sin estado ni recuperación).
function buildSecurityEvent(hostname, title, detail) {
  return { kind: 'security', hostname, title, detail: detail || null, since: null };
}

// Evento del botón "Enviar prueba".
function buildTestEvent(hostname) {
  return {
    kind: 'test',
    hostname,
    title: 'Notificación de prueba de TecXPaneL',
    detail: 'Si lees esto, el canal funciona correctamente.',
    since: null,
  };
}

function buildTelegramMessage(ev) {
  const emoji = EVENT_EMOJI[ev.kind] || '🔔';
  let text = `${emoji} [${ev.hostname}] ${ev.title}`;
  if (ev.detail) text += `\n${ev.detail}`;
  if (ev.since) text += `\nDesde: ${fmtTime(ev.since)}`;
  return text;
}

function buildEmailMessage(ev) {
  const emoji = EVENT_EMOJI[ev.kind] || '🔔';
  const subject = `${emoji} [${ev.hostname}] ${ev.title}`;
  const lines = [ev.title];
  if (ev.detail) lines.push(ev.detail);
  if (ev.since) lines.push(`Desde: ${fmtTime(ev.since)}`);
  lines.push('', '— TecXPaneL');
  return { subject, text: lines.join('\n') };
}
```

Y amplía el `module.exports`:

```js
module.exports = {
  CONFIRM_TICKS,
  isValidTelegramToken,
  isValidChatId,
  isValidSmtpConfig,
  resourceKey,
  applyTick,
  buildStatusEvent,
  buildSecurityEvent,
  buildTestEvent,
  buildTelegramMessage,
  buildEmailMessage,
};
```

- [ ] **Step 4: Ejecutar y ver que pasa**

```bash
node --test backend/test/notifications.test.js
npm test
```

Expected: PASS (el archivo nuevo y la suite completa).

- [ ] **Step 5: Commit**

```bash
git add backend/lib/notifications.js backend/test/notifications.test.js
git commit -m "feat(notificaciones): constructores puros de eventos y mensajes"
```

---

### Task 5: Base de datos — tablas y queries

**Files:**
- Modify: `backend/database.js`

**Interfaces:**
- Produces (usadas por Tasks 6–9):
  - Tabla `notify_config` (fila única id=1) y tabla `notify_state` (PK `key`).
  - `queries.getNotifyConfig.get() → row|undefined`
  - `queries.upsertNotifyConfig.run({...16 campos...})`
  - `queries.getNotifyState.get(key) → row|undefined`
  - `queries.upsertNotifyState.run({ key, status, pending_status, pending_count, since, notified })`
  - `queries.hasLoginFromIp.get(ip) → { c: number }`

- [ ] **Step 1: Añadir las tablas al esquema**

En `backend/database.js`, dentro del `db.exec(...)` del esquema, justo después del bloque `CREATE TABLE IF NOT EXISTS backup_remote (...)` (línea ~174) y antes del backtick de cierre:

```sql
  CREATE TABLE IF NOT EXISTS notify_config (
    id                  INTEGER PRIMARY KEY CHECK (id = 1),
    telegram_enabled    INTEGER NOT NULL DEFAULT 0,
    telegram_token_enc  TEXT,
    telegram_chat_id    TEXT,
    smtp_enabled        INTEGER NOT NULL DEFAULT 0,
    smtp_host           TEXT,
    smtp_port           INTEGER NOT NULL DEFAULT 587,
    smtp_secure         INTEGER NOT NULL DEFAULT 0,
    smtp_user           TEXT,
    smtp_pass_enc       TEXT,
    smtp_from           TEXT,
    smtp_to             TEXT,
    ev_disk_enabled     INTEGER NOT NULL DEFAULT 1,
    ev_disk_threshold   INTEGER NOT NULL DEFAULT 90,
    ev_services_enabled INTEGER NOT NULL DEFAULT 1,
    ev_security_enabled INTEGER NOT NULL DEFAULT 1,
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS notify_state (
    key            TEXT PRIMARY KEY,
    status         TEXT NOT NULL,
    pending_status TEXT,
    pending_count  INTEGER NOT NULL DEFAULT 0,
    since          TEXT,
    notified       INTEGER NOT NULL DEFAULT 1,
    updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
  );
```

- [ ] **Step 2: Añadir las queries preparadas**

En el objeto `queries` de `backend/database.js`, después del bloque de n8n (línea ~301):

```js
  // ── Notificaciones ─────────────────────────────────────────────
  getNotifyConfig: db.prepare('SELECT * FROM notify_config WHERE id = 1'),
  upsertNotifyConfig: db.prepare(`
    INSERT INTO notify_config (id, telegram_enabled, telegram_token_enc, telegram_chat_id,
      smtp_enabled, smtp_host, smtp_port, smtp_secure, smtp_user, smtp_pass_enc, smtp_from, smtp_to,
      ev_disk_enabled, ev_disk_threshold, ev_services_enabled, ev_security_enabled, updated_at)
    VALUES (1, @telegram_enabled, @telegram_token_enc, @telegram_chat_id,
      @smtp_enabled, @smtp_host, @smtp_port, @smtp_secure, @smtp_user, @smtp_pass_enc, @smtp_from, @smtp_to,
      @ev_disk_enabled, @ev_disk_threshold, @ev_services_enabled, @ev_security_enabled, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      telegram_enabled = excluded.telegram_enabled,
      telegram_token_enc = excluded.telegram_token_enc,
      telegram_chat_id = excluded.telegram_chat_id,
      smtp_enabled = excluded.smtp_enabled,
      smtp_host = excluded.smtp_host,
      smtp_port = excluded.smtp_port,
      smtp_secure = excluded.smtp_secure,
      smtp_user = excluded.smtp_user,
      smtp_pass_enc = excluded.smtp_pass_enc,
      smtp_from = excluded.smtp_from,
      smtp_to = excluded.smtp_to,
      ev_disk_enabled = excluded.ev_disk_enabled,
      ev_disk_threshold = excluded.ev_disk_threshold,
      ev_services_enabled = excluded.ev_services_enabled,
      ev_security_enabled = excluded.ev_security_enabled,
      updated_at = excluded.updated_at
  `),
  getNotifyState: db.prepare('SELECT * FROM notify_state WHERE key = ?'),
  upsertNotifyState: db.prepare(`
    INSERT INTO notify_state (key, status, pending_status, pending_count, since, notified, updated_at)
    VALUES (@key, @status, @pending_status, @pending_count, @since, @notified, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      status = excluded.status,
      pending_status = excluded.pending_status,
      pending_count = excluded.pending_count,
      since = excluded.since,
      notified = excluded.notified,
      updated_at = excluded.updated_at
  `),
  // ¿Hubo ya un login OK desde esta IP? (para el aviso de "IP nueva")
  hasLoginFromIp: db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE action = 'login.ok' AND ip = ?"),
```

- [ ] **Step 3: Smoke test del esquema y las queries**

```bash
node -e "
const { queries } = require('./backend/database');
console.log('config vacía:', queries.getNotifyConfig.get());
queries.upsertNotifyConfig.run({ telegram_enabled: 1, telegram_token_enc: 'x', telegram_chat_id: '1',
  smtp_enabled: 0, smtp_host: null, smtp_port: 587, smtp_secure: 0, smtp_user: null, smtp_pass_enc: null,
  smtp_from: null, smtp_to: null, ev_disk_enabled: 1, ev_disk_threshold: 90, ev_services_enabled: 1, ev_security_enabled: 1 });
console.log('tras upsert:', queries.getNotifyConfig.get().telegram_enabled === 1 ? 'OK' : 'FALLO');
queries.upsertNotifyState.run({ key: 'disk', status: 'ok', pending_status: null, pending_count: 0, since: null, notified: 1 });
console.log('estado:', queries.getNotifyState.get('disk').status);
console.log('hasLoginFromIp:', queries.hasLoginFromIp.get('1.2.3.4').c);
"
npm test
```

Expected: `OK`, `ok`, un número, y la suite PASS. (Esto escribe en la DB local de desarrollo `data/txpl.db`, que está gitignorada — sin efectos.)

- [ ] **Step 4: Commit**

```bash
git add backend/database.js
git commit -m "feat(notificaciones): tablas notify_config/notify_state y queries preparadas"
```

---

### Task 6: Executor de efectos (Telegram + SMTP)

**Files:**
- Create: `backend/lib/notifyExecutor.js`

**Interfaces:**
- Consumes: `queries.getNotifyConfig` (Task 5), `decryptSecret` de `lib/crypto.js`, `buildTelegramMessage`/`buildEmailMessage` (Task 4).
- Produces (usadas por Tasks 7–9):
  - `dispatch(ev) → Promise<boolean>` — envía a todos los canales activos; `true` si al menos uno entregó; **nunca lanza**.
  - `sendTelegram({ token, chatId }, text) → Promise<void>` — lanza con `e.http = 502` si Telegram rechaza.
  - `sendEmail({ host, port, secure, user, pass, from, to }, subject, text) → Promise<void>`
  - `detectChatId(token) → Promise<{ chatId, name }>` — lanza con `e.http` (404 sin mensajes, 502 API).

- [ ] **Step 1: Implementar el executor**

Crea `backend/lib/notifyExecutor.js`:

```js
'use strict';

// ─────────────────────────────────────────────────────────────────
//  notifyExecutor.js — EFECTOS de notificaciones.
//  Lee la fila única notify_config, descifra los secretos y envía
//  por Telegram (fetch a api.telegram.org) y/o email (nodemailer).
//  Usable desde el monitor, las rutas y (futuro) backup-runner.
//  Los errores se loguean SIN token ni contraseña.
// ─────────────────────────────────────────────────────────────────

const nodemailer = require('nodemailer');
const { queries } = require('../database');
const { decryptSecret } = require('./crypto');
const { buildTelegramMessage, buildEmailMessage } = require('./notifications');

const TG_TIMEOUT_MS = 10_000;

function safeDecrypt(v) {
  try { return decryptSecret(v); } catch (_) { return null; }
}

// Config efectiva con secretos descifrados (o null si no hay fila).
function loadConfig() {
  const row = queries.getNotifyConfig.get();
  if (!row) return null;
  return {
    ...row,
    telegram_token: row.telegram_token_enc ? safeDecrypt(row.telegram_token_enc) : null,
    smtp_pass: row.smtp_pass_enc ? safeDecrypt(row.smtp_pass_enc) : null,
  };
}

// Envía un mensaje por la API de Telegram. Sin proceso bot: una petición HTTPS.
async function sendTelegram({ token, chatId }, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(TG_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    const e = new Error(data.description || `HTTP ${res.status}`);
    e.http = 502;
    throw e;
  }
}

// Envía un email por SMTP (transporte efímero: no mantenemos conexiones vivas).
async function sendEmail(cfg, subject, text) {
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: Number(cfg.port),
    secure: !!cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass || '' } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  await transporter.sendMail({ from: cfg.from, to: cfg.to, subject, text });
}

// dispatch(ev): envía a todos los canales activos. Devuelve true si al menos
// uno entregó. Nunca lanza: el que llama no debe romperse por un canal caído.
async function dispatch(ev) {
  const cfg = loadConfig();
  if (!cfg) return false;
  let delivered = false;

  if (cfg.telegram_enabled && cfg.telegram_token && cfg.telegram_chat_id) {
    try {
      await sendTelegram({ token: cfg.telegram_token, chatId: cfg.telegram_chat_id }, buildTelegramMessage(ev));
      delivered = true;
    } catch (e) {
      console.error('[notify] telegram:', e.message);
    }
  }

  if (cfg.smtp_enabled && cfg.smtp_host && cfg.smtp_to) {
    const { subject, text } = buildEmailMessage(ev);
    try {
      await sendEmail({
        host: cfg.smtp_host, port: cfg.smtp_port, secure: cfg.smtp_secure,
        user: cfg.smtp_user, pass: cfg.smtp_pass, from: cfg.smtp_from, to: cfg.smtp_to,
      }, subject, text);
      delivered = true;
    } catch (e) {
      console.error('[notify] email:', e.message);
    }
  }

  return delivered;
}

// detectChatId(token): tras pulsar /start en el bot, getUpdates trae el chat.
async function detectChatId(token) {
  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
    signal: AbortSignal.timeout(TG_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    const e = new Error(data.description || 'Telegram rechazó el token');
    e.http = 502;
    throw e;
  }
  const withChat = (data.result || []).slice().reverse().find((u) => u.message?.chat?.id);
  if (!withChat) {
    const e = new Error('No hay mensajes: abre tu bot en Telegram, pulsa /start y reintenta.');
    e.http = 404;
    throw e;
  }
  const chat = withChat.message.chat;
  return { chatId: String(chat.id), name: chat.first_name || chat.username || '' };
}

module.exports = { loadConfig, dispatch, sendTelegram, sendEmail, detectChatId };
```

- [ ] **Step 2: Smoke test (carga y dispatch sin config activa)**

```bash
node -e "
const ex = require('./backend/lib/notifyExecutor');
for (const fn of ['loadConfig','dispatch','sendTelegram','sendEmail','detectChatId'])
  if (typeof ex[fn] !== 'function') throw new Error('falta ' + fn);
ex.dispatch({ kind:'test', hostname:'dev', title:'x', detail:null, since:null })
  .then((d) => console.log('dispatch sin canales →', d === false ? 'OK (false)' : 'FALLO'));
"
```

Expected: `OK (false)` — con la config del smoke de Task 5 (telegram_enabled=1 pero `token_enc='x'` indescifrable), `safeDecrypt` devuelve null, el canal se omite y `dispatch` devuelve `false` sin lanzar.

- [ ] **Step 3: Commit**

```bash
git add backend/lib/notifyExecutor.js
git commit -m "feat(notificaciones): executor de envío por Telegram y SMTP"
```

---

### Task 7: El monitor (vigilante de 60 s)

**Files:**
- Create: `backend/lib/monitor.js`
- Modify: `backend/server.js` (arranque del monitor)

**Interfaces:**
- Consumes: `applyTick`, `resourceKey`, `buildStatusEvent` (Tasks 3–4); `dispatch` (Task 6); `queries.getNotifyConfig/getNotifyState/upsertNotifyState` (Task 5); `runSafe` de `lib/helpers.js`.
- Produces: `startMonitor()` — llamado una vez desde `server.js`. Exporta también `tick()` para poder forzar un chequeo a mano en desarrollo.

- [ ] **Step 1: Implementar el monitor**

Crea `backend/lib/monitor.js`:

```js
'use strict';

// ─────────────────────────────────────────────────────────────────
//  monitor.js — El vigilante de notificaciones.
//  Cada 60 s comprueba disco, servicios systemd y contenedores
//  txpl-*, pasa los estados por la lógica pura de transiciones
//  (applyTick) y despacha los eventos por el executor.
//  Corre dentro del proceso del panel (PM2 lo mantiene vivo);
//  el tick de stats del WebSocket NO sirve porque solo corre con
//  el dashboard abierto.
// ─────────────────────────────────────────────────────────────────

const os = require('os');
const http = require('http');
const { queries } = require('../database');
const { runSafe } = require('./helpers');
const { applyTick, resourceKey, buildStatusEvent } = require('./notifications');
const { dispatch } = require('./notifyExecutor');

const TICK_MS = 60_000;
const WATCHED_SERVICES = ['nginx', 'mysql', 'postgresql', 'redis', 'ssh'];
const DOCKER_SOCK = '/var/run/docker.sock';

let busy = false; // guard anti-solapamiento: nunca dos ticks a la vez

// GET al socket de Docker (mismo patrón mínimo que docker.js / n8n.js).
// Devuelve null en cualquier error (Docker no instalado, socket caído…).
function dockerGet(path) {
  return new Promise((resolve) => {
    const req = http.request({ socketPath: DOCKER_SOCK, path, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (_) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// % de uso de la partición raíz (mismo df que routes/system.js).
// Devuelve [] si df no está disponible (Windows/dev) o no hay raíz.
async function checkDisk(threshold) {
  const r = await runSafe('df', ['-PB1', '-x', 'tmpfs', '-x', 'devtmpfs']);
  const out = (r.stdout || '').trim();
  if (!r.ok || !out) return [];
  const root = out.split('\n').slice(1)
    .map((l) => l.trim().split(/\s+/))
    .find((c) => c[5] === '/');
  if (!root) return [];
  const percent = parseInt(root[4], 10);
  if (!Number.isInteger(percent)) return [];
  return [{
    key: resourceKey.disk(),
    status: percent >= threshold ? 'down' : 'ok',
    detail: `Uso: ${percent}% (umbral ${threshold}%)`,
  }];
}

// Servicios systemd de la lista del dashboard. Si systemctl no existe
// (Windows/dev) o no devuelve nada, se omite ese servicio sin romper.
// Nota: un servicio nunca instalado se adopta como 'down' en silencio
// (primer avistamiento sin notificar) y no vuelve a molestar.
async function checkServices() {
  const result = [];
  for (const name of WATCHED_SERVICES) {
    const r = await runSafe('systemctl', ['is-active', name]);
    const out = (r.stdout || '').trim();
    if (!out) continue;
    result.push({
      key: resourceKey.service(name),
      status: out === 'active' ? 'ok' : 'down',
      detail: null,
    });
  }
  return result;
}

// Contenedores gestionados por el panel (txpl-*): n8n, mail…
async function checkContainers() {
  const list = await dockerGet('/containers/json?all=1');
  if (!Array.isArray(list)) return [];
  const result = [];
  for (const c of list) {
    const name = (c.Names?.[0] || '').replace(/^\//, '');
    if (!name.startsWith('txpl-')) continue;
    result.push({
      key: resourceKey.container(name),
      status: c.State === 'running' ? 'ok' : 'down',
      detail: null,
    });
  }
  return result;
}

// Un tick completo: recoger → transicionar → despachar → persistir.
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const cfg = queries.getNotifyConfig.get();
    if (!cfg || (!cfg.telegram_enabled && !cfg.smtp_enabled)) return; // coste cero sin config
    const hostname = os.hostname();
    const now = new Date().toISOString();

    const checks = [];
    if (cfg.ev_disk_enabled) checks.push(...await checkDisk(cfg.ev_disk_threshold));
    if (cfg.ev_services_enabled) {
      checks.push(...await checkServices());
      checks.push(...await checkContainers());
    }

    for (const c of checks) {
      const prev = queries.getNotifyState.get(c.key) || null;
      const { next, event } = applyTick(prev, c.status, now);
      let notified = next.notified;
      if (event) {
        const ev = buildStatusEvent({ key: c.key, event, hostname, since: next.since, detail: c.detail });
        notified = (await dispatch(ev)) ? 1 : 0; // si nadie entrega, se reintenta al tick siguiente
      }
      queries.upsertNotifyState.run({
        key: c.key,
        status: next.status,
        pending_status: next.pending_status,
        pending_count: next.pending_count,
        since: next.since,
        notified,
      });
    }
  } catch (e) {
    console.error('[monitor]', e.message);
  } finally {
    busy = false;
  }
}

// Arranca el vigilante. unref(): el interval no impide el apagado limpio.
function startMonitor() {
  setInterval(tick, TICK_MS).unref();
  console.log('[txpl] Monitor de notificaciones activo (cada 60 s)');
}

module.exports = { startMonitor, tick };
```

- [ ] **Step 2: Arrancar el monitor en server.js**

En `backend/server.js`, localiza:

```js
const server = http.createServer(app);
setupWebSockets(server, verifyToken);
```

y añade justo después:

```js
// Monitor de notificaciones (disco/servicios/contenedores, cada 60 s).
// Sin config guardada no hace nada; ver lib/monitor.js.
const { startMonitor } = require('./lib/monitor');
startMonitor();
```

- [ ] **Step 3: Smoke test — arranca y un tick manual no revienta**

```bash
node -e "
process.env.TXPL_DIR = './'; process.env.FRONTEND_DIR = './frontend';
const { tick } = require('./backend/lib/monitor');
tick().then(() => console.log('tick OK'));
"
npm test
```

Expected: `tick OK` (en macOS/dev los chequeos se omiten limpiamente) y suite PASS.

- [ ] **Step 4: Commit**

```bash
git add backend/lib/monitor.js backend/server.js
git commit -m "feat(notificaciones): monitor de disco, servicios y contenedores cada 60 s"
```

---

### Task 8: Rutas HTTP + montaje

**Files:**
- Create: `backend/routes/notifications.js`
- Modify: `backend/server.js` (montar el router)

**Interfaces:**
- Consumes: validadores y builders (Tasks 2 y 4), `sendTelegram`/`sendEmail`/`detectChatId` (Task 6), `queries` (Task 5), `encryptSecret`/`decryptSecret`, `ok`/`fail`/`wrap`/`clientIp`, `audit`.
- Produces (consumidas por el frontend, Task 10):
  - `GET  /api/notifications/config` → `{ success, configured, ...campos sin secretos, telegram_token_set, smtp_pass_set }`
  - `POST /api/notifications/config` (body plano, ver código) → `{ success, saved }`
  - `POST /api/notifications/test/telegram` → `{ success, sent }` (usa token del body o el guardado)
  - `POST /api/notifications/test/email` → `{ success, sent }`
  - `POST /api/notifications/telegram/detect-chat` → `{ success, chatId, name }`

- [ ] **Step 1: Implementar el router**

Crea `backend/routes/notifications.js`:

```js
'use strict';

// ─────────────────────────────────────────────────────────────────
//  notifications.js — Rutas de configuración de notificaciones.
//  Config en fila única (notify_config) con secretos cifrados.
//  Los endpoints /test operan con la config del body (probar antes
//  de guardar), con fallback a los secretos ya guardados.
// ─────────────────────────────────────────────────────────────────

const os = require('os');
const express = require('express');
const { ok, fail, clientIp, wrap } = require('../lib/helpers');
const { encryptSecret, decryptSecret } = require('../lib/crypto');
const { queries, audit } = require('../database');
const {
  isValidTelegramToken, isValidChatId, isValidSmtpConfig,
  buildTestEvent, buildTelegramMessage, buildEmailMessage,
} = require('../lib/notifications');
const { sendTelegram, sendEmail, detectChatId } = require('../lib/notifyExecutor');

const router = express.Router();

// Token del body o, si viene vacío, el guardado (descifrado). Null si no hay.
function resolveToken(bodyToken) {
  const t = (bodyToken || '').trim();
  if (t) return t;
  const row = queries.getNotifyConfig.get();
  if (!row?.telegram_token_enc) return null;
  try { return decryptSecret(row.telegram_token_enc); } catch (_) { return null; }
}

// Contraseña SMTP del body o la guardada.
function resolveSmtpPass(bodyPass) {
  if (typeof bodyPass === 'string' && bodyPass) return bodyPass;
  const row = queries.getNotifyConfig.get();
  if (!row?.smtp_pass_enc) return null;
  try { return decryptSecret(row.smtp_pass_enc); } catch (_) { return null; }
}

// GET /config — config actual SIN secretos (solo flags de "hay secreto").
router.get('/config', wrap(async (req, res) => {
  const row = queries.getNotifyConfig.get();
  if (!row) return ok(res, { configured: false });
  const { telegram_token_enc, smtp_pass_enc, ...pub } = row;
  ok(res, { configured: true, ...pub, telegram_token_set: !!telegram_token_enc, smtp_pass_set: !!smtp_pass_enc });
}));

// POST /config — valida y guarda. Token/contraseña vacíos = conservar los guardados.
router.post('/config', wrap(async (req, res) => {
  const b = req.body || {};
  const prev = queries.getNotifyConfig.get();
  const tgEnabled = b.telegram_enabled ? 1 : 0;
  const smtpEnabled = b.smtp_enabled ? 1 : 0;

  let tokenEnc = prev?.telegram_token_enc || null;
  if (typeof b.telegram_token === 'string' && b.telegram_token.trim()) {
    if (!isValidTelegramToken(b.telegram_token)) return fail(res, 400, 'Token de Telegram no válido (formato de @BotFather: 123456:ABC…)');
    tokenEnc = encryptSecret(b.telegram_token.trim());
  }
  if (tgEnabled) {
    if (!tokenEnc) return fail(res, 400, 'Falta el token del bot de Telegram');
    if (!isValidChatId(b.telegram_chat_id)) return fail(res, 400, 'Chat ID de Telegram no válido (usa "Detectar chat")');
  }

  let passEnc = prev?.smtp_pass_enc || null;
  if (typeof b.smtp_pass === 'string' && b.smtp_pass) passEnc = encryptSecret(b.smtp_pass);
  if (smtpEnabled && !isValidSmtpConfig({ host: b.smtp_host, port: b.smtp_port, from: b.smtp_from, to: b.smtp_to })) {
    return fail(res, 400, 'Config SMTP incompleta: host, puerto (1-65535), remitente y destinatario son obligatorios');
  }

  const th = parseInt(b.ev_disk_threshold, 10);
  queries.upsertNotifyConfig.run({
    telegram_enabled: tgEnabled,
    telegram_token_enc: tokenEnc,
    telegram_chat_id: b.telegram_chat_id ? String(b.telegram_chat_id).trim() : null,
    smtp_enabled: smtpEnabled,
    smtp_host: (b.smtp_host || '').trim() || null,
    smtp_port: parseInt(b.smtp_port, 10) || 587,
    smtp_secure: b.smtp_secure ? 1 : 0,
    smtp_user: (b.smtp_user || '').trim() || null,
    smtp_pass_enc: passEnc,
    smtp_from: (b.smtp_from || '').trim() || null,
    smtp_to: (b.smtp_to || '').trim() || null,
    ev_disk_enabled: b.ev_disk_enabled ? 1 : 0,
    ev_disk_threshold: Number.isInteger(th) && th >= 50 && th <= 99 ? th : 90,
    ev_services_enabled: b.ev_services_enabled ? 1 : 0,
    ev_security_enabled: b.ev_security_enabled ? 1 : 0,
  });
  audit(req.user.username, clientIp(req), 'notify.config', null); // sin secretos en el detalle
  ok(res, { saved: true });
}));

// POST /test/telegram — envía la notificación de prueba con la config del body.
router.post('/test/telegram', wrap(async (req, res) => {
  const b = req.body || {};
  const token = resolveToken(b.telegram_token);
  if (!token || !isValidTelegramToken(token)) return fail(res, 400, 'Token de Telegram no válido');
  if (!isValidChatId(b.telegram_chat_id)) return fail(res, 400, 'Chat ID no válido (usa "Detectar chat")');
  try {
    await sendTelegram({ token, chatId: String(b.telegram_chat_id).trim() }, buildTelegramMessage(buildTestEvent(os.hostname())));
  } catch (e) {
    return fail(res, 502, 'Telegram: ' + e.message);
  }
  ok(res, { sent: true });
}));

// POST /test/email — ídem por SMTP.
router.post('/test/email', wrap(async (req, res) => {
  const b = req.body || {};
  const cfg = { host: (b.smtp_host || '').trim(), port: b.smtp_port, from: (b.smtp_from || '').trim(), to: (b.smtp_to || '').trim() };
  if (!isValidSmtpConfig(cfg)) return fail(res, 400, 'Config SMTP incompleta o no válida');
  const { subject, text } = buildEmailMessage(buildTestEvent(os.hostname()));
  try {
    await sendEmail({
      ...cfg, secure: !!b.smtp_secure,
      user: (b.smtp_user || '').trim() || null,
      pass: resolveSmtpPass(b.smtp_pass),
    }, subject, text);
  } catch (e) {
    return fail(res, 502, 'SMTP: ' + e.message);
  }
  ok(res, { sent: true });
}));

// POST /telegram/detect-chat — autodetecta el chat_id tras pulsar /start.
router.post('/telegram/detect-chat', wrap(async (req, res) => {
  const token = resolveToken(req.body?.telegram_token);
  if (!token || !isValidTelegramToken(token)) return fail(res, 400, 'Introduce primero el token del bot');
  const r = await detectChatId(token); // lanza con e.http (404/502) que wrap respeta
  ok(res, r);
}));

module.exports = router;
```

- [ ] **Step 2: Montar el router en server.js**

En `backend/server.js`, tras la línea `app.use('/api/dns', require('./routes/dns'));`:

```js
app.use('/api/notifications', require('./routes/notifications'));
```

- [ ] **Step 3: Smoke test — el servidor arranca y la ruta exige JWT**

```bash
npm run dev &
sleep 2
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8585/api/notifications/config
kill %1
```

Expected: `401` (la ruta existe y está protegida). El log de arranque muestra `Monitor de notificaciones activo`.

- [ ] **Step 4: Commit**

```bash
git add backend/routes/notifications.js backend/server.js
git commit -m "feat(notificaciones): rutas de config, pruebas de envío y detección de chat"
```

---

### Task 9: Hooks de seguridad en auth.js

**Files:**
- Modify: `backend/routes/auth.js`

**Interfaces:**
- Consumes: `dispatch` (Task 6), `buildSecurityEvent` (Task 4), `queries.getNotifyConfig` y `queries.hasLoginFromIp` (Task 5).
- Produces: notificaciones puntuales `security` en dos puntos del login. Fire-and-forget: **jamás** bloquean ni rompen el login.

- [ ] **Step 1: Añadir imports y el helper de disparo**

En `backend/routes/auth.js`, junto a los imports existentes (tras `const { queries, audit } = require('../database');`):

```js
const os = require('os');
const { buildSecurityEvent } = require('../lib/notifications');
const { dispatch } = require('../lib/notifyExecutor');

// Notificación puntual de seguridad: fire-and-forget, nunca bloquea el login.
function notifySecurity(title, detail) {
  try {
    const cfg = queries.getNotifyConfig.get();
    if (!cfg || !cfg.ev_security_enabled || (!cfg.telegram_enabled && !cfg.smtp_enabled)) return;
    dispatch(buildSecurityEvent(os.hostname(), title, detail)).catch(() => {});
  } catch (_) { /* la notificación jamás tumba el login */ }
}
```

- [ ] **Step 2: Hook de fuerza bruta**

En `recordLoginFail` (dentro de `createAuthRouter`), notifica **solo en el momento exacto del bloqueo** (cruce del umbral, no en cada fallo posterior). Reemplaza:

```js
  function recordLoginFail(ip) {
    const e = loginFails.get(ip) || { count: 0, until: 0 };
    e.count++;
    if (e.count >= LOGIN_MAX_FAILS) e.until = Date.now() + LOGIN_LOCK_MS;
    loginFails.set(ip, e);
  }
```

por:

```js
  function recordLoginFail(ip) {
    const e = loginFails.get(ip) || { count: 0, until: 0 };
    e.count++;
    if (e.count === LOGIN_MAX_FAILS) {
      notifySecurity('Bloqueo por fuerza bruta', `IP ${ip} bloqueada 15 min tras ${LOGIN_MAX_FAILS} intentos fallidos de login`);
    }
    if (e.count >= LOGIN_MAX_FAILS) e.until = Date.now() + LOGIN_LOCK_MS;
    loginFails.set(ip, e);
  }
```

- [ ] **Step 3: Hook de IP nueva en el login OK**

En el handler de `POST /login`, la consulta debe hacerse **antes** de insertar el audit `login.ok` (si no, la IP ya constaría). Reemplaza:

```js
    clearLoginFails(ip);
    const token = jwt.sign({ uid: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: TOKEN_TTL });
    audit(user.username, ip, 'login.ok', null);
```

por:

```js
    clearLoginFails(ip);
    // ¿Primera vez que esta IP inicia sesión con éxito? (consultar ANTES del audit)
    const ipConocida = queries.hasLoginFromIp.get(ip).c > 0;
    const token = jwt.sign({ uid: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: TOKEN_TTL });
    audit(user.username, ip, 'login.ok', null);
    if (!ipConocida) {
      notifySecurity('Inicio de sesión desde IP nueva', `Usuario ${user.username} desde ${ip}`);
    }
```

- [ ] **Step 4: Verificar que el login sigue funcionando**

```bash
npm test
npm run dev &
sleep 2
curl -s -X POST http://localhost:8585/api/auth/login -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"contraseñadeprueba"}' | head -c 120; echo
kill %1
```

Expected: suite PASS y el login devuelve `{"success":true,"token":...}` (con las credenciales del `.env` local). En dev sin config de notificaciones, los hooks son no-op silenciosos.

- [ ] **Step 5: Commit**

```bash
git add backend/routes/auth.js
git commit -m "feat(notificaciones): avisos de fuerza bruta e inicio de sesión desde IP nueva"
```

---

### Task 10: Frontend — tarjeta en Ajustes

**Files:**
- Modify: `frontend/views/pages/settings.html` (nueva tarjeta antes de "Acerca de TecXPaneL")
- Modify: `frontend/js/app.js` (funciones + carga en `loadSettings`)

**Interfaces:**
- Consumes: endpoints de la Task 8; helpers `req(method, path, body)` y `toast(msg, type)` de `app.js`.
- Produces: funciones globales `loadNotifyConfig()`, `saveNotifyConfig()`, `testNotify(channel)`, `detectTgChat()` referenciadas por `onclick` en el HTML.

- [ ] **Step 1: Añadir la tarjeta al HTML**

En `frontend/views/pages/settings.html`, inserta esta tarjeta **antes** del `<div class="card mt-2">` de "Acerca de TecXPaneL":

```html
  <div class="card">
    <div class="card-header">
      <div class="card-title"><i class="ti ti-bell"></i> Notificaciones</div>
    </div>
    <p style="font-size:12px;color:var(--text-secondary);margin-bottom:0.75rem">
      Recibe un aviso cuando algo va mal: disco lleno, servicio caído o eventos de seguridad.
      Un mensaje al aparecer el problema y otro al recuperarse.
    </p>
    <p style="font-size:12px;color:var(--text-secondary);margin-bottom:1rem">
      <i class="ti ti-alert-triangle" style="color:var(--accent)"></i>
      Si el VPS entero se cae, nada dentro de él puede avisarte: para eso usa un monitor
      externo (UptimeRobot, o un Uptime Kuma en otro servidor).
    </p>

    <h4 style="font-size:13px;margin:0.75rem 0 0.5rem"><i class="ti ti-brand-telegram"></i> Telegram</h4>
    <div class="form-group"><label><input type="checkbox" id="ntf-tg-enabled"> Activar avisos por Telegram</label></div>
    <div class="form-group">
      <label>Token del bot (créalo con @BotFather en 2 min)</label>
      <input type="password" id="ntf-tg-token" placeholder="123456:ABC…" autocomplete="off">
    </div>
    <div class="form-group">
      <label>Chat ID (pulsa /start en tu bot y usa Detectar)</label>
      <input type="text" id="ntf-tg-chat" placeholder="123456789">
    </div>
    <button class="btn btn-sm" onclick="detectTgChat()"><i class="ti ti-radar-2"></i> Detectar chat</button>
    <button class="btn btn-sm" onclick="testNotify('telegram')"><i class="ti ti-send"></i> Enviar prueba</button>

    <h4 style="font-size:13px;margin:1.25rem 0 0.5rem"><i class="ti ti-mail"></i> Email (SMTP)</h4>
    <div class="form-group"><label><input type="checkbox" id="ntf-smtp-enabled"> Activar avisos por email</label></div>
    <div class="form-group"><label>Servidor SMTP</label><input type="text" id="ntf-smtp-host" placeholder="smtp.ejemplo.com (o 127.0.0.1 si usas el módulo Correo)"></div>
    <div class="form-group"><label>Puerto</label><input type="number" id="ntf-smtp-port" value="587" min="1" max="65535"></div>
    <div class="form-group"><label><input type="checkbox" id="ntf-smtp-secure"> Conexión TLS directa (puerto 465)</label></div>
    <div class="form-group"><label>Usuario (opcional)</label><input type="text" id="ntf-smtp-user" autocomplete="off"></div>
    <div class="form-group"><label>Contraseña (en Gmail: contraseña de aplicación)</label><input type="password" id="ntf-smtp-pass" autocomplete="new-password"></div>
    <div class="form-group"><label>Remitente</label><input type="email" id="ntf-smtp-from" placeholder="panel@midominio.com"></div>
    <div class="form-group"><label>Destinatario</label><input type="email" id="ntf-smtp-to" placeholder="admin@midominio.com"></div>
    <button class="btn btn-sm" onclick="testNotify('email')"><i class="ti ti-send"></i> Enviar prueba</button>

    <h4 style="font-size:13px;margin:1.25rem 0 0.5rem"><i class="ti ti-bell-ringing"></i> Eventos</h4>
    <div class="form-group">
      <label><input type="checkbox" id="ntf-ev-disk"> Disco por encima del umbral</label>
      <input type="number" id="ntf-ev-disk-th" value="90" min="50" max="99" style="width:80px;margin-left:8px"> %
    </div>
    <div class="form-group"><label><input type="checkbox" id="ntf-ev-services"> Servicio o contenedor caído (y recuperado)</label></div>
    <div class="form-group"><label><input type="checkbox" id="ntf-ev-security"> Seguridad: fuerza bruta e IP nueva</label></div>

    <button class="btn btn-primary" onclick="saveNotifyConfig()"><i class="ti ti-device-floppy"></i> Guardar notificaciones</button>
  </div>
```

- [ ] **Step 2: Añadir las funciones JS**

En `frontend/js/app.js`, junto a las demás funciones de Ajustes (después de `changePassword`):

```js
// ── Notificaciones (Ajustes) ─────────────────────────────────────

// loadNotifyConfig: rellena la tarjeta con la config guardada (sin secretos).
async function loadNotifyConfig() {
  const r = await req('GET', '/notifications/config');
  if (!r?.success || r.configured === false) return;
  document.getElementById('ntf-tg-enabled').checked = !!r.telegram_enabled;
  document.getElementById('ntf-tg-token').placeholder = r.telegram_token_set ? '•••••••• (guardado, escribe para cambiarlo)' : '123456:ABC…';
  document.getElementById('ntf-tg-chat').value = r.telegram_chat_id || '';
  document.getElementById('ntf-smtp-enabled').checked = !!r.smtp_enabled;
  document.getElementById('ntf-smtp-host').value = r.smtp_host || '';
  document.getElementById('ntf-smtp-port').value = r.smtp_port || 587;
  document.getElementById('ntf-smtp-secure').checked = !!r.smtp_secure;
  document.getElementById('ntf-smtp-user').value = r.smtp_user || '';
  document.getElementById('ntf-smtp-pass').placeholder = r.smtp_pass_set ? '•••••••• (guardada, escribe para cambiarla)' : '';
  document.getElementById('ntf-smtp-from').value = r.smtp_from || '';
  document.getElementById('ntf-smtp-to').value = r.smtp_to || '';
  document.getElementById('ntf-ev-disk').checked = !!r.ev_disk_enabled;
  document.getElementById('ntf-ev-disk-th').value = r.ev_disk_threshold || 90;
  document.getElementById('ntf-ev-services').checked = !!r.ev_services_enabled;
  document.getElementById('ntf-ev-security').checked = !!r.ev_security_enabled;
}

// collectNotifyForm: lee la tarjeta entera (token/contraseña vacíos = conservar).
function collectNotifyForm() {
  return {
    telegram_enabled: document.getElementById('ntf-tg-enabled').checked,
    telegram_token: document.getElementById('ntf-tg-token').value.trim(),
    telegram_chat_id: document.getElementById('ntf-tg-chat').value.trim(),
    smtp_enabled: document.getElementById('ntf-smtp-enabled').checked,
    smtp_host: document.getElementById('ntf-smtp-host').value.trim(),
    smtp_port: parseInt(document.getElementById('ntf-smtp-port').value, 10) || 587,
    smtp_secure: document.getElementById('ntf-smtp-secure').checked,
    smtp_user: document.getElementById('ntf-smtp-user').value.trim(),
    smtp_pass: document.getElementById('ntf-smtp-pass').value,
    smtp_from: document.getElementById('ntf-smtp-from').value.trim(),
    smtp_to: document.getElementById('ntf-smtp-to').value.trim(),
    ev_disk_enabled: document.getElementById('ntf-ev-disk').checked,
    ev_disk_threshold: parseInt(document.getElementById('ntf-ev-disk-th').value, 10) || 90,
    ev_services_enabled: document.getElementById('ntf-ev-services').checked,
    ev_security_enabled: document.getElementById('ntf-ev-security').checked,
  };
}

// saveNotifyConfig: guarda y limpia los campos de secretos.
async function saveNotifyConfig() {
  const r = await req('POST', '/notifications/config', collectNotifyForm());
  if (r?.success) {
    toast('Notificaciones guardadas', 'success');
    document.getElementById('ntf-tg-token').value = '';
    document.getElementById('ntf-smtp-pass').value = '';
    loadNotifyConfig();
  } else toast(r?.error || 'Error al guardar las notificaciones', 'error');
}

// testNotify: prueba de envío con lo que hay en el formulario (sin guardar).
async function testNotify(channel) {
  toast('Enviando prueba…', 'info');
  const r = await req('POST', `/notifications/test/${channel}`, collectNotifyForm());
  if (r?.success) toast('Prueba enviada, revisa ' + (channel === 'telegram' ? 'Telegram' : 'tu correo'), 'success');
  else toast(r?.error || 'La prueba falló', 'error');
}

// detectTgChat: autodetecta el chat_id (requiere /start previo en el bot).
async function detectTgChat() {
  const r = await req('POST', '/notifications/telegram/detect-chat', collectNotifyForm());
  if (r?.success && r.chatId) {
    document.getElementById('ntf-tg-chat').value = r.chatId;
    toast('Chat detectado' + (r.name ? ': ' + r.name : ''), 'success');
  } else toast(r?.error || 'No se pudo detectar el chat', 'error');
}
```

- [ ] **Step 3: Cargar la config al entrar en Ajustes**

En `frontend/js/app.js`, dentro de `async function loadSettings()` (línea ~1496), añade al final del cuerpo de la función:

```js
  loadNotifyConfig();
```

- [ ] **Step 4: Verificación manual en dev**

```bash
npm run dev
```

Abrir `http://localhost:8585`, login, ir a **Ajustes**:
- La tarjeta "Notificaciones" aparece con sus tres bloques.
- Guardar con un token inválido → toast de error "Token de Telegram no válido…".
- Guardar con todo desactivado → "Notificaciones guardadas".
- (Con un bot real: pegar token → /start en Telegram → "Detectar chat" rellena el Chat ID → "Enviar prueba" llega al móvil.)

- [ ] **Step 5: Commit**

```bash
git add frontend/views/pages/settings.html frontend/js/app.js
git commit -m "feat(notificaciones): tarjeta de configuración en Ajustes"
```

---

### Task 11: Documentación y cierre de rama

**Files:**
- Modify: `README.md` (bullet en Características Principales)
- Modify: `CLAUDE.md` (rutas y libs nuevas)
- Modify: `frontend/views/pages/help.html` (sección Ajustes)

**Interfaces:**
- Consumes: todo lo anterior terminado y verde.

- [ ] **Step 1: README.md**

En la lista "🚀 Características Principales", después del bullet de "🔗 **Workflows (n8n)**":

```markdown
- 🔔 **Notificaciones**: Avisos por **Telegram** (tu propio bot, sin desplegar nada) y **email (SMTP)** cuando algo va mal: disco por encima del umbral, servicio o contenedor caído (con aviso de recuperación y anti-flapping) y eventos de seguridad (bloqueo por fuerza bruta, login desde IP nueva). Credenciales cifradas en reposo y botón de prueba por canal.
```

- [ ] **Step 2: CLAUDE.md**

En la lista de `backend/routes/`, tras la entrada de `dns.js`:

```markdown
  - `notifications.js` — Notificaciones (Telegram + SMTP). Config en fila única `notify_config` (token/contraseña cifrados), endpoints de prueba por canal y autodetección del chat_id de Telegram (`getUpdates`). Los eventos de estado los vigila `lib/monitor.js` (setInterval 60 s en el proceso del panel: disco, servicios systemd, contenedores `txpl-*`) con transición+recuperación y anti-flapping de 2 ticks (`lib/notifications.js`, puro y testeado) y envío por `lib/notifyExecutor.js`. Hooks puntuales de seguridad en `auth.js` (fuerza bruta, IP nueva vía `audit_log`). Estado por recurso en `notify_state`.
```

En la lista de `backend/lib/`, tras la entrada de `n8n.js`:

```markdown
- `backend/lib/notifications.js` — Helpers puros de notificaciones (validadores de token/chat/SMTP, transiciones de estado `applyTick` con anti-flapping y reintento, constructores de eventos y mensajes Telegram/email), unit-tested en `backend/test/notifications.test.js`.
- `backend/lib/notifyExecutor.js` — Executor de envío: descifra `notify_config`, `fetch` a la API de Telegram (timeout 10 s) y SMTP vía nodemailer. `dispatch()` nunca lanza; errores logueados sin secretos.
- `backend/lib/monitor.js` — Vigilante integrado (60 s): disco (`df`), servicios (`systemctl is-active`), contenedores `txpl-*` (socket Docker). Sin config no hace nada; en Windows/dev se omiten los chequeos limpiamente.
```

- [ ] **Step 3: help.html**

En `frontend/views/pages/help.html`, en la sección **Ajustes**, añade al `<ul>` existente:

```html
      <li><strong>Notificaciones:</strong> conecta un bot de Telegram (creado con @BotFather) y/o un SMTP para recibir avisos de disco lleno, servicios ca&iacute;dos y eventos de seguridad, con mensaje de recuperaci&oacute;n. Si el VPS entero se cae, usa un monitor externo.</li>
```

- [ ] **Step 4: Verificación final completa**

```bash
npm test
node -e "require('./backend/server.js')" & sleep 2; kill %1
```

Expected: suite completa PASS y el servidor arranca sin errores mostrando el monitor activo.

- [ ] **Step 5: Commit de docs**

```bash
git add README.md CLAUDE.md frontend/views/pages/help.html
git commit -m "docs(notificaciones): README, CLAUDE.md y manual de uso"
```

- [ ] **Step 6: Cierre de rama (tras revisión final)**

Tras la revisión final de la rama (revisor de rama según el flujo del repo):

```bash
git checkout main
git merge --no-ff feat/notificaciones -m "feat: notificaciones por Telegram y email (monitor + hooks de seguridad)"
npm test
git branch -d feat/notificaciones
```

(El push a origin lo decide el usuario.)
