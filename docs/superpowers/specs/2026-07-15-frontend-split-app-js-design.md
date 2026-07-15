# Spec: partir `frontend/js/app.js` en ficheros por dominio

**Fecha:** 2026-07-15
**Estado:** aprobado (diseño validado en conversación)

## Motivación

`frontend/js/app.js` tiene 3.771 líneas y ~200 funciones. Todo el frontend vive en un único fichero, lo que dificulta la navegación, las revisiones y los diffs. Las funciones ya están agrupadas por dominio de forma natural (cada grupo mapea 1:1 con una ruta del backend y una vista de `frontend/views/pages/*.html`), así que el corte es mecánico y de bajo riesgo.

## Decisiones clave

1. **Split simple, sin build step.** Varios `<script>` clásicos que comparten el scope global. Fiel al principio del proyecto (vanilla JS, sin bundler). Se descartaron módulos ES (obligarían a reconectar los 122 handlers `onclick=` inline) y bundler (rompe "sin build step").
2. **Granularidad: un fichero por dominio.** ~21 ficheros de 60–430 líneas. Se descartaron bundles temáticos (ficheros aún grandes) y sub-división de dominios grandes (demasiadas piezas).
3. **Refactor puramente mecánico.** Mismo comportamiento, mismas funciones globales, mismo acoplamiento por scope global. Solo mejora la navegabilidad. El paso a dependencias explícitas (módulos ES) queda fuera de alcance.

## Restricciones verificadas

- 122 handlers inline `onclick=`/`onchange=`/… en `frontend/views/**` y `frontend/index.html` resuelven contra el scope global **al hacer clic** — con `<script>` planos no se toca ninguno.
- `bootApp()` corre en `DOMContentLoaded`, que dispara tras parsear todos los `<script>` → todo definido a tiempo.
- Estado global compartido (`API`, `TOKEN`, `statsWS`, `currentPage`, `serverIp`) usado por varios dominios → vive en `core.js` (carga primero).
- Estado local de dominio (`deployZipFile`, `dbTools`, `currentFilePath`, `logsSrc`, `term`, `_dnsZone`, `currentDockerTab`, …) ya está junto a sus funciones → se mueve con su fichero.

## Estructura de ficheros (`frontend/js/`)

`core.js` carga **primero**. El orden del resto es indiferente.

| Fichero | Contenido |
|---|---|
| `core.js` | Globals compartidos (`API`, `TOKEN`, `statsWS`, `currentPage`, `serverIp`), `req`, `toast`, `fmtBytes`, `fmtDate`, `esc`, `openModal`/`closeModal`, `navigate`, `initApp`, `copyText`/`fallbackCopy`, `streamConsole`, `bindModalOverlayEvents`, `bootApp`, `loadTemplates` (fetch de parciales) |
| `auth.js` | `doLogin`, `togglePassVis`, recuperación de contraseña (`showForgotPasswordForm`, `fetchSecurityQuestion`, `submitResetPassword`, `showLoginForm`), `doLogout`, `checkAuth`, 2FA |
| `dashboard.js` | `drawSparkline`, historiales cpu/mem/net, `connectStatsWS`, `loadDashboard`, `loadServices`, `svcAction`, `loadProcesses` |
| `websites.js` | `loadWebsites`, `toggleSiteMode`, `togglePhpVersion`, `createWebsite`, `deleteWebsite` |
| `apps.js` | `loadApps`, pipeline de deploy (`setupDeployDrops` … `startDeploy`, `resetDeployModal`), `appAction`, `viewAppLogs`, consola de app, `installApp`, git/webhook (`openGitInfoModal`, `copyWebhookUrl`, `triggerGitPull`) |
| `databases.js` | `loadDatabases`, `toggleDbPass`, `openTool`, `createDatabase`, `deleteDatabase`, `setupPma`, `dbTools`/`dbPassShown` |
| `files.js` | `loadFiles`, breadcrumb, drag&drop, subida binaria/carpetas, `createFolder`/`createFile`, `browseDir`, `deleteFile`, `extractFile`, `editFile`/`saveFile` |
| `firewall.js` | `loadFirewall`, `createRule`, `deleteRule` |
| `ssl.js` | `loadSSL`, `SSL_CAT`, `sslRenew`, `sslDelete`, `sslIssue`, `sslStream` |
| `settings.js` | `loadSettings`, `saveRecovery`, `changePassword` |
| `notifications.js` | `loadNotifyConfig`, `collectNotifyForm`, `syncSmtpPort`, `saveNotifyConfig`, `testNotify`, `detectTgChat` |
| `logs.js` | `loadLogsPage`, selección de fuente, `logsFetch`/`logsRender`, modo en vivo, `logsDownload` |
| `terminal.js` | `initTerminal`, resize/cleanup, estado `term`/`fitAddon`/`termWS` |
| `plugins.js` | `loadPlugins`, `installPlugin`, `uninstallPlugin`, `streamPlugin` |
| `n8n.js` | `loadN8n`, workflows/ejecuciones, `n8nInstall`, `n8nSaveConfig`, `n8nAction`, `n8nToggleWorkflow`, `n8nUninstall`, `n8nOpenBase` |
| `catalog.js` | `loadCatalog`, `catalogInstallModal`, `catalogInstall`, `catalogAction`, `catalogUninstallModal`/`catalogUninstallGo`, `catalogStream`, `CATALOG_MODE_LABELS` |
| `backups.js` | `loadBackups`, config remota (`loadBackupRemote` … `backupRemoteDelete`), `backupNow`, `backupRestore`, `backupDownload`, `backupDelete`, `saveBackupSchedule`, `backupUpload`, `loadRemoteBackups` |
| `mail.js` | `mailStream`, `loadMail`, install/acciones/uninstall, config, buzones, alias, DKIM, DNS de correo (`mailLoadDns`, `mailDnsPreview`, `mailDnsPublish`), webmail (`loadWebmail`, `webmailInstall`, `webmailAction`, `webmailUninstall`) |
| `dns.js` | `dnsStream`, `loadDns`, `dnsInstall`, `dnsSaveConfig`, zonas (`loadDnsZones`, `dnsAddZone`, `dnsDeleteZone`, `dnsOpenZone`), registros (`dnsRecTypeChange`, `loadDnsRecords`, `dnsAddRecord`, `dnsDeleteRecord`), `dnsDelegation`, `_dnsZone` |
| `cron.js` | `cronPresetChange`, `cronScheduleFromForm`, `cronResetForm`, `loadCron`, `cronSave`, `cronEdit`, `cronToggle`, `cronDelete`, `cronViewLog` |
| `docker.js` | `loadDockerContainers`, `dockerAction`, `viewDockerLogs`, tabs, `onDeployTemplateChange`, `createDockerContainer`, `deployDockerApp`, `deleteDockerContainer`, editor Dockerfile/compose (`openDockerEditModal`, `saveDockerFile`) |

