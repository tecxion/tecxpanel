# Despliegue de apps Python (Fase 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permitir desplegar apps Python (servicios web y workers/bots) desde la sección Apps (PM2), instalando `requirements.txt` en un virtualenv por app.

**Architecture:** Se extraen los helpers de análisis de proyecto de `backend/routes/apps.js` a un módulo puro `backend/lib/appdeploy.js` para poder testearlos con el runner nativo de Node. Sobre él se añade: creación de `.venv` por app, instalación con el pip del venv (evita PEP 668), detección ampliada de entrypoint y de modo web/worker, y arranque PM2 con el intérprete/binario del venv. El frontend añade una pausa de confirmación **solo para proyectos Python** (toggle web/worker, selector de `.py`, comando editable) sin alterar el flujo de Node/React.

**Tech Stack:** Node.js 18+ (Express, better-sqlite3, PM2), runner de tests nativo `node:test` (sin dependencias nuevas), frontend vanilla JS.

## Global Constraints

- Idioma de UI, comentarios, mensajes de error y commits: **español** (convención del proyecto).
- Ejecución externa **siempre** con `execFile`/`runSafe` y argumentos en array (nunca interpolación de strings). Los comandos compuestos de shell van vía `bash -lc` como ya hace el repo.
- **Sin nuevas dependencias npm.** Tests con `node:test` (incluido en Node 18+).
- No usar patrones que oculten errores (`|| true`).
- Sin cambios de esquema salvo nuevas prepared statements en `backend/database.js`.

---

### Task 1: Extraer helpers de análisis a `backend/lib/appdeploy.js` (refactor sin cambio de comportamiento)

Mueve las funciones puras (solo `fs`/`path`) fuera de `apps.js` para aislarlas y poder testearlas sin tocar la base de datos. Sin cambios de lógica.

**Files:**
- Create: `backend/lib/appdeploy.js`
- Modify: `backend/routes/apps.js` (eliminar las funciones movidas e importarlas)
- Test: `backend/test/appdeploy.test.js` (smoke test de import)

**Interfaces:**
- Produces: módulo `backend/lib/appdeploy.js` que exporta
  `{ removeAppDir, buildPm2Launch, checkBuildRequirements, detectProject, flattenSingleSubdir }`
  con las mismas firmas actuales:
  - `removeAppDir(dir: string): void`
  - `buildPm2Launch(appRow): string[]`
  - `checkBuildRequirements(appRow): string|null`
  - `detectProject(cwd: string): { type, manager, installCmd, buildCmd, startCmd, notes: string[] }`
  - `flattenSingleSubdir(cwd: string): void`

- [ ] **Step 1: Crear `backend/lib/appdeploy.js` con las funciones movidas**

Copia textualmente desde `backend/routes/apps.js` las funciones `removeAppDir` (líneas 17-25), `buildPm2Launch` (37-61), `checkBuildRequirements` (63-88), `detectProject` (100-148) y `flattenSingleSubdir` (151-164) a este archivo nuevo, con su cabecera y export:

```js
'use strict';

const path = require('path');
const fs = require('fs');

// (Pegar aquí, sin cambios, las 5 funciones tal cual están hoy en apps.js)
// removeAppDir, buildPm2Launch, checkBuildRequirements, detectProject, flattenSingleSubdir

module.exports = {
  removeAppDir,
  buildPm2Launch,
  checkBuildRequirements,
  detectProject,
  flattenSingleSubdir,
};
```

- [ ] **Step 2: En `apps.js`, borrar esas 5 funciones e importarlas**

Elimina las definiciones movidas y añade el require junto a los otros (debajo de la línea `const nginx = require('../lib/nginx');`):

```js
const {
  removeAppDir, buildPm2Launch, checkBuildRequirements,
  detectProject, flattenSingleSubdir,
} = require('../lib/appdeploy');
```

- [ ] **Step 3: Escribir smoke test de import**

```js
// backend/test/appdeploy.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const appdeploy = require('../lib/appdeploy');

test('appdeploy exporta los helpers esperados', () => {
  for (const fn of ['removeAppDir', 'buildPm2Launch', 'checkBuildRequirements', 'detectProject', 'flattenSingleSubdir']) {
    assert.strictEqual(typeof appdeploy[fn], 'function', `falta ${fn}`);
  }
});
```

