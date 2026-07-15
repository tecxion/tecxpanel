# Partir `frontend/js/app.js` por dominio — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Partir `frontend/js/app.js` (3.771 líneas, ~200 funciones) en ~21 ficheros por dominio que comparten scope global, sin cambiar ningún comportamiento.

**Architecture:** `<script>` clásicos ordenados en `index.html` (core primero); todas las funciones siguen siendo globales; los 122 handlers `onclick=` inline no se tocan. Migración incremental: un dominio por commit, panel funcional en cada paso. `app.js` convive con los nuevos ficheros hasta quedar vacío.

**Tech Stack:** Vanilla JS (sin bundler, sin build step), `node:test` para el test de red de seguridad.

**Spec:** `docs/superpowers/specs/2026-07-15-frontend-split-app-js-design.md`

## Global Constraints

- Sin bundler, sin build step, sin módulos ES. Solo `<script>` clásicos.
- No modificar ningún handler inline en `frontend/views/**` ni `frontend/index.html`.
- No cambiar la lógica interna de ninguna función: mover bloques **verbatim** (incluidos comentarios adyacentes al bloque).
- UI, comentarios y mensajes de commit en **español**.
- Cada fichero nuevo empieza con un comentario de cabecera de una línea: `// TecXPaneL — <dominio> (<qué cubre>)`.
- Cache-busting: todos los `<script>` nuevos usan `?v=20260715`.
- Tras cada tarea: `node --check` de los ficheros tocados + `npm test` en verde.
- **Regla de reubicación:** si al extraer aparece una función usada por 2+ dominios no prevista aquí, va a `core.js`.
- Los números de línea de este plan son del `app.js` en el commit `a6caa29`. **Cada tarea borra líneas de `app.js`, así que los números se desplazan: localiza siempre los bloques por nombre de función, no por número.** Los rangos son orientación del orden original.

---

### Task 1: Rama + test de red de seguridad (handlers inline)

**Files:**
- Create: `backend/test/frontend-handlers.test.js`

**Interfaces:**
- Produces: test `npm test` que valida que (a) todo handler inline invocado en HTML/JS del frontend está definido en algún fichero de `frontend/js/`, y (b) ninguna función está definida más de una vez en el conjunto. Es la red que valida todas las tareas siguientes.

- [ ] **Step 1: Crear la rama**

```bash
git checkout -b feat/frontend-split-appjs
```

- [ ] **Step 2: Escribir el test**

Crear `backend/test/frontend-handlers.test.js` con este contenido exacto:

```js
// Test de red de seguridad para el split de frontend/js/app.js:
// (a) todo handler inline (onclick=, onchange=, ...) usado en las vistas o en
//     templates JS debe estar definido en algún fichero de frontend/js/
// (b) ninguna función puede estar definida más de una vez en el conjunto
//     (detecta bloques movidos sin borrar el original, o borrados sin mover)
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');

function walk(dir, ext) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, ext));
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

// Nombres que pueden aparecer invocados en un handler pero no son funciones nuestras
const BUILTINS = new Set(['event', 'this', 'window', 'document', 'alert', 'confirm', 'prompt']);

// Extrae nombres de función invocados dentro de atributos on*="..."
function handlerCalls(text) {
  const names = new Set();
  const attrRe = /\bon(?:click|change|input|submit|keyup|keydown|blur|load)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = attrRe.exec(text))) {
    const body = m[1];
    const callRe = /(^|[^\w$.])([a-zA-Z_$][\w$]*)\s*\(/g;
    let c;
    while ((c = callRe.exec(body))) {
      const name = c[2];
      if (!BUILTINS.has(name)) names.add(name);
    }
  }
  return names;
}

// Extrae nombres de función definidos a nivel superior en un fichero JS
function definedFunctions(text) {
  const names = [];
  const declRe = /^(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)/gm;
  const arrowRe = /^(?:const|let)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s*)?\(/gm;
  let m;
  while ((m = declRe.exec(text))) names.push(m[1]);
  while ((m = arrowRe.exec(text))) names.push(m[1]);
  return names;
}

test('handlers inline: definidos exactamente una vez en frontend/js/', () => {
  const htmlFiles = [
    path.join(FRONTEND, 'index.html'),
    ...walk(path.join(FRONTEND, 'views'), '.html'),
  ];
  const jsFiles = walk(path.join(FRONTEND, 'js'), '.js');

  // Handlers usados: en HTML estático y en templates dentro del propio JS
  const used = new Set();
  for (const f of [...htmlFiles, ...jsFiles]) {
    for (const n of handlerCalls(fs.readFileSync(f, 'utf8'))) used.add(n);
  }

  // Definiciones: conteo global por nombre en todos los JS del frontend
  const defCount = new Map();
  for (const f of jsFiles) {
    for (const n of definedFunctions(fs.readFileSync(f, 'utf8'))) {
      defCount.set(n, (defCount.get(n) || 0) + 1);
    }
  }

  const missing = [...used].filter((n) => !defCount.has(n));
  assert.deepStrictEqual(missing, [], `Handlers sin definición: ${missing.join(', ')}`);

  const dupes = [...defCount].filter(([, c]) => c > 1).map(([n]) => n);
  assert.deepStrictEqual(dupes, [], `Funciones definidas más de una vez: ${dupes.join(', ')}`);
});
```