Notas de reubicación:
- `copyText`/`fallbackCopy` (hoy L3239, entre cron y docker) y `streamConsole` (L2565, entre backups) son genéricos usados por varios dominios → `core.js`.
- `openGitInfoModal`/`copyWebhookUrl`/`triggerGitPull` (L3657+) operan sobre apps → `apps.js`.
- `loadTemplates` (L3703) hace el fetch de `views/sidebar.html`, `views/modals.html` y páginas → `core.js` junto a `bootApp`.
- Si al extraer aparece una función usada por 2+ dominios no listada aquí, va a `core.js` (regla general).

## Carga en `index.html`

Reemplazar la línea única

```html
<script src="js/app.js?v=20260615f4"></script>
```

por la lista ordenada (con `core.js` primero y cache-busting `?v=` por fichero):

```html
<script src="js/core.js?v=YYYYMMDD"></script>
<script src="js/auth.js?v=YYYYMMDD"></script>
<script src="js/dashboard.js?v=YYYYMMDD"></script>
<!-- … resto de dominios, orden indiferente … -->
```

Coste: ~21 peticiones HTTP en vez de 1 al cargar el panel. Estáticos, cacheables, servidos por el propio panel — impacto despreciable.

## Estrategia de migración

Incremental, un dominio por commit, panel funcional en cada paso:

1. Crear `js/core.js` con globals + helpers compartidos; añadir su `<script>` antes de `app.js`; borrar ese bloque de `app.js`. Verificar login + navegación.
2. Por cada dominio: crear `js/<dominio>.js` con sus funciones + estado local; añadir `<script>`; borrar el bloque de `app.js`; smoke test de esa página (cargar vista + una acción clave).
3. Cuando `app.js` quede vacío: borrarlo y quitar su `<script>`.
4. Actualizar `CLAUDE.md` (sección Frontend) y `README.md` si procede.

Durante la migración `app.js` convive con los nuevos ficheros (scope global compartido, sin conflicto mientras cada función exista exactamente una vez).

## Verificación

No hay tests de frontend. Red de seguridad:

1. **Test automatizado nuevo** (`backend/test/frontend-handlers.test.js`, `node:test`, sin dependencias): extrae todos los nombres de handler inline (`onclick=`, `onchange=`, `oninput=`, `onsubmit=`, `onkeyup=`, `onkeydown=`) de `frontend/views/**` y `frontend/index.html`, y comprueba que cada uno está **definido exactamente una vez** en el conjunto de ficheros de `frontend/js/`. Detecta funciones huérfanas (borradas de `app.js` pero no movidas) y duplicadas (movidas sin borrar el original) tras cada corte. Corre con `npm test`.
2. **Smoke test manual** por página tras cada extracción.
3. `nginx`/backend no cambian; no hay nada que verificar en servidor.

## Fuera de alcance

- Módulos ES / import-export explícitos.
- Bundler o build step.
- Cambiar handlers inline por `addEventListener`.
- Refactor de lógica interna de ninguna función.