- [ ] **Step 4: Ejecutar el test**

Run: `node --test backend/test/`
Expected: PASS (1 test).

- [ ] **Step 5: Verificar que el servidor arranca (no se rompió el require)**

Run: `node -e "require('./backend/routes/apps.js'); console.log('apps.js OK')"`
Expected: imprime `apps.js OK` sin error.
(Nota: en local sin `.env` puede fallar `database.js`; si es así, verifica al menos `node -e "require('./backend/lib/appdeploy.js'); console.log('lib OK')"`.)

- [ ] **Step 6: Commit**

```bash
git add backend/lib/appdeploy.js backend/routes/apps.js backend/test/appdeploy.test.js
git commit -m "refactor: extrae helpers de despliegue de apps a lib/appdeploy.js"
```

---

### Task 2: `detectProject` — virtualenv, entrypoints ampliados y modo web/worker

**Files:**
- Modify: `backend/lib/appdeploy.js` (función `detectProject` + nuevos helpers)
- Test: `backend/test/appdeploy.test.js`

**Interfaces:**
- Consumes: `detectProject` de Task 1.
- Produces: `detectProject(cwd)` ahora devuelve además:
  - `mode: 'web' | 'worker'` (para Python; el resto de tipos = `'web'`)
  - `pyFiles: string[]` (nombres de `.py` en la raíz; `[]` si no es Python)
  - Para Python: `installCmd` basado en venv y `startCmd` = `python <entry>`.
  - Helper `detectPyMode(cwd: string, reqPath: string): 'web'|'worker'` (no exportado).
  - Constante de entrypoints Python: `app.py, main.py, wsgi.py, server.py, bot.py, run.py`.

- [ ] **Step 1: Escribir los tests (fallan primero)**

Añade a `backend/test/appdeploy.test.js`:

```js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tmpProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'txpl-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

test('detectProject: bot Python sin framework => worker, venv, entry bot.py', () => {
  const dir = tmpProject({ 'requirements.txt': 'python-telegram-bot==21.0\n', 'bot.py': 'print(1)' });
  const det = appdeploy.detectProject(dir);
  assert.strictEqual(det.type, 'python');
  assert.strictEqual(det.mode, 'worker');
  assert.match(det.installCmd, /python3 -m venv \.venv/);
  assert.match(det.installCmd, /\.venv\/bin\/pip install -r requirements\.txt/);
  assert.strictEqual(det.startCmd, 'python bot.py');
  assert.ok(det.pyFiles.includes('bot.py'));
});

test('detectProject: web FastAPI => mode web', () => {
  const dir = tmpProject({ 'requirements.txt': 'fastapi\nuvicorn\n', 'main.py': 'x=1' });
  const det = appdeploy.detectProject(dir);
  assert.strictEqual(det.type, 'python');
  assert.strictEqual(det.mode, 'web');
  assert.strictEqual(det.startCmd, 'python main.py');
});

test('detectProject: Flask => mode web', () => {
  const dir = tmpProject({ 'requirements.txt': 'Flask==3.0\n', 'app.py': 'x=1' });
  assert.strictEqual(appdeploy.detectProject(dir).mode, 'web');
});

test('detectProject: solo bot.py sin requirements => python, venv sin pip', () => {
  const dir = tmpProject({ 'bot.py': 'print(1)' });
  const det = appdeploy.detectProject(dir);
  assert.strictEqual(det.type, 'python');
  assert.strictEqual(det.installCmd, 'python3 -m venv .venv');
});

test('detectProject: proyecto Node mantiene mode web y pyFiles vacío', () => {
  const dir = tmpProject({ 'package.json': '{"scripts":{"start":"node index.js"}}', 'index.js': '' });
  const det = appdeploy.detectProject(dir);
  assert.strictEqual(det.type, 'nodejs');
  assert.strictEqual(det.mode, 'web');
  assert.deepStrictEqual(det.pyFiles, []);
});
```

- [ ] **Step 2: Ejecutar para ver que fallan**

Run: `node --test backend/test/`
Expected: FAIL en los tests de `detectProject` (p. ej. `det.mode` es `undefined`).

- [ ] **Step 3: Implementar los cambios en `detectProject`**

En `backend/lib/appdeploy.js`, añade cerca del inicio del archivo (tras los `require`):