- [ ] **Step 3: Ejecutar y verificar que pasa (baseline verde con app.js monolítico)**

```bash
npm test
```

Esperado: PASS (incluido `handlers inline: definidos exactamente una vez en frontend/js/`). Nota TDD: aquí el verde es el baseline; el rojo de este test es la señal de fallo durante las tareas 2–22. Si falla ya en baseline, los nombres listados en el mensaje indican falsos positivos del regex (p. ej. un builtin no contemplado): añadirlos a `BUILTINS` y justificar en el commit.

- [ ] **Step 4: Commit**

```bash
git add backend/test/frontend-handlers.test.js
git commit -m "test(frontend): red de seguridad de handlers inline para el split de app.js"
```

---

### Task 2: `core.js` + lista de scripts en `index.html`

**Files:**
- Create: `frontend/js/core.js`
- Modify: `frontend/js/app.js` (borrar los bloques movidos)
- Modify: `frontend/index.html:202` (scripts)

**Interfaces:**
- Produces: globals `API`, `TOKEN`, `statsWS`, `currentPage`, `serverIp`; helpers `req`, `toast`, `fmtBytes`, `fmtDate`, `esc`, `openModal`, `closeModal`, `navigate`, `initApp`, `copyText`, `fallbackCopy`, `streamConsole`, `loadTemplates`, `bindModalOverlayEvents`, `bootApp`. Todos los ficheros de dominio (Tasks 3–21) los consumen vía scope global.

- [ ] **Step 1: Crear `frontend/js/core.js`** moviendo **verbatim** desde `app.js` (localizar por nombre; rangos originales como guía):

  1. Cabecera del fichero y globals (`API`, `TOKEN`, `statsWS`, `currentPage`, `serverIp`) — L1–16
  2. `req` (L24), `toast` (L36), `fmtBytes` (L44), `fmtDate` (L52), `esc` (L58), `openModal` (L66), `closeModal` (L70)
  3. `navigate` (L271), `initApp` (L315)
  4. `streamConsole` (L2565) — genérico, hoy entre las funciones de backups
  5. `copyText` (L3239), `fallbackCopy` (L3251) — genéricos, hoy entre cron y docker
  6. `loadTemplates` (L3703), `bindModalOverlayEvents` (L3744), `bootApp` (L3750–fin, incluida la línea que lo engancha a `DOMContentLoaded` si va fuera de la función)

  Primera línea del fichero: `// TecXPaneL — núcleo compartido (globals, req, toast, navegación, boot)`. Borrar cada bloque de `app.js` al moverlo.

- [ ] **Step 2: Actualizar `index.html`.** Sustituir `<script src="js/app.js?v=20260615f4"></script>` por:

```html
<script src="js/core.js?v=20260715"></script>
<script src="js/app.js?v=20260715"></script>
```

- [ ] **Step 3: Verificar sintaxis y tests**

```bash
node --check frontend/js/core.js && node --check frontend/js/app.js && npm test
```

Esperado: sin errores de sintaxis, tests PASS (sin huérfanos ni duplicados).

- [ ] **Step 4: Smoke test manual**

```bash
npm run dev
```

Abrir `http://localhost:8585`: login funciona, sidebar carga, navegar a 2–3 páginas. Parar el servidor.

- [ ] **Step 5: Commit**

```bash
git add frontend/js/core.js frontend/js/app.js frontend/index.html
git commit -m "refactor(frontend): extraer núcleo compartido a js/core.js"
```

---

### Tasks 3–21: extraer cada dominio (patrón común)

