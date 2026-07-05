# Barra de progreso en la descarga de n8n — Plan de Implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mostrar una barra de % en vivo durante la descarga de la imagen Docker de n8n, leyendo el progreso real que emite la API de Docker en streaming, para que la instalación no parezca colgada.

**Architecture:** Un helper puro y testeable (`accumulatePullProgress`) agrega el progreso por capa y calcula un % global. El endpoint `POST /install` sustituye el pull buffered por una lectura en streaming del socket de Docker que alimenta ese helper y emite marcadores `__TXPL_PROGRESS__<pct>` al cliente. El frontend parsea esos marcadores para pintar una barra y los filtra del texto de la consola.

**Tech Stack:** Node.js + Express, socket Docker vía `http` nativo, `node:test`, frontend vanilla JS.

## Global Constraints

- **Idioma español** en UI, comentarios y mensajes de error (convención del proyecto).
- **Sin dependencias npm nuevas.** Tests con el runner nativo `node:test`.
- **Socket Docker vía `http` nativo** (mismo patrón que `dockerRequest` en `routes/n8n.js`), nunca interpolación de shell.
- **Sin fallos silenciosos:** los errores de descarga devuelven el mensaje real y terminan con `__TXPL_DONE__1`; nada de `|| true`.
- **Centinela de streaming existente:** el final se marca con `__TXPL_DONE__<code>`. El progreso se añade como línea propia `__TXPL_PROGRESS__<entero>` y el frontend la filtra del texto.
- **El % es aproximado** (varias capas; los totales se conocen a medida que empiezan). Acotado a [0, 100].
- **No cambiar el resto del pipeline de install** (crear contenedor, proxy, guardar config).

---

### Task 1: Helper `accumulatePullProgress` (`backend/lib/n8n.js`) con tests

**Files:**
- Modify: `backend/lib/n8n.js` (añadir función + export)
- Test: `backend/test/n8n.test.js` (añadir casos)

**Interfaces:**
- Produces (exportada desde `backend/lib/n8n.js`):
  - `accumulatePullProgress(state, event)` → muta `state` (acumulador
    `{ layers: { <id>: { current, total } } }`) y devuelve
    `{ pct: number(0-100), phase: 'descarga'|'extracción', error: string|null }`.

- [ ] **Step 1: Escribir los tests que fallan**

Añadir al final de `backend/test/n8n.test.js`:

```javascript
test('accumulatePullProgress: dos capas descargando => pct combinado', () => {
  const state = { layers: {} };
  n8n.accumulatePullProgress(state, { status: 'Downloading', id: 'a', progressDetail: { current: 50, total: 100 } });
  const p = n8n.accumulatePullProgress(state, { status: 'Downloading', id: 'b', progressDetail: { current: 0, total: 100 } });
  // (50 + 0) / (100 + 100) = 25%
  assert.strictEqual(p.pct, 25);
  assert.strictEqual(p.phase, 'descarga');
  assert.strictEqual(p.error, null);
});

test('accumulatePullProgress: actualizar una capa recalcula el total combinado', () => {
  const state = { layers: {} };
  n8n.accumulatePullProgress(state, { status: 'Downloading', id: 'a', progressDetail: { current: 50, total: 100 } });
  n8n.accumulatePullProgress(state, { status: 'Downloading', id: 'b', progressDetail: { current: 0, total: 100 } });
  const p = n8n.accumulatePullProgress(state, { status: 'Downloading', id: 'b', progressDetail: { current: 100, total: 100 } });
  // (50 + 100) / 200 = 75%
  assert.strictEqual(p.pct, 75);
});

test('accumulatePullProgress: evento Extracting => fase extracción', () => {
  const state = { layers: { a: { current: 100, total: 100 } } };
  const p = n8n.accumulatePullProgress(state, { status: 'Extracting', id: 'a', progressDetail: { current: 10, total: 100 } });
  assert.strictEqual(p.phase, 'extracción');
});

test('accumulatePullProgress: evento con error lo propaga', () => {
  const state = { layers: {} };
  const p = n8n.accumulatePullProgress(state, { error: 'toomanyrequests: rate limit' });
  assert.strictEqual(p.error, 'toomanyrequests: rate limit');
});

test('accumulatePullProgress: sin totales => pct 0, nunca > 100', () => {
  const state = { layers: {} };
  const p0 = n8n.accumulatePullProgress(state, { status: 'Pulling fs layer', id: 'a' });
  assert.strictEqual(p0.pct, 0);
  const state2 = { layers: { a: { current: 999, total: 100 } } };
  const p1 = n8n.accumulatePullProgress(state2, { status: 'Downloading', id: 'a', progressDetail: { current: 999, total: 100 } });
  assert.ok(p1.pct <= 100);
});
```