```js
// Entrypoints Python reconocidos (en orden de preferencia)
const PY_ENTRIES = ['app.py', 'main.py', 'wsgi.py', 'server.py', 'bot.py', 'run.py'];
// Frameworks que implican un servicio web (escucha en un puerto)
const PY_WEB_FRAMEWORKS = ['flask', 'fastapi', 'django', 'gunicorn', 'uvicorn'];

// Decide si un proyecto Python es "web" (puerto + proxy) o "worker" (sin puerto)
// mirando los frameworks declarados en requirements.txt.
function detectPyMode(cwd, reqPath) {
  try {
    if (!fs.existsSync(reqPath)) return 'worker';
    const reqs = fs.readFileSync(reqPath, 'utf8').toLowerCase();
    return PY_WEB_FRAMEWORKS.some((fw) => reqs.includes(fw)) ? 'web' : 'worker';
  } catch (_) { return 'worker'; }
}
```

Cambia el objeto `det` inicial para incluir los campos nuevos:

```js
const det = { type: 'nodejs', manager: 'npm', installCmd: '', buildCmd: '', startCmd: '', notes: [], mode: 'web', pyFiles: [] };
```

Sustituye el `hasPyFile` para que use `PY_ENTRIES`:

```js
const hasPyFile = () => PY_ENTRIES.some((f) => fs.existsSync(path.join(cwd, f)));
```

Sustituye la rama Python (hoy: `det.type='python'` … `det.startCmd = \`python3 ${entry || 'app.py'}\``) por:

```js
  } else if (fs.existsSync(reqPath) || hasPyFile()) {
    det.type = 'python';
    det.manager = 'pip';
    // Virtualenv por app: crea .venv y, si hay requirements.txt, instala dentro.
    // Evita el error PEP 668 (externally-managed-environment) del pip global.
    det.installCmd = fs.existsSync(reqPath)
      ? 'python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt'
      : 'python3 -m venv .venv';
    const entry = PY_ENTRIES.find((f) => fs.existsSync(path.join(cwd, f)));
    det.startCmd = `python ${entry || 'app.py'}`;
    det.mode = detectPyMode(cwd, reqPath);
    det.pyFiles = fs.readdirSync(cwd).filter((f) => f.endsWith('.py'));
  } else {
```

- [ ] **Step 4: Ejecutar tests hasta que pasen**

Run: `node --test backend/test/`
Expected: PASS (todos).

- [ ] **Step 5: Commit**

```bash
git add backend/lib/appdeploy.js backend/test/appdeploy.test.js
git commit -m "feat: detectProject crea venv y detecta modo web/worker en Python"
```

---

### Task 3: `buildPm2Launch` — arrancar Python con el intérprete/binario del venv

**Files:**
- Modify: `backend/lib/appdeploy.js` (función `buildPm2Launch`)
- Test: `backend/test/appdeploy.test.js`

**Interfaces:**
- Consumes: `buildPm2Launch(appRow)` de Task 1.
- Produces: para `appRow.type === 'python'`, los args de PM2 usan
  `<path>/.venv/bin/python` como intérprete (scripts `.py`) o
  `<path>/.venv/bin/<bin>` ejecutado con `--interpreter none` (gunicorn/uvicorn).

- [ ] **Step 1: Escribir los tests (fallan primero)**

Añade a `backend/test/appdeploy.test.js`:

```js
test('buildPm2Launch: script Python usa el python del venv', () => {
  const args = appdeploy.buildPm2Launch({ pm2_name: 'txpl-app-bot', path: '/var/www/bot', type: 'python', start_cmd: 'python bot.py' });
  assert.deepStrictEqual(args.slice(0, 2), ['start', 'bot.py']);
  const i = args.indexOf('--interpreter');
  assert.ok(i > -1);
  assert.strictEqual(args[i + 1], '/var/www/bot/.venv/bin/python');
});

test('buildPm2Launch: gunicorn usa el binario del venv con --interpreter none', () => {
  const args = appdeploy.buildPm2Launch({ pm2_name: 'txpl-app-api', path: '/var/www/api', type: 'python', start_cmd: 'gunicorn -w 2 app:app' });
  assert.strictEqual(args[0], 'start');
  assert.strictEqual(args[1], '/var/www/api/.venv/bin/gunicorn');
  const i = args.indexOf('--interpreter');
  assert.strictEqual(args[i + 1], 'none');
  const sep = args.indexOf('--');
  assert.deepStrictEqual(args.slice(sep + 1), ['-w', '2', 'app:app']);
});

test('buildPm2Launch: Node con npm start no cambia', () => {
  const args = appdeploy.buildPm2Launch({ pm2_name: 'txpl-app-web', path: '/var/www/web', type: 'nodejs', start_cmd: 'npm start' });
  assert.strictEqual(args[0], 'start');
  assert.strictEqual(args[1], 'npm');
});
```