Cada una de las tareas siguientes repite exactamente estos 5 pasos, cambiando solo el fichero, la lista de funciones y el mensaje de commit:

- [ ] **Step 1:** Crear `frontend/js/<dominio>.js` con cabecera `// TecXPaneL — <dominio>` moviendo **verbatim** las funciones y el estado listados (localizar por nombre), borrándolos de `app.js`.
- [ ] **Step 2:** Añadir `<script src="js/<dominio>.js?v=20260715"></script>` en `index.html`, después de `core.js` y antes de `app.js`.
- [ ] **Step 3:** `node --check frontend/js/<dominio>.js && node --check frontend/js/app.js && npm test` → PASS.
- [ ] **Step 4:** Smoke manual: `npm run dev`, abrir la página del dominio, ejecutar la acción indicada.
- [ ] **Step 5:** `git add frontend/js/<dominio>.js frontend/js/app.js frontend/index.html && git commit -m "refactor(frontend): extraer <dominio> a js/<dominio>.js"`

Contenido exacto por tarea:

### Task 3: `auth.js`
**Mover:** `doLogin` (L83), `togglePassVis` (L106), `showForgotPasswordForm` (L128), `showLoginForm` (L151), `fetchSecurityQuestion` (L160), `submitResetPassword` (L192), `doLogout` (L242), `checkAuth` (L255).
**Smoke:** logout + login (con y sin contraseña errónea).

### Task 4: `dashboard.js`
**Mover:** estado `maxSamples`, `cpuHistory`, `memHistory`, `netRxHistory`, `netTxHistory` (L324–328); `drawSparkline` (L331), `connectStatsWS` (L385), `loadDashboard` (L428), `loadServices` (L462), `svcAction` (L487), `loadProcesses` (L496).
**Smoke:** dashboard pinta sparklines y stats en vivo.

### Task 5: `websites.js`
**Mover:** `loadWebsites` (L512), `toggleSiteMode` (L539), `togglePhpVersion` (L559), `createWebsite` (L565), `deleteWebsite` (L586).
**Smoke:** página Sitios lista los sitios; abrir modal de crear.

### Task 6: `apps.js`
**Mover:** `loadApps` (L595), `updateAppPathPreview` (L627), estado `deployZipFile`/`deployEnvFile` (L635–636), `setupDeployDrops` (L640), `bindDeployDrop` (L646), `deployLog` (L665), `renderDeploySteps` (L672), `confirmPythonConfig` (L682), estado `currentDeployTab` (L707), `switchDeployTab` (L710), `startDeploy` (L720), `resetDeployModal` (L864), `appAction` (L884), `viewAppLogs` (L893), estado `consoleAppId` (L901), `openAppConsole` (L904), `runAppCommand` (L914), `consoleKeydown` (L937), `installApp` (L942); y el bloque git/webhook: estado `gitInfoAppId` (L3654), `openGitInfoModal` (L3657), `copyWebhookUrl` (L3673), `triggerGitPull` (L3679).
**Smoke:** página Apps lista apps; abrir modal de deploy y de info git.

### Task 7: `databases.js`
**Mover:** estado `dbTools`/`dbPassShown` (L959–960), `loadDatabases` (L963), `toggleDbPass` (L999), `openTool` (L1019), `deleteDatabase` (L1035), `createDatabase` (L1043), `setupPma` (L1060).
**Smoke:** página Bases de datos lista; toggle de contraseña.

### Task 8: `files.js`
**Mover:** estado `currentFilePath` (L1068), `loadFiles` (L1071), `updateBreadcrumb` (L1122), `getFileIcon` (L1137), estado `dragDropBound` (L1148), `setupDragDrop` (L1150), `handleDrop` (L1186), `handleFileUpload` (L1213), `showProgress` (L1219), `hideProgress` (L1235), `readEntryAsFile` (L1241), `readDirEntries` (L1246), `flattenEntry` (L1260), `uploadBinary` (L1279), `processEntries` (L1290), `uploadFlatFiles` (L1325), `createFolder` (L1351), `createFile` (L1361), `browseDir` (L1371), `deleteFile` (L1377), `extractFile` (L1386), `editFile` (L1396), `saveFile` (L1425).
**Smoke:** navegar directorios y abrir un fichero en el editor.

### Task 9: `firewall.js`
**Mover:** `loadFirewall` (L1434), `createRule` (L1455), `deleteRule` (L1467).
**Smoke:** página Firewall lista reglas.

