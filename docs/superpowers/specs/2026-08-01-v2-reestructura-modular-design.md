# Diseño — TecXPaneL v2.0 (reestructura + modularidad + pilares de producto)

**Fecha:** 2026-08-01
**Estado:** Borrador (pendiente de aprobación antes de tocar código)
**Versión destino:** 2.0.0
**Versión origen:** 1.0.0 (commit `1c9712d`)

## Contexto

TecXPaneL 1.0 es funcional y sólido en seguridad (execFile con arrays,
AES-256-GCM, audit log, rate limit, validación de inputs), en arquitectura
(3 capas `lib` puro + `Engine` + `routes`), y en tests (`node:test` sobre
los helpers puros). El problema **no** es de funcionalidad, es de
**escalabilidad del propio código** a medida que añade features de paneles
de referencia (Coolify, RunTipi, Ploi, ServerAvatar):

1. **Archivos monolito.** `backend/routes/docker.js` = **56 KB / 38 símbolos**
   con `attemptClone` (755), `deployGitHandler` (626), `buildContainerConfig`
   (146) mezclando routing HTTP + lógica de build + clone git + networking UFW
   + persistencia. Cualquier cambio tira del scroll. Frontera de "un fichero
   por dominio" respetada en ruta, rota en `lib`: faltan subcarpetas por
   feature (`lib/docker/`, `lib/mail/`...) y los `Engine.js` sueltos no caben.
2. **`backend/database.js` = 502 líneas** con esquema inline (15+ tablas en un
   `db.exec` gigante) + 250 líneas de prepared statements monolíticas en un
   único objeto `queries`. Sin migraciones numeradas: la "migración" actual es
   `try/catch ALTER TABLE` disperso entre módulos. Imposible de auditar.
3. **`frontend/js/core.js` y socios** = vanilla JS con `onclick="fn('...')"`
   inline. Cada handler se resuelve contra `window` global y el test
   `frontend-handlers.test.js` es lo único que evita el problema. No hay
   encapsulación, no hay imports, no hay tipos de eventos. Una feature nueva
   "ensucia" `core.js`.
4. **Sin cola de trabajos persistente.** Los despliegues/backup/restore largos
   viven en stream HTTP; si el panel se reinicia a mitad, el badge queda
   `running` para siempre y el proceso hijo se queda huérfano.
5. **Punto único de fallo.** Un solo VPS, un solo panel, un solo admin. Para
   equipos/SaaS hace falta multi-usuario con roles (RBAC) y, más adelante,
   multi-nodo con agente remoto.

El objetivo de v2.0 **no** es reescribir desde cero (la base sirve), sino
**reorganizar + añadir los 3 pilares que faltan** sin romper lo que ya
funciona, en ramas por fase con revisión intermedia.

## Alcance

### Incluido (Fase 1 — esta spec aprueba solo esta)

Reorganización estructural **sin cambio de comportamiento visible**. Sub-tareas:

1. **Subcarpetas por dominio en `backend/lib/`**: del modelo plano
   `lib/<feature>.js` + `lib/<feature>Engine.js` al modelo anidado:
   ```
   backend/lib/
     docker/      -> index.js, deploy.js (clone+build+template), socket.js (dockerRequest),
                     config.js (buildContainerConfig), networking.js (applyDockerNetworking)
     mail/        -> index.js, setup.js, dns.js, webmail.js  (split del actual mail.js)
     backups/     -> index.js, manifest.js, engine.js, remote.js, cron.js
     cron/        -> index.js, parser.js, crontab.js
     catalog/     -> index.js (CATALOG), engine.js, db.js
     dns/         -> index.js, api.js, zones.js, records.js
     ssl/         -> index.js, parser.js, certbot.js
     notifications/ -> index.js, monitor.js, executor.js, telegram.js, smtp.js
     nginx/       -> index.js (+ builders existentes)
     n8n/         -> index.js, api.js, config.js, status.js
     common/      -> crypto.js, helpers.js, validators.js, streaming.js, run.js
   ```
   Cada subcarpeta exporta un `index.js` que reexporta la misma API pública
   que hoy exponen los ficheros planos. **Los `require('../lib/docker')`
   existentes en `routes/*.js` siguen funcionando sin tocarlos.**