- [ ] **Step 2: Ejecutar para ver que fallan**

Run: `node --test backend/test/`
Expected: FAIL (hoy `buildPm2Launch` usa `python3` global, no el venv).

- [ ] **Step 3: Implementar la rama Python al inicio de `buildPm2Launch`**

En `buildPm2Launch`, justo después de calcular `baseOpts` y antes del `if (/^(npm|yarn|pnpm)\b/.test(cmd))`, inserta:

```js
  // Python: ejecutar siempre con el intérprete/binarios del virtualenv (.venv)
  if (appRow.type === 'python') {
    const venvBin = path.join(cwd, '.venv', 'bin');
    const parts = cmd.split(/\s+/).filter(Boolean);
    const first = parts[0] || 'python';
    if (/^python3?$/.test(first)) {
      const script = parts.slice(1).join(' ') || 'app.py';
      return ['start', script, ...baseOpts, '--interpreter', path.join(venvBin, 'python')];
    }
    // gunicorn / uvicorn / otro binario instalado en el venv
    return ['start', path.join(venvBin, first), ...baseOpts, '--interpreter', 'none', '--', ...parts.slice(1)];
  }
```

Además, en la rama existente `else if (/^(python3?|node)\s/.test(cmd))` y en el `else` final, elimina las dos líneas que hacían
`if (interp.startsWith('python')) pm2Args.push('--interpreter', interp);`
y `if (appRow.type === 'python') pm2Args.push('--interpreter', 'python3');`
(ya no se alcanzan para Python porque la nueva rama retorna antes; quitarlas evita el `python3` global muerto).

- [ ] **Step 4: Ejecutar tests hasta que pasen**

Run: `node --test backend/test/`
Expected: PASS (todos).

- [ ] **Step 5: Commit**

```bash
git add backend/lib/appdeploy.js backend/test/appdeploy.test.js
git commit -m "feat: buildPm2Launch arranca Python con el venv (.venv/bin)"
```

---

### Task 4: `checkBuildRequirements` — avisar si falta el venv en Python

**Files:**
- Modify: `backend/lib/appdeploy.js` (función `checkBuildRequirements`)
- Test: `backend/test/appdeploy.test.js`

**Interfaces:**
- Consumes: `checkBuildRequirements(appRow)` de Task 1.
- Produces: devuelve un mensaje en español si `appRow.type === 'python'` y no existe
  `<path>/.venv`; `null` en caso contrario (comportamiento Node intacto).

- [ ] **Step 1: Escribir los tests (fallan primero)**

```js
test('checkBuildRequirements: Python sin .venv avisa', () => {
  const dir = tmpProject({ 'bot.py': 'x=1' });
  const msg = appdeploy.checkBuildRequirements({ path: dir, type: 'python', start_cmd: 'python bot.py' });
  assert.match(msg, /Instalar|venv|dependencias/i);
});

test('checkBuildRequirements: Python con .venv pasa', () => {
  const dir = tmpProject({ 'bot.py': 'x=1' });
  fs.mkdirSync(path.join(dir, '.venv'));
  const msg = appdeploy.checkBuildRequirements({ path: dir, type: 'python', start_cmd: 'python bot.py' });
  assert.strictEqual(msg, null);
});
```

- [ ] **Step 2: Ejecutar para ver que fallan**

Run: `node --test backend/test/`
Expected: FAIL (hoy devuelve `null` para Python sin venv).

- [ ] **Step 3: Implementar el guard al inicio de `checkBuildRequirements`**

Justo después de `const cmd = (appRow.start_cmd || '').trim();` y antes del `try {`:

```js
  if (appRow.type === 'python') {
    if (!fs.existsSync(path.join(cwd, '.venv'))) {
      return 'Faltan las dependencias de Python. Pulsa el botón de instalar (📦) para crear el entorno virtual antes de iniciar.';
    }
    return null;
  }
```

- [ ] **Step 4: Ejecutar tests hasta que pasen**

Run: `node --test backend/test/`
Expected: PASS (todos).

- [ ] **Step 5: Commit**

```bash
git add backend/lib/appdeploy.js backend/test/appdeploy.test.js
git commit -m "feat: avisa si falta el venv de Python antes de arrancar"
```

---

### Task 5: Endpoint para persistir la config Python editada (`POST /api/apps/:id/config`)

El frontend necesita guardar el comando de arranque editado y el modo (puerto/dominio según web/worker) antes de instalar/arrancar.

**Files:**
- Modify: `backend/database.js` (nueva prepared statement)
- Modify: `backend/routes/apps.js` (nueva ruta)
- Test: verificación funcional con `curl`

**Interfaces:**
- Consumes: `queries.getApp`, `audit`, helpers `ok/fail/wrap/clientIp`, `RE_APP_NAME`/`isPort`/`isValidDomain` (ya importados en apps.js).
- Produces:
  - `queries.setAppDeployConfig`: `UPDATE apps SET type=?, start_cmd=?, port=?, domain=? WHERE id=?`
  - Ruta `POST /api/apps/:id/config` body `{ type?, start_cmd, port?, domain? }` → actualiza la app.

- [ ] **Step 1: Añadir la prepared statement en `backend/database.js`**

Junto a `setAppConfig` (línea ~194), añade:

```js
  setAppDeployConfig: db.prepare('UPDATE apps SET type = ?, start_cmd = ?, port = ?, domain = ? WHERE id = ?'),
```

- [ ] **Step 2: Añadir la ruta en `apps.js`**

Colócala antes de la ruta genérica `router.post('/:id/:action', ...)` (para que `:action` no capture `config`):

```js
// Guarda la configuración de despliegue editada por el usuario (comando, modo).
// En modo worker se limpian puerto y dominio (no escucha en red).
router.post('/:id/config', wrap(async (req, res) => {
  const appRow = queries.getApp.get(+req.params.id);
  if (!appRow) return fail(res, 404, 'App no encontrada');

  const startCmd = (req.body?.start_cmd || '').trim();
  if (!startCmd) return fail(res, 400, 'El comando de arranque es obligatorio');

  const type = ALLOWED_APP_TYPES.includes(req.body?.type) ? req.body.type : appRow.type;
  const mode = req.body?.mode === 'worker' ? 'worker' : 'web';

  let port = appRow.port;
  let domain = appRow.domain;
  if (mode === 'worker') { port = null; domain = null; }
  else {
    if (req.body?.port != null && req.body.port !== '') {
      const p = parseInt(req.body.port, 10);
      if (!isPort(p)) return fail(res, 400, 'Puerto inválido');
      port = p;
    }
    if (req.body?.domain) {
      if (!isValidDomain(req.body.domain)) return fail(res, 400, 'Dominio inválido');
      domain = req.body.domain;
    }
  }

  queries.setAppDeployConfig.run(type, startCmd, port, domain, appRow.id);
  audit(req.user.username, clientIp(req), 'app.config', `${appRow.name}: ${startCmd}`);
  ok(res, { success: true, type, start_cmd: startCmd, port, domain, mode });
}));
```

Asegúrate de que `ALLOWED_APP_TYPES` esté importado en apps.js (hoy importa `RE_APP_NAME, ALLOWED_APP_TYPES, ...` — confírmalo en la línea 8; si falta, añádelo).

- [ ] **Step 3: Verificación funcional (requiere `.env` local y servidor en marcha)**

Run (en una terminal con el server en `npm run dev` y un token válido):
```bash
# crea una app de prueba y anota su id; luego:
curl -s -X POST localhost:8585/api/apps/1/config \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"start_cmd":"python bot.py","mode":"worker"}'
```
Expected: JSON `{"success":true,...,"port":null,"domain":null,"mode":"worker"}`.

- [ ] **Step 4: Commit**

```bash
git add backend/database.js backend/routes/apps.js
git commit -m "feat: endpoint POST /apps/:id/config para guardar comando y modo"
```