### Task 10: `ssl.js`
**Mover:** `SSL_CAT` (L1478), `loadSSL` (L1483), `sslRenew` (L1536), `sslDelete` (L1539), `sslIssue` (L1543), `sslStream` (L1551).
**Smoke:** página SSL carga (aunque Certbot no esté en dev, pinta el aviso).

### Task 11: `settings.js`
**Mover:** `loadSettings` (L1585), `saveRecovery` (L1610), `changePassword` (L1626).
**Smoke:** página Ajustes carga formularios.

### Task 12: `notifications.js`
**Mover:** `loadNotifyConfig` (L1642), `collectNotifyForm` (L1664), `syncSmtpPort` (L1688), `saveNotifyConfig` (L1696), `testNotify` (L1707), `detectTgChat` (L1715).
**Smoke:** sección Notificaciones (en Ajustes) carga la config.

### Task 13: `logs.js`
**Mover:** estado `logsSrc`/`logsRaw`/`logsTimer` (L1726–1728), `loadLogsPage` (L1732), `logsSelect` (L1747), `logsSelectApp` (L1755), `logsSelectSite` (L1762), `logsApplySelection` (L1773), `logsFetch` (L1788), `logsRender` (L1811), `logsLiveToggle` (L1826), `logsLiveStop` (L1832), `logsDownload` (L1839).
**Smoke:** página Logs lista fuentes.

### Task 14: `terminal.js`
**Mover:** estado `term`/`fitAddon`/`termWS` (L1852), `sendResize` (L1855), `termResizeHandler` (L1861), `termCleanup` (L1866), `initTerminal` (L1873).
**Smoke:** página Terminal (en dev/Windows pinta el error controlado, no rompe).

### Task 15: `plugins.js`
**Mover:** `loadPlugins` (L1915), `installPlugin` (L1941), `uninstallPlugin` (L1947), `streamPlugin` (L1955).
**Smoke:** página Plugins lista el estado de los paquetes.

### Task 16: `n8n.js`
**Mover:** `n8nOpenBase` (L2007), `loadN8n` (L2011), `loadN8nWorkflows` (L2080), `loadN8nExecutions` (L2103), `n8nInstall` (L2118), `n8nSaveConfig` (L2175), `n8nAction` (L2185), `n8nToggleWorkflow` (L2193), `n8nUninstall` (L2202).
**Smoke:** página Workflows carga estado.

### Task 17: `catalog.js`
**Mover:** `CATALOG_MODE_LABELS` (L2214), `loadCatalog` (L2217), `catalogInstallModal` (L2267), `catalogInstall` (L2311), `catalogAction` (L2320), `catalogUninstallModal` (L2329), `catalogUninstallGo` (L2361), `catalogStream` (L2373).
**Smoke:** página Catálogo lista las apps.

### Task 18: `backups.js`
**Mover:** `loadBackups` (L2433), `loadBackupRemote` (L2461), `backupRemoteTypeChange` (L2478), `backupRemoteEncryptToggle` (L2484), `backupRemoteSave` (L2488), `backupRemoteTest` (L2517), `backupRemoteClear` (L2522), `backupUpload` (L2528), `loadRemoteBackups` (L2533), `backupRemoteRestore` (L2549), `backupRemoteDelete` (L2557), `backupNow` (L2588), `backupRestore` (L2598), `backupDownload` (L2608), `backupDelete` (L2622), `saveBackupSchedule` (L2628). **Nota:** `streamConsole` (L2565) ya se movió a `core.js` en Task 2 — no debe estar aquí.
**Smoke:** página Backups lista copias y config remota.

### Task 19: `mail.js`
**Mover:** `mailStream` (L2644), `loadMail` (L2667), `mailInstall` (L2735), `mailAction` (L2742), `mailUninstall` (L2743), `loadWebmail` (L2749), `webmailInstall` (L2775), `webmailAction` (L2784), `webmailUninstall` (L2790), `mailSaveConfig` (L2799), `loadMailboxes` (L2807), `mailAddMailbox` (L2820), `mailPassword` (L2829), `mailDeleteMailbox` (L2836), `loadAliases` (L2842), `mailAddAlias` (L2853), `mailDeleteAlias` (L2862), `mailGenDkim` (L2868), `mailLoadDns` (L2875), `mailDnsPreview` (L2893), `mailDnsPublish` (L2926).
**Smoke:** página Correo carga estado (incluida la tarjeta webmail).