- [ ] **Step 2: Ejecutar los tests para verificar que fallan**

Run: `node --test backend/test/n8n.test.js`
Expected: FAIL con `n8n.accumulatePullProgress is not a function`.

- [ ] **Step 3: Implementar el helper**

En `backend/lib/n8n.js`, añadir la función antes del `module.exports`:

```javascript
// Acumula el progreso de un `docker pull` a partir de los eventos JSON que emite
// la API de Docker (`/images/create`). Guarda {current,total} por capa en `state`
// y devuelve el % global de descarga, la fase y un posible error.
//  - state: acumulador { layers: { <id>: { current, total } } } (empezar en { layers: {} }).
//  - event: un objeto JSON ya parseado de la respuesta de Docker.
function accumulatePullProgress(state, event) {
  if (event && event.error) return { pct: 0, phase: 'descarga', error: String(event.error) };
  const status = (event && event.status) || '';
  const phase = /^extract/i.test(status) ? 'extracción' : 'descarga';
  if (/^downloading$/i.test(status) && event.id && event.progressDetail && event.progressDetail.total > 0) {
    state.layers[event.id] = {
      current: event.progressDetail.current || 0,
      total: event.progressDetail.total,
    };
  }
  let sumCurrent = 0, sumTotal = 0;
  for (const id in state.layers) {
    sumCurrent += state.layers[id].current;
    sumTotal += state.layers[id].total;
  }
  let pct = sumTotal > 0 ? Math.floor((100 * sumCurrent) / sumTotal) : 0;
  if (pct < 0) pct = 0;
  if (pct > 100) pct = 100;
  return { pct, phase, error: null };
}
```

Y añadirla al `module.exports` existente (junto a `buildN8nContainerConfig, n8nApi, computeN8nStatus`):

```javascript
module.exports = {
  N8N_CONTAINER, N8N_VOLUME, N8N_IMAGE, N8N_PORT,
  buildN8nContainerConfig, n8nApi, computeN8nStatus, accumulatePullProgress,
};
```

- [ ] **Step 4: Ejecutar los tests para verificar que pasan**

Run: `npm test`
Expected: PASS de todos los tests (los 17 previos + los 5 nuevos = 22), 0 fallos.

- [ ] **Step 5: Commit**

```bash
git add backend/lib/n8n.js backend/test/n8n.test.js
git commit -m "feat(n8n): helper accumulatePullProgress (progreso del pull) + tests"
```

---

### Task 2: Pull en streaming con progreso (`backend/routes/n8n.js`)

**Files:**
- Modify: `backend/routes/n8n.js` (añadir `pullImageWithProgress`; reemplazar el pull buffered en `POST /install`)

**Interfaces:**
- Consumes: `accumulatePullProgress` (Task 1); `http`, `fs`, `DOCKER_SOCKET`, `N8N_IMAGE` (ya en el fichero).
- Produces: función interna `pullImageWithProgress(image, write)` → `Promise<void>`; resuelve al terminar la descarga, rechaza con `Error(mensaje real)` si Docker devuelve error o el socket falla. Emite `write('__TXPL_PROGRESS__<pct>\n')` cuando el % entero cambia.

- [ ] **Step 1: Importar `accumulatePullProgress`**