2. **Refactor de `backend/routes/docker.js`** (56 KB → ~8 KB de router puro).
   Toda la lógica de build/clone/networking baja a `lib/docker/`. El router
   queda como enrutado + extract args + delegar + `audit()` + `ok()/fail()`.

3. **`backend/database.js` se parte en**:
   ```
   backend/db/
     client.js        -> abre better-sqlite3, WAL, foreign_keys, exporta `db`
     schema/          -> un fichero SQL por tabla (users.sql, apps.sql, ...,
                         n8n_config.sql, backups.sql, ...). Aplicados con un
                         runner que lee `schema/*.sql` en orden alfabético =
                         idempotente (CREATE TABLE IF NOT EXISTS).
     migrations/      -> 0001-initial.sql, 0002-rbac.sql, ... (copias literales
                         de los ALTER TABLE hoy dispersos). Tabla `_migrations`.
     queries/         -> un módulo por dominio (users.js, apps.js, docker.js...)
                         que exporta sus prepared statements concretos.
     index.js         -> reexporta `db`, `queries` (objeto agregado =
                         retrocompatible) y `audit`.
   ```
   `require('./database')` desde `server.js` y routes sigue funcionando.

4. **Frontend: ES modules + lit-html sin build step.**
   ```
   frontend/
     index.html             -> <script type="module" src="/js/main.js"></script>
     js/
       main.js              -> boot, route table, lazy import de cada page
       core/                -> api.js, auth.js, theme.js, modal.js, utils.js, toast.js
       pages/
         dashboard.js  -> export async function render(el, ctx) {...}
         docker.js  ...
       components/           -> lit-html components reutilizables
         empty-state.js, table.js, badge.js, modal.js, code-block.js
       services/             -> wrappers de API tipados con jsdoc
   ```
   - **Cero build step.** Import maps para `lit-html` desde CDN o lib local
     copiada a `vendor/lit-html/lit-html.js`.
   - **Cero framework de componentes** salvo `lit-html` (render declarativo,
     sin virtual DOM, 5 KB). NO se introducirá ReactiveController, LitElement
     ni web components pesados por ahora; solo `render(template, container)`.
   - Los `onclick="fn('x')"` inline se eliminan: cada tabla/lista renderiza
     con `lit-html` y bindea listeners con `@click`.
   - El test `frontend-handlers.test.js` se actualiza a un test de "tabla de
     rutas existe y cada página exporta `render`".
   - **`frontend/views/` (HTML parcial cargado por fetch)** se elimina en
     favor de plantillas lit-html inline. Es el único cambio disruptive y
     se hace página a página.

5. **TypeScript NO.** Backend sigue JS puro con jsdoc. Frontend ES modules
   + jsdoc. `check-types` vía `tsc --noEmit --allowJs --checkJs` se deja como
   objetivo de la Fase 2, no de esta.

### Excluido (Fases siguientes — specs aparte)

- **Fase 2 — RBAC + API keys con scopes.** Tabla `roles`, `permissions`,
  `user_roles`, `api_keys` (con hash salado y scopes `websites:write`,
  `apps:read`...). `auth.js` deja de asumir `role='admin'`. Frontend
  añade UI de gestión de usuarios/invitaciones. **No incluido en esta spec.**
- **Fase 3 — Cola de trabajos persistente.** Tabla `jobs` con estado,
  progreso y `attempts`. Worker en proceso hijo (`worker_pool.js`) simple y
  reanudable al reiniciar. Reemplaza el streaming `__TXPL_DONE__` por WS de
  progreso estructurado. **No incluido.**
- **Fase 4 — Multi-server + agente `txpl-agent`.** API cliente de
  servidores remotos con JWT mutuo. Requiere Fase 2 (RBAC) y Fase 3 (jobs).
  **No incluido.**
- **Fase 5 — Producto:** stack templates ampliados (Laravel, Django, Rails,
  Astro, SvelteKit, Bun, Deno, Go), GitOps con preview environments,
  métricas (Prometheus node_exporter + dashboard interno),
  logs centralizados (victorialogs), Traefik/Caddy alternativo a Nginx,
  secrets manager (SOPS), registry privado, audit exportable, snapshots
  ZFS/Btrfs, autoescalado de apps PM2, CLI remoto `txpl`.
  **Cada uno spec aparte, no incluido.**

## Decisiones clave

- **Retrocompatibilidad es innegociable.** Tras cada sub-tarea, `npm test`
  pasa en verde y `npm run dev` arranca igual. Un operador con la v1.0 no
  debe notar nada al actualizar a 2.0 salvo que mire `git log`.
- **Mover, no reescribir.** Esta fase no arregla bugs ni mejora lógica.
  Si una función se mueve y de paso se hace más limpia, **NO** — se mueve
  literal y el cleanup va en otra tarea. Difícil de respetar pero crítico
  para revisar diffs finitos.
- **Sin build step en frontend.** El USP de este panel es "live edit en
  producción vía SSH". Vite/SvelteKit lo mataría. ES modules + import maps
  dan modularidad sinvendors pesados.
- **`lit-html` sí, Lit no.** lit-html es 5 KB y no requiere compilar;
  LitElement necesita el compilador de decoradores. Mantener la barrera
  baja: import maps + lit-html + jsdoc.
- **Subcarpetas, no flat con prefijo.** `lib/docker_deploy.js` hubiera
  sido menos trabajo pero no escala: en 6 meses tendríamos 40 ficheros
  planos en `lib/`. La subcarpeta con `index.js` es el modelo del propio
  Node.js interno y de Express.
- **Migraciones con runner sencillo, no lib externa.** `node-sqlite-migrate`
  o `Knex` añaden dependencias y opinan sobre SQL. Una tabla `_migrations`
  + 20 líneas de runner que ejecuta `*.sql` numeradas es suficiente y
  auditable. El propio `backups.js` ya usa este patrón implícito.
- **No se versiona la API en v2.0** (es decir, no se añade `/api/v2/`).
  No hay clientes externos ainda y meter versionado ahora es over-engineering.
  El `api/v2` llega en Fase 2 con las API keys (allí sí conviene).
- **Sin TypeScript.** Elección del usuario confirmada. El check de tipos
  vendrá por `tsc --checkJs` en Fase 2 opcional, no en esta.

## Modelo de datos

**Sin cambios de esquema en Fase 1.** Solo se reapunta dónde vive el SQL:
de "esquema inline + ALTER dispersos" a `schema/*.sql` + `migrations/*.sql`.
El contenido de las tablas es idéntico.

## Componentes y cambios

### 1. `backend/lib/common/` (nuevo)

Extracción de helpers compartidos sin acoplamiento. Hoy `helpers.js` mezcla
`run`/`runSafe` (exec) con `ok`/`fail`/`wrap` (express) con `clientIp`.
Split:
- `common/run.js` — `run`, `runSafe`, `runInput` (helper spawn con stdin).
- `common/http.js` — `ok`, `fail`, `wrap`, `clientIp`.
- `common/streaming.js` — el centinela `__TXPL_DONE__`, helper
  `streamStart(res)` / `streamEnd(res, code)` / `streamWrite(res, chunk)`.
  Hoy está duplicado en 6 routers (`plugins.js`, `n8n.js`, `mail.js`,
  `dns.js`, `backups.js` restore, `ssl.js`). DRY respetuoso.
- `common/crypto.js`, `common/validators.js` — movidos literal.

### 2. `backend/lib/docker/` (nuevo, split de `routes/docker.js`)

- `socket.js` — `dockerRequest`, `dockerExec`, `dockerGet` (compartido con
  monitor y mail: hoy está triplicado).
- `config.js` — `buildContainerConfig`, `DEPLOY_TEMPLATES`,
  `flattenSingleSubdir`.
- `deploy.js` — `attemptClone`, `flattenSingleSubdir`, el flujo
  "clone → build → start" extraído de `deployGitHandler`.
- `networking.js` — `applyDockerNetworking` (UFW + Nginx proxy).
- `dockerfile.js` — endpoints globales `/dockerfile` y `/compose`.
- `index.js` — reexporta API pública.

`routes/docker.js` queda con ~25 handlers que solo: validan, llaman a
`lib/docker/*`, `audit()`, `ok()`.

### 3. `backend/lib/mail/` (split de `lib/mail.js`)

`lib/mail.js` hoy es 25 KB con validación + setup de contenedor + DNS +
webmail todo junto. Split en `mail/index.js`, `mail/container.js`,
`mail/mailbox.js`, `mail/dns.js`, `mail/webmail.js`.

### 4. `backend/lib/backups/` (split de backups.js + backupEngine.js)

`backups/` — `manifest.js`, `engine.js`, `remote.js`, `cron.js`. La lógica
de retención y validación de nombre (hoy duplicada entre ruta y motor)
queda en un `validate.js`.

### 5. `backend/db/`

Descrito arriba. El `audit()` se mueve a `db/audit.js` (huge hoy embebido
en `database.js`).

### 6. `frontend/js/main.js` + estructura en módulos

```
index.html slema:
  <script type="importmap">
    { "imports": { "lit-html": "/vendor/lit-html/lit-html.js" } }
  </script>
  <script type="module" src="/js/main.js"></script>
```

`main.js`:
```js
import { initAuth, getToken } from './core/auth.js';
import { route } from './core/router.js';

route('dashboard', () => import('./pages/dashboard.js'));
route('docker',    () => import('./pages/docker.js'));
// ...
initAuth();
```

`pages/docker.js`:
```js
import { html, render } from 'lit-html';
import { listContainers, action } from '../services/docker.js';

export async function render(container) {
  const list = await listContainers();
  render(container, html`
    <table>...</table>
    ${list.map(c => html`<tr @click=${() => action(c.Id,'start')}>...</tr>`)}
  `);
}
```

### 7. Tests

Los tests `backend/test/*.test.js` **no se tocan** excepto:
- nuevos test para `common/streaming.js` (`__TXPL_DONE__` forma correcta).
- `frontend-handlers.test.js` se actualiza a verificar tabla de rutas.
- Se añaden tests para cada `db/queries/<dominio>.js` que validen que los
  prepared statements compilan (sanity check).

## Plan por tareas (cada una = un commit)

Cada tarea vive en una rama `feat/v2-NN-<nombre>` y/o como paso:

1. `feat/v2-01-db-folder` — partir `database.js` en `db/`. Tests pasan.
2. `feat/v2-02-common-folder` — extraer `lib/common/` (run/http/streaming).
   Los routers migran sus `require` uno a uno. Tests pasan.
3. `feat/v2-03-docker-split` — split de `routes/docker.js` en `lib/docker/`.
   El router baja de 56 KB a ~8 KB. Tests existentes pasan + 1 nuevo test
   de `flattenSingleSubdir` (que hoy no tiene cobertura).
4. `feat/v2-04-mail-split` — split `lib/mail.js` → `lib/mail/*`.
5. `feat/v2-05-backups-split` — split `lib/backups.js`/`backupEngine.js` →
   `lib/backups/`. Eliminar duplicación de validación de nombre.
6. `feat/v2-06-notifications-split` — split最适合 `notifications.js`/`monitor.js`/
   `notifyExecutor.js` → `lib/notifications/*`.
7. `feat/v2-07-resto-features-split` — cron, dns, ssl, catalog, n8n, nginx.
8. `feat/v2-08-frontend-esm-core` — `<script type="module">`, `main.js`,
   `core/*` con import maps + lit-html copy. `views/` sigue funcionando en
   paralelo durante esta transición.
9. `feat/v2-09-frontend-pages-migrate` — migrar 1 página/PR a lit-html
   (docker primero, por ser la más grande: `frontend/js/docker.js` 26 KB).
10. `feat/v2-10-resto-paginas` — las 20 páginas restantes, una por commit.
11. `feat/v2-11-docs-update` — `README.md` + `CLAUDE.md` reflectando nueva
    estructura.
12. `feat/v2-12-version-bump` — `package.json` 1.0.0 → 2.0.0.

Cada PR con revisor intermedio (subagente). Revisión final de rama antes
de fusionar a `main`.

## Riesgos y mitigación

- **Rotura de imports en refactor.** Cada tarea incluye tests + arranque
  `npm run dev` manual. Si algo se rompe, el diff es lo bastante pequeño
  para revertir en segundos. **Hacer una tarea por vez, no batch.**
- **Frontend vanilla → ES modules** rompe el test
  `frontend-handlers.test.js`. Se actualiza al nuevo modelo en la misma
  tarea, no se deja roto.
- **`require('../../lib/common/http')`** vs rutas relativas profundas =
  rutas feas. Mitigación: usar `module-alias` (ya usado en otros paquetes
  npm) o un helper `require('txpl/lib/...')`. **Decisión: NO añadir
  aliases ahora**, rutas relativas estándar; si se vuelven molestas se
  resuelve en Fase 2.
- **Performance de ES modules en dev.** 40 archivos JS servidos en 40
  peticiones. En producción añadir `<link rel="modulepreload">`. En dev
  sin HTTPS el navegador los cachea por hash. Aceptable.
- **`lit-html` desde vendor local vs CDN.** CDN introduce dependencia de
  red en producción. **Decisión: copiar lit-html a `frontend/vendor/`** y
  actualizar con un script `npm run vendor:update`.
- **Rollback.** Cada commit atómico reversible. Si tras 2.0.0 encuentra
  bug grave, revert el commit concreto no toda la v2.0.
- **Breaking change invisible**: aunque la API pública de `lib` se
  mantiene via `index.js`, algúno de mis colegas podría haber hecho
  `require('../../lib/backups.js')` directo a no-index en algún sitio no
  indexado por codegraph. Mitigación: tras el split, antes de borrar los
  antiguos, dejar redirects (`module.exports = require('./<folder>/index')`)
  durante 1 release.

## Avisos honestos al operador

1. **Esta fase no añade features nuevas visibles.** El objetivo es que
   los paneles v2.0 y v1.0 se vean y se comporten idénticos. Si lo que
   quieres es "más botones en la UI", esperamos a Fase 5. Si lo que
   quieres es "que el código respire", esto es lo que toca.
2. **El frontend cambia.** La SPA de un archivo con `views/` se parte en
   módulos. Cualquier personalización que hayas hecho en `core.js` queda
   en `core/utils.js` pero con `export`.
3. **Reorganizar no es seguro al 100%.** Haremos tests + arranque en cada
   commit, pero el `ALTER TABLE` disperso actual significa que hubo
   migraciones implícitas ninguna documentación. La nueva carpeta
   `db/migrations/0001-initial.sql` hace un "snapshot" del esquema tal cual
   está hoy en producción, no un clon limpio. Operas con una BD existente:
   `_migrations` se marca como "ya aplicadas todas" en el primer arranque.
4. **No esperes RBAC ni multi-server todavía.** Es Fase 2 y 4. Esta spec
   solo allana el camino para que quepan.
5. **El trabajo grande es el split del frontend.** ~15-20 commits sólo
   ahí. Si te parece excesivo, recorta el alcance a "solo backend split"
   y dejamos el frontend en Fase 1.5.

## Cómo medir el éxito

- `npm test` verde al final de cada tarea.
- `git diff --stat main..feat/v2-12-version-bump` muestra MOVIMIENTO
  (líneas eliminadas ≈ líneas añadidas en archivos .js nuevos), no
  reescritura masiva.
- No se añade ninguna dependencia npm nueva (lit-html se copia a vendor).
- Tiempo de `node --check` sobre el código: idéntico o mejor.
- Un dev externo entiende `lib/docker/` en <5 min leyendo `index.js`.

## Próximos pasos tras aprobación

1. Crear rama `feat/v2-00-spec` con solo este archivo, push.
2. Crear rama `feat/v2-01-db-folder` hija, implemntarla con subagente
   + revisor, PR, merge a `feat/v2-00-spec`.
3. Repetir por cada tarea.
4. Revisión final de rama `feat/v2-00-spec` → merge a `main` con
   tag `v2.0.0` y `txpl-update.sh` actualizado si hace falta.