---

### Task 6: Añadir `python3-venv` al aprovisionamiento del VPS

**Files:**
- Modify: `txpl-setup.sh:86`

**Interfaces:**
- Produces: el instalador deja `python3-venv` disponible para crear `.venv`.

- [ ] **Step 1: Añadir el paquete a la lista de apt**

En `txpl-setup.sh`, en el bloque `apt-get install` (línea 86), añade `python3-venv` a la lista:

```bash
        curl git ca-certificates gnupg build-essential python3 python3-pip python3-venv \
        nginx ufw certbot python3-certbot-nginx sqlite3
```

- [ ] **Step 2: Verificar sintaxis del script**

Run: `bash -n txpl-setup.sh`
Expected: sin salida (sintaxis correcta).

- [ ] **Step 3: Commit**

```bash
git add txpl-setup.sh
git commit -m "chore: instala python3-venv en el aprovisionamiento del VPS"
```

---

### Task 7: Frontend — pausa de confirmación Python (toggle web/worker, selector .py, comando editable)

Solo para proyectos detectados como Python. Tras extraer (ZIP) o crear (Git), el deploy se pausa y muestra controles; al confirmar se llama a `/config` y continúa el pipeline (instalar → arrancar → proxy solo si web).

**Files:**
- Modify: `frontend/index.html` (bloque de confirmación dentro del modal de deploy)
- Modify: `frontend/js/app.js` (función `startDeploy` y helpers nuevos)
- Test: verificación manual en navegador

**Interfaces:**
- Consumes: respuesta de `POST /apps` (Git) y `POST /apps/:id/extract` (ZIP), que ya incluyen `detected` con `{ type, mode, pyFiles, startCmd }` (Tasks 2). Endpoint `POST /apps/:id/config` (Task 5).
- Produces: función `confirmPythonConfig(detected): Promise<{start_cmd, mode}>` que resuelve al pulsar "Continuar".

- [ ] **Step 1: Añadir el bloque de confirmación en `index.html`**

Dentro de `<div class="modal-body" id="deploy-progress" ...>` (línea 721), antes del `<div id="deploy-steps">`, inserta:

```html
      <div id="py-confirm" style="display:none;margin-bottom:14px;padding:12px;border:1px solid var(--border);border-radius:var(--radius)">
        <div style="font-weight:600;margin-bottom:8px"><i class="ti ti-brand-python"></i> Configura tu app Python</div>
        <div class="form-group">
          <label>Tipo de app</label>
          <select id="py-mode">
            <option value="web">Servicio web (puerto + proxy)</option>
            <option value="worker">Worker / Bot (sin puerto)</option>
          </select>
        </div>
        <div class="form-group">
          <label>Archivo de arranque</label>
          <select id="py-file"></select>
        </div>
        <div class="form-group">
          <label>Comando de arranque</label>
          <input type="text" id="py-cmd" placeholder="python bot.py">
          <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Ej.: <code>python bot.py</code>, <code>gunicorn -w 2 app:app</code>, <code>uvicorn main:app --host 0.0.0.0 --port 8000</code></div>
        </div>
        <button class="btn btn-primary" id="py-confirm-btn"><i class="ti ti-check"></i> Continuar despliegue</button>
      </div>
```

- [ ] **Step 2: Añadir el helper `confirmPythonConfig` en `app.js`**

Añádelo cerca de `startDeploy` (p. ej. tras `renderDeploySteps`):

```js
// Pausa el deploy y deja al usuario confirmar comando/modo de una app Python.
// Resuelve con { start_cmd, mode } al pulsar "Continuar".
function confirmPythonConfig(detected) {
  return new Promise((resolve) => {
    const box = document.getElementById('py-confirm');
    const modeEl = document.getElementById('py-mode');
    const fileEl = document.getElementById('py-file');
    const cmdEl = document.getElementById('py-cmd');
    const btn = document.getElementById('py-confirm-btn');

    modeEl.value = detected.mode === 'worker' ? 'worker' : 'web';
    fileEl.innerHTML = (detected.pyFiles || []).map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join('');
    cmdEl.value = detected.startCmd || 'python app.py';
    // Elegir un .py rellena el comando con "python <archivo>"
    fileEl.onchange = () => { if (fileEl.value) cmdEl.value = `python ${fileEl.value}`; };

    box.style.display = 'block';
    btn.onclick = () => {
      const start_cmd = cmdEl.value.trim();
      if (!start_cmd) { toast('Indica el comando de arranque', 'error'); return; }
      box.style.display = 'none';
      btn.onclick = null;
      resolve({ start_cmd, mode: modeEl.value });
    };
  });
}
```