En `backend/routes/n8n.js`, en el `require` de `../lib/n8n` (donde ya se importan `buildN8nContainerConfig, n8nApi, computeN8nStatus, N8N_CONTAINER, N8N_IMAGE, N8N_PORT`), añadir `accumulatePullProgress`:

```javascript
const {
  buildN8nContainerConfig, n8nApi, computeN8nStatus, accumulatePullProgress,
  N8N_CONTAINER, N8N_IMAGE, N8N_PORT,
} = require('../lib/n8n');
```

- [ ] **Step 2: Añadir la función `pullImageWithProgress`**

En `backend/routes/n8n.js`, justo después de la función `dockerRequest` (antes de `inspectContainer`), añadir:

```javascript
// Descarga una imagen por el socket de Docker transmitiendo el progreso.
// Lee las líneas JSON de /images/create, agrega el % con accumulatePullProgress
// y llama a write('__TXPL_PROGRESS__<pct>\n') cuando el entero cambia.
// Resuelve al terminar; rechaza con el mensaje real si hay error.
function pullImageWithProgress(image, write) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(DOCKER_SOCKET)) {
      return reject(new Error('El socket de Docker no existe o Docker no está instalado.'));
    }
    const path = `/images/create?fromImage=${encodeURIComponent(image)}`;
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
        }
      });
      res.on('end', () => (failed ? reject(new Error(failed)) : resolve()));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}
```

- [ ] **Step 3: Reemplazar el pull buffered en `POST /install`**

En `backend/routes/n8n.js`, sustituir estas tres líneas (las del pull actual):

```javascript
    write(`⏳ Descargando imagen ${N8N_IMAGE}...\n`);
    const pull = await dockerRequest('POST', `/images/create?fromImage=${encodeURIComponent(N8N_IMAGE)}`);
    if (pull.statusCode >= 400) { write(`✖ Error al descargar la imagen: ${pull.body.toString()}\n`); return done(1); }
    write('✓ Imagen lista.\n');
```

por:

```javascript
    write(`⏳ Descargando imagen ${N8N_IMAGE}...\n`);
    try {
      await pullImageWithProgress(N8N_IMAGE, write);
    } catch (e) {
      write(`✖ Error al descargar la imagen: ${e.message}\n`);
      return done(1);
    }
    write('✓ Imagen lista.\n');
```

- [ ] **Step 4: Verificar carga y tests**

Run: `node -e "require('./backend/routes/n8n'); console.log('n8n router OK')"`
Expected: imprime `n8n router OK`.

Run: `npm test`
Expected: 22/22 en verde (Task 2 no toca tests, pero confirma que nada se rompió).

- [ ] **Step 5: Commit**

```bash
git add backend/routes/n8n.js
git commit -m "feat(n8n): descargar la imagen en streaming emitiendo progreso (__TXPL_PROGRESS__)"
```

---

### Task 3: Barra de progreso en el frontend

**Files:**
- Modify: `frontend/views/pages/n8n.html` (añadir la barra dentro de `#n8n-console`)
- Modify: `frontend/js/app.js` (parsear `__TXPL_PROGRESS__` en `n8nInstall`)

**Interfaces:**
- Consumes: los marcadores `__TXPL_PROGRESS__<pct>` que emite el backend (Task 2) y el centinela `__TXPL_DONE__` existente.
- Produces: barra visual (`#n8n-progress`, `#n8n-progress-bar`, `#n8n-progress-label`) que refleja el % de descarga.

- [ ] **Step 1: Añadir la barra al markup de la consola**

En `frontend/views/pages/n8n.html`, dentro de `#n8n-console`, insertar el bloque de la barra **entre** el `<div>` de la cabecera (título/spinner/botón) y el `<pre id="n8n-console-output">`:

```html
  <div id="n8n-progress" style="display:none;margin-bottom:8px">
    <div style="display:flex;justify-content:space-between;font-size:12px;color:var(--text-muted);margin-bottom:4px">
      <span>Descargando imagen…</span><span id="n8n-progress-label">0%</span>
    </div>
    <div style="background:var(--border);border-radius:6px;height:8px;overflow:hidden">
      <div id="n8n-progress-bar" style="width:0%;height:100%;background:var(--accent);transition:width .2s"></div>
    </div>
  </div>
```