### Task 20: `dns.js`
**Mover:** `dnsStream` (L2935), `loadDns` (L2958), `dnsInstall` (L3014), `dnsSaveConfig` (L3021), `loadDnsZones` (L3032), `dnsAddZone` (L3045), `dnsDeleteZone` (L3053), estado `_dnsZone` (L3060), `dnsOpenZone` (L3061), `dnsRecTypeChange` (L3069), `loadDnsRecords` (L3074), `dnsAddRecord` (L3088), `dnsDeleteRecord` (L3102), `dnsDelegation` (L3108).
**Smoke:** página DNS carga estado.

### Task 21: `cron.js` y `docker.js` (dos commits)

**cron.js — mover:** `cronPresetChange` (L3125), `cronScheduleFromForm` (L3134), `cronResetForm` (L3154), `loadCron` (L3164), `cronSave` (L3185), `cronEdit` (L3199), `cronToggle` (L3216), `cronDelete` (L3222), `cronViewLog` (L3229).
**Smoke:** página Cron lista tareas. Commit: `refactor(frontend): extraer cron a js/cron.js`.

**docker.js — mover:** `loadDockerContainers` (L3269), `dockerAction` (L3336), `viewDockerLogs` (L3348), estado `currentDockerTab` (L3357), `switchDockerTab` (L3359), `onDeployTemplateChange` (L3377), `createDockerContainer` (L3395), `deployDockerApp` (L3466), `deleteDockerContainer` (L3571), estado `currentDockerEditType` (L3583), `openDockerEditModal` (L3586), `saveDockerFile` (L3618).
**Smoke:** página Docker lista contenedores (o el aviso de Docker no instalado en dev). Commit: `refactor(frontend): extraer docker a js/docker.js`.

---

### Task 22: retirar `app.js` vacío + docs

**Files:**
- Delete: `frontend/js/app.js`
- Modify: `frontend/index.html` (quitar el `<script>` de app.js)
- Modify: `CLAUDE.md` (sección Architecture → Frontend)
- Modify: `README.md` (si menciona `app.js` como fichero único)

- [ ] **Step 1: Verificar que `app.js` quedó vacío** (solo comentarios/líneas en blanco):

```bash
grep -cE '\S' frontend/js/app.js
```

Esperado: 0, o solo restos de comentarios sueltos. Si queda alguna función, pertenece al dominio que la usa (o a `core.js` si la usan varios) — moverla antes de seguir.

- [ ] **Step 2: Borrar `app.js` y su `<script>`**

```bash
git rm frontend/js/app.js
```

Y eliminar `<script src="js/app.js?v=20260715"></script>` de `index.html`.

- [ ] **Step 3: Actualizar `CLAUDE.md`.** Sustituir la sección Frontend por:

```markdown
**Frontend** — `frontend/index.html` + `frontend/js/` (vanilla JS sin bundler: `core.js` con globals/helpers compartidos carga primero, más un fichero por dominio — `auth.js`, `dashboard.js`, `websites.js`, `apps.js`, `databases.js`, `files.js`, `firewall.js`, `ssl.js`, `settings.js`, `notifications.js`, `logs.js`, `terminal.js`, `plugins.js`, `n8n.js`, `catalog.js`, `backups.js`, `mail.js`, `dns.js`, `cron.js`, `docker.js` — que comparten scope global vía `<script>` ordenados) + `frontend/css/styles.css` + vistas parciales en `frontend/views/` (sidebar, modals, `pages/*.html`) cargadas por fetch desde `core.js`. SPA routing vía `navigate()`. No framework, no bundler. Los handlers `onclick=` inline resuelven contra el scope global: toda función usada en vistas debe ser global y existir exactamente una vez (test `backend/test/frontend-handlers.test.js`).
```

Actualizar `README.md` solo si describe `app.js` como fichero único.

- [ ] **Step 4: Verificación final completa**

```bash
node --check frontend/js/core.js && for f in frontend/js/*.js; do node --check "$f" || exit 1; done && npm test
```

Esperado: todo PASS. Smoke final: `npm run dev`, login, visitar todas las páginas del sidebar una a una.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(frontend): retirar app.js — split por dominio completado"
```

---

## Cierre de rama

Al terminar: seguir `superpowers:finishing-a-development-branch` (merge a `main` local, verificar `npm test`, borrar rama, push), como indica `CLAUDE.md`.