- [ ] **Step 3: Insertar la pausa en `startDeploy`**

En `startDeploy` (app.js ~703), tras el paso de `extract` (que guarda `ext`/`detected`) y, en el caso Git, tras `create` (que devuelve `created.detected`), añade — justo **antes** del paso `install`:

```js
    // Pausa de confirmación solo para proyectos Python
    const detected = (typeof ext !== 'undefined' && ext && ext.detected) || (created && created.detected) || null;
    if (detected && detected.type === 'python') {
      const cfg = await confirmPythonConfig(detected);
      const saved = await req('POST', `/apps/${id}/config`, { type: 'python', start_cmd: cfg.start_cmd, mode: cfg.mode, port, domain });
      if (!saved) { deployLog('✖ No se pudo guardar la configuración'); return; }
      // En worker no hay proxy: marca para saltar el paso proxy más abajo
      window.__pyMode = cfg.mode;
    }
```

Y en el paso `proxy` de `startDeploy`, envuélvelo para que **solo** se ejecute si no es worker:

```js
    if (window.__pyMode !== 'worker') {
      const px = await req('POST', `/apps/${id}/proxy`);
      // ... (lógica existente del paso proxy)
    } else {
      deployLog('Worker/Bot: sin proxy ni puerto.');
    }
```

(Ajusta los nombres `ext`, `created`, `id`, `port`, `domain` a los que ya usa `startDeploy` en tu copia; son los que se leen al principio de la función.)

- [ ] **Step 4: Verificación manual — Worker (bot)**

1. `npm run dev` y entra a `http://localhost:8585`.
2. Sección Apps → Nueva app → sube un ZIP con `bot.py` + `requirements.txt` (con `python-telegram-bot`).
3. Tras "Extraer", aparece el bloque "Configura tu app Python" con modo **worker** preseleccionado, `bot.py` en el selector y `python bot.py` en el comando.
4. Pulsa "Continuar". El log muestra creación de venv (en Linux) y termina sin pedir proxy.

Expected: la app queda creada; en Windows el venv/PM2 lanzará errores controlados (esperado fuera de Linux), pero el flujo y el guardado de config funcionan.

- [ ] **Step 5: Verificación manual — Web (FastAPI)**

Repite con un ZIP que tenga `main.py` + `requirements.txt` con `fastapi`/`uvicorn`: el modo debe preseleccionarse **web**, manteniendo puerto/dominio.

- [ ] **Step 6: Commit**

```bash
git add frontend/index.html frontend/js/app.js
git commit -m "feat: confirmación de despliegue Python (web/worker, selector .py, comando)"
```

---

## Self-Review

**Cobertura del spec:**
- Virtualenv por app → Tasks 2 (install), 3 (arranque), 4 (guard). ✔
- Detección ampliada de entrypoint + modo web/worker → Task 2. ✔
- Selector de `.py` + comando editable → Task 7. ✔
- Toggle web/worker (preseleccionado, editable; oculta puerto/dominio en worker) → Tasks 5 (backend) + 7 (frontend). ✔
- Dependencia `python3-venv` → Task 6. ✔
- Manejo de errores sin `|| true` (la salida real de pip ya se devuelve en `/install` existente; el guard de venv avisa) → Tasks 2/4. ✔
- Sin cambios de esquema (solo nueva prepared statement) → Task 5. ✔

**Placeholders:** ninguno (todo el código está escrito; los pasos de verificación funcional/manual son inevitables por ser PM2/Nginx/venv y frontend sin harness DOM, coherente con "No test suite" del repo).

**Consistencia de tipos:** `detected.{type,mode,pyFiles,startCmd}` se define en Task 2 y se consume en Task 7; `setAppDeployConfig(type,start_cmd,port,domain,id)` se define y usa en Task 5; `buildPm2Launch`/`checkBuildRequirements` mantienen sus firmas de Task 1.