- [ ] **Step 2: Parsear el progreso en `n8nInstall`**

En `frontend/js/app.js`, en la función `n8nInstall`:

(a) Al inicio (junto a `wrap.style.display = 'block'; spinner.style.display = 'inline'; out.textContent = '';`), resetear la barra:

```javascript
  const prog = document.getElementById('n8n-progress');
  const progBar = document.getElementById('n8n-progress-bar');
  const progLabel = document.getElementById('n8n-progress-label');
  prog.style.display = 'none'; progBar.style.width = '0%'; progLabel.textContent = '0%';
```

(b) Reemplazar el cuerpo del bucle de lectura (el bloque que hoy hace
`let display = buffer; const idx = ...; out.textContent = display; ...`) por una
versión que separa los marcadores de progreso del texto:

```javascript
      buffer += dec.decode(value, { stream: true });
      let display = buffer;
      const idx = buffer.indexOf(DONE);
      if (idx >= 0) { exitCode = parseInt(buffer.slice(idx + DONE.length).trim(), 10) || 0; display = buffer.slice(0, idx); }
      // Separar las líneas de progreso (__TXPL_PROGRESS__N) del texto de consola.
      const PROG = '__TXPL_PROGRESS__';
      let lastPct = null;
      const textLines = [];
      for (const ln of display.split('\n')) {
        if (ln.startsWith(PROG)) { const n = parseInt(ln.slice(PROG.length), 10); if (!isNaN(n)) lastPct = n; }
        else textLines.push(ln);
      }
      out.textContent = textLines.join('\n'); out.scrollTop = out.scrollHeight;
      if (lastPct !== null) {
        prog.style.display = 'block';
        progBar.style.width = lastPct + '%';
        progLabel.textContent = lastPct + '%';
      }
```

(c) Tras el bucle (junto a `spinner.style.display = 'none';`), ocultar la barra:

```javascript
  prog.style.display = 'none';
```

- [ ] **Step 3: Verificar sintaxis**

Run: `node --check frontend/js/app.js && echo "app.js OK"`
Expected: imprime `app.js OK`.

Confirmar con grep que la barra y su parseo existen:
Run: `grep -n "n8n-progress\|__TXPL_PROGRESS__" frontend/js/app.js frontend/views/pages/n8n.html`
Expected: coincidencias en ambos ficheros.

- [ ] **Step 4: Commit**

```bash
git add frontend/views/pages/n8n.html frontend/js/app.js
git commit -m "feat(n8n): barra de progreso de descarga en la consola de instalación"
```

---

## Self-Review

**Cobertura del spec:**
- Helper puro `accumulatePullProgress` + tests → Task 1. ✓
- Pull en streaming que emite `__TXPL_PROGRESS__<pct>` throttled y maneja error/corte → Task 2. ✓
- Barra en el frontend que refleja el % y filtra los marcadores del texto → Task 3. ✓
- Centinela `__TXPL_DONE__` intacto; resto del pipeline sin cambios → Task 2 (solo se sustituye el bloque del pull). ✓
- % acotado [0,100], aproximado → Task 1 (clamp) + tests. ✓
- Sin fallos silenciosos (error real + `done(1)`) → Task 2 (catch escribe mensaje real). ✓
- Extracción como texto (no barra) → no se emiten marcadores en fase de extracción salvo que Docker mande `Downloading`; la barra cubre la descarga. Fase de extracción aparece como líneas de texto normales de Docker si las hubiera; el spec la excluye de la barra. ✓

**Escaneo de placeholders:** sin "TBD"/"TODO"; todo el código está completo.

**Consistencia de tipos/nombres:** `accumulatePullProgress(state, event)` con `{ pct, phase, error }` se define en Task 1 y se consume igual en Task 2. Los IDs `n8n-progress`/`n8n-progress-bar`/`n8n-progress-label` y el marcador `__TXPL_PROGRESS__` coinciden entre Task 2 (emisor), Task 3 HTML y Task 3 JS.
