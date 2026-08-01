# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is TecXPaneL

A self-hosted, lightweight VPS control panel for Ubuntu/Debian servers. Manages websites (Nginx), apps (PM2), databases (MySQL/PostgreSQL), Docker containers, firewall (UFW), SSL (Certbot), file browsing, SSH terminal, workflows (n8n), backups (con destinos remotos S3/SFTP), tareas programadas (cron), correo (docker-mailserver), DNS autoritativo (PowerDNS) y catálogo de apps one-click (WordPress, Ghost, Nextcloud, Vaultwarden, Uptime Kuma) — todo desde una única UI web con consumo bajo de RAM.

## Commands

```bash
# Development (local, with --watch hot-reload)
npm run dev          # starts on http://localhost:8585

# Production (on VPS, via PM2)
pm2 start ecosystem.config.js
pm2 reload txpl-panel

# Install deps
npm install
```

```bash
# Tests unitarios (node:test, sin dependencias externas)
npm test                                      # todos los tests
node --test backend/test/n8n.test.js          # un fichero suelto
node --test --test-name-pattern "buildN8n"    # un test por nombre (regex)
```

Sin linter ni build step. El frontend usa ES modules + lit-html (vendor local, sin bundler).
El script `test` de `package.json` usa la forma glob `node --test "backend/test/**/*.test.js"` para recoger automáticamente cualquier `*.test.js` nuevo.

## Architecture (v2.0 — reestructura modular)

**Backend** — Express REST API + WebSocket server in `backend/server.js`. All routes require JWT auth except `/api/auth/login` and `/api/webhooks/deploy/:secret`.

### Capa de datos: `backend/db/`
Desde v2.0 el esquema y los prepared statements viven en `backend/db/`, no en `database.js` (que es un redirect a `db/index.js` para back-compat).
- `backend/db/client.js` — Abre better-sqlite3 (WAL mode, foreign_keys). Singleton `db`.
- `backend/db/schema/*.sql` — Un fichero SQL por tabla (CREATE TABLE IF NOT EXISTS). Aplicados idempotentamente por `migrate.js` en orden alfabético.
- `backend/db/migrations/` — Migraciones numeradas (`0001_initial.sql`, ...). Tabla `_migrations` registra cuáles se aplicaron. Una BD v1 heredada se detecta al primer arranque y marca todas las migraciones como "ya aplicadas" sin reejecutar ALTERs históricos.
- `backend/db/queries/<dominio>.js` — Prepared statements por dominio (`users.js`, `apps.js`, `websites.js`, `n8n.js`, `notify.js`, `mail.js`, `dns.js`, `backups.js`, `cron.js`, `catalog.js`, `docker.js`, `audit.js`, `databases.js`). Agregados en `db/queries/index.js` como objeto `queries` con claves planas (back-compat con v1).
- `backend/db/core.js` — `seedAdmin()` (crea admin desde .env, con reset por `TXPL_RESET_ADMIN_PASS=1`) y `audit(user, ip, action, detail)`.
- API pública: `const { db, queries, seedAdmin, audit, DB_PATH } = require('./database')` sigue funcionando sin tocar los 27 archivos que lo importan.

### Helpers comunes: `backend/lib/common/`
Extracción de `helpers.js` v1 en tres sub-archivos (back-compat via redirect):
- `common/http.js` — `ok()`, `fail()`, `clientIp()`, `wrap()` (async error handler con `e.http`).
- `common/run.js` — `run()`, `runSafe()` (execFile con arrays, anti-inyección) y `runInput(cmd, args, input)` (spawn con stdin, para `mysql < dump.sql`, `psql`, `rclone config`, etc.). `runInput` elimina la duplicación que existía en `backupEngine.js`.
- `common/streaming.js` — `streamStart()`, `streamWrite()`, `streamEnd()`, `DONE_MARKER` (`__TXPL_DONE__`). Antes duplicado en 8 routers (plugins, n8n, mail, dns, ssl, backups, catalog, docker).

### Features por dominio: `backend/lib/<feature>/`
Cada feature con helpers puros y/o motor de efectos vive en su propia subcarpeta con `index.js` que reexporta la API plana v1. Archivos planos en `lib/` son redirects a su `index.js`.

- `lib/docker/` — `socket.js` (`dockerRequest`, `dockerExec`, `dockerConfName`, `DOCKER_SOCKET`, `decodeDockerLogs`), `config.js` (`DEPLOY_TEMPLATES`, `buildContainerConfig`, `flattenSingleSubdir`), `networking.js` (`applyDockerNetworking` — UFW + Nginx proxy + SSL). Reutilizable por `routes/docker.js`, `monitor.js` y otros (antes el patrón `dockerRequest` estaba triplicado).
- `lib/mail/` — `config.js` (constantes + `buildMailContainerConfig`), `validate.js` (validadores email/dominio/password), `setup.js` (constructores args del `setup` + parseo de listados), `dns.js` (`buildDnsRecords`, `mailRecordsToRrsets`), `webmail.js` (config Roundcube). Tests en `backend/test/mail.test.js`.
- `lib/backups/` — `manifest.js` (`BACKUP_DIR`, `isValidBackupFilename`, `parseManifest`, `buildManifest`), `cron.js` (`buildCronLine`, `selectExpiredBackups`), `commands.js` (constructores de args de mysqldump/pg_dump/tar/extract), `engine.js` (`createBackup`, `restoreItem`, `readManifest`), `remote.js` (rclone executor S3/SFTP). Tests en `backend/test/backups.test.js` + `backend/test/backupEngine.test.js`.
- `lib/notifications/` — `index.js` (helpers puros: validadores, `applyTick` anti-flapping, constructores de mensajes; testeado), `monitor.js` (vigilante 60 s: disco, servicios systemd, contenedores `txpl-*`, SSL expiry), `executor.js` (descifra `notify_config`, despacha Telegram + SMTP).
- `lib/catalog/` — `index.js` (CATALOG declarativo, validación, configs), `engine.js` (instalación docker/native/pm2 con rollback). Tests en `backend/test/catalog.test.js`.
- `lib/cron/`, `lib/dns/`, `lib/ssl/`, `lib/n8n/`, `lib/nginx/`, `lib/apps/` — Cada uno con `index.js` (helpers puros) y delegates para engine cuando aplica. `lib/apps/deploy.js` = `appdeploy.js` v1 (helpers Python web/worker).
- Helpers sueltos que siguen en `lib/` (sin subcarpeta, son puros y cortos): `crypto.js`, `validators.js`, `rclone.js`, `dockerDeploy.js`, `logs.js`, `websocket.js`.

### Rutas: `backend/routes/` (sin cambios estructurales en v2)
- `auth.js` — Login, JWT issuance, password change, TOTP 2FA setup/enable/disable. Factory function that receives JWT_SECRET.
- `websites.js` — CRUD for Nginx vhosts (static HTML, PHP-FPM, Node proxy, React SPA). Writes Nginx configs directly.
- `apps.js` — Multi-step deploy pipeline: create (or git clone) → upload zip → extract → install deps → build → start via PM2 → setup Nginx proxy. Supports Node.js, Python, React, TypeScript.
- `databases.js` — Create/delete MySQL and PostgreSQL databases + users. Passwords encrypted with AES-256-GCM. Also handles phpMyAdmin and Adminer status endpoints.
- `docker.js` (router delgado desde v2) — Container CRUD via `lib/docker/socket`. Handlers validan, delegan a `lib/docker/*`, llaman `audit()` y responden `ok()`/`fail()`. Soporta Dockerfile builds, ZIP upload deploy, Git repo deploy (streaming clone + build) y docker-compose.
- `n8n.js`, `backups.js`, `cron.js`, `mail.js`, `dns.js`, `notifications.js`, `catalog.js`, `ssl.js`, `files.js`, `firewall.js`, `plugins.js`, `system.js`, `logs.js`, `webhooks.js` — Igual que v1, pero importan helpers de `lib/<feature>/` en vez de `lib/<feature>.js` plano.

**Frontend** — `frontend/index.html` + `frontend/js/` (ES modules + lit-html vendor local, sin bundler). Estructura v2:
- `index.html` — `<script type="importmap">` para `lit-html` desde `vendor/lit-html/`, más `<script type="module" src="js/main.js">`. Cero `<script src>` inline por página (los v1 se cargan via `import()` dinámico desde `main.js`).
- `js/main.js` — boot: carga templates (sidebar + modals + pages), importa todas las páginas JS como módulos y expone funciones globales para back-compat con las pages v1 (que aún usan `window.fn` + `onclick="..."` inline).
- `js/core/` — helpers compartidos como módulos ES: `api.js`, `utils.js` (`fmtBytes`, `esc`, `emptyState`, `copyText`, `openModal`...), `theme.js` (`themePref`/`applyTheme`/`setThemePref`/`toggleTheme`), `toast.js`, `stream.js` (`streamConsole` con centinela `__TXPL_DONE__`), `router.js` (`navigate` + `PAGE_TABLE` con lazy loaders, `registerPage`).
- `js/<dominio>.js` (v1, módulos ES) — `auth.js`, `dashboard.js`, `docker.js`, `databases.js`, `dns.js`, `files.js`, `firewall.js`, `logs.js`, `mail.js`, `n8n.js`, `notifications.js`, `palette.js`, `plugins.js`, `settings.js`, `ssl.js`, `terminal.js`, `websites.js`, `apps.js`, `catalog.js`, `backups.js`, `cron.js`. Cada módulo termina con `Object.assign(window, { ...funciones })` para exponerlas al scope global — imprescindible porque `index.html` los carga como `type="module"` (las declaraciones `function X(){}` top-level de un módulo ES NO llegan a `window` por sí solas) y las vistas usan handlers `onclick="X()"` inline.
- `frontend/css/styles.css` y vistas parciales en `frontend/views/` (sidebar, modals, `pages/*.html`) cargadas por fetch desde `main.js`. SPA routing vía `navigate()`.
- **Tema claro/oscuro:** variables CSS con selector `[data-theme="light"]`, preferencia en localStorage clave `txpl_theme` (light|dark|system), script anti-flash inline en `<head>` y exportadas desde `core/theme.js`.
- **Command palette global (Ctrl+K / Cmd+K):** `palette.js` con registro declarativo `PALETTE_SECTIONS` (19 secciones + alias en español) y `PALETTE_ACTIONS` (8 acciones), recursos dinámicos con caché de 60 s, verificado por test `frontend-handlers.test.js`.
- **Estados vacíos:** helper `emptyState(icon, message, ctaLabel, ctaOnclick)` en `core/utils.js` aplicado a todos los listados. Los handlers `onclick=` inline resuelven contra el scope global: toda función usada en vistas debe ser global y existir exactamente una vez (test `backend/test/frontend-handlers.test.js`).
- **Migración a lit-html progresiva:** las páginas v1 siguen funcionando con `window.fn` + onclick inline. La migración a `lit-html` (`html\`...\`` + `@click` bindings) se hará página por página en tareas futuras (docker.js primero, por ser la más grande: 26 KB).

**Shell scripts** (for VPS, not for dev):
- `txpl-setup.sh` — Full VPS provisioner (Node, Nginx, PM2, UFW, Certbot, optional MySQL/PG).
- `txpl-update.sh` — Actualización in-place del panel en el VPS (pull + reinstalación de deps + reload PM2).
- `txpl-cli.sh` — Terminal CLI (`txpl status`, `txpl restart`, `txpl logs`, etc.).
- `txpl-backup.sh` — Backup script for DB + configs + sites.
- `txpl-nginx.conf` — Nginx reverse proxy config template for the panel.

**Static assets** — `public/` sirve los logotipos (`logo1.png`, `logo2.png`, `txpanel_logo.png`) usados por el frontend y el login.

## Key Patterns

- **Shell commands always use `execFile` with argument arrays** (never string interpolation) to prevent command injection. Use `run()` or `runSafe()` from `lib/common/run.js` (o `lib/helpers.js` redirect).
- **`execFile` no soporta stdin.** Para pasar datos por stdin (restaurar SQL con `mysql`/`psql`, escribir la clave crypt en `rclone`, etc.) usar `runInput` de `lib/common/run.js`, o escribir a un fichero temporal y pasar la ruta como argumento (patrón usado con `crontab <file>`). NO usar `run(..., { input })` — ignora el input.
- **`run()` tiene timeout por defecto de 30 s.** Para procesos largos (dumps, tar, pull de imágenes, restore) pasar `{ timeout: 0, maxBuffer: N }`; si no, se matan a mitad de camino. El motor de backups aprendió esto por las malas.
- **Arquitectura de 3 capas para features nuevas:** `lib/<feature>/index.js` (helpers PUROS testeables, sin estado ni DB) + `lib/<feature>/engine.js` o `Executor.js` (efectos: `execFile`, DB, filesystem) + `routes/<feature>.js` (HTTP, JWT ya aplicado). Fila única de config cifrada en su propia tabla (patrón `n8n_config` / `mail_config` / `dns_config` / `backup_remote`). Streaming con `lib/common/streaming.js` (`streamStart`/`streamWrite`/`streamEnd`/`DONE_MARKER`).
- **Secrets are encrypted at rest** with AES-256-GCM (`encryptSecret`/`decryptSecret` in `crypto.js`). The encryption key derives from `TXPL_SECRET_KEY` or `JWT_SECRET` via scrypt.
- **Env-vars, no fichero de config, no argv** para pasar secretos a procesos hijos externos (patrón `rclone`): monta `env: { PATH, HOME, LANG, ...RCLONE_CONFIG_TXPL_* }`. Envs mínimos (no heredar `process.env` completo) para no dejar que `RCLONE_*`/`AWS_*` del host pisen la config del panel.
- **Docker socket directo** (`/var/run/docker.sock`) con `http` nativo (patrón de `lib/docker/socket.js`, reutilizado por `_routes/docker.js`, `n8n.js`, `mail.js`): `dockerRequest(method, path, body)` para la API y `dockerExec(id, cmd)` para el `exec` API (crear exec → start → leer stdout Tty → GET /json para exit code). Sin dependencias de SDK. **Al descargar una imagen**: SIEMPRE pasar `&tag=<version>` a `/images/create` (sin él descarga TODAS las etiquetas del repositorio — decenas de GB).
- **Streaming en respuestas largas** — cabeceras `Content-Type: text/plain`, `X-Accel-Buffering: no`, `res.flushHeaders()`; escribir chunks con `res.write()`; terminar SIEMPRE con `__TXPL_DONE__<code>` (0=éxito). El frontend usa el mismo centinela para saber que acabó. Aplicable a instalar plugins, n8n, mail, dns, restore, subir a remoto.
- **`wrap()` en `lib/common/http.js` honra `e.http`**: si un handler lanza un error con `err.http = 400|409|502|…`, la respuesta usa ese código y expone `err.message` (útil para mensajes de negocio como "El correo no está instalado."). Sin `e.http`, se responde `500 { error: 'Error interno del servidor' }` (no filtra internals).
- **File manager has path jail** — `safePath()` resolves paths via `path.resolve('/')` to prevent traversal.
- **Backups y logs: valida el filename ANTES de tocar disco.** `isValidBackupFilename(name)` (regex + rechaza `..`/`/`/`\\`) se aplica en download, delete, restore, ver-log-de-tarea; luego `path.join(BASE_DIR, name).startsWith(BASE_DIR + path.sep)` como defensa en profundidad. `restoreItem` valida además `item.path` extraído del manifest.
- **Apps directory guard** — `removeAppDir()` refuses to delete shallow or forbidden system paths.
- **Audit trail** — `audit(user, ip, action, detail)` logs every mutating action to `audit_log` table. Nunca pasar secretos como `detail`.
- **No hardcoded secrets (public repo)** — Since the repo is public, no operator secret is baked into code or installers. `txpl-setup.sh` generates fresh `JWT_SECRET`/`ADMIN_PASS` per install (`openssl rand`); las API keys/passphrases/tokens se piden en la UI y se guardan cifradas, nunca por defecto.
- **Convivencia con el crontab de root:** cada módulo que escribe crontab **solo elimina SUS propias líneas** al reescribir y conserva el resto. Backups filtra por `backup-runner.js`; cron filtra por el marcador `# txpl-cron:<id>` (más su línea siguiente). Invariante verificado en ambos sentidos.
- **DB como fuente de la verdad** en features donde una config viva vive fuera del panel (crontab, PowerDNS zones, dockermailserver mailboxes, rclone destino): la DB del panel guarda la config *canónica* y cada mutación **proyecta** ese estado al sistema externo. Excepción: docker-mailserver es la fuente para las contraseñas de buzón (nunca se persisten en la DB del panel).

## Cómo añadir una feature nueva

Este repo usa un flujo **spec → plan → implementación por subagentes** con revisiones intermedias y una revisión final (docs bajo `docs/superpowers/`). Recomendado para toda feature no trivial:

1. **Brainstorm + spec** en `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`: motor, decisiones clave, alcance de la fase, avisos honestos al usuario.
2. **Plan TDD** en `docs/superpowers/plans/YYYY-MM-DD-<topic>.md`: tareas bite-sized, código completo por paso, tests con `node:test`, sin placeholders.
3. **Rama `feat/<nombre>`** (nunca en `main`), subagentes por tarea + revisor por tarea + revisor final de rama.
4. **Docs**: actualizar `README.md` y este `CLAUDE.md` como parte del plan (última tarea).
5. **Fusionar a `main` local**, verificar tests, borrar rama, push.

El `docs/` está en `.gitignore` pero los specs/plans ya trackeados se siguen actualizando con `git add -f` cuando son nuevos.

## Environment

Requires a `.env` file (see `.env.example`). Critical vars: `JWT_SECRET` (min 32 chars), `ADMIN_USER`, `ADMIN_PASS`, `TXPL_PORT` (default 8585). For local dev on Windows, set `TXPL_DIR=./` and `FRONTEND_DIR=./frontend`.

Linux-only features (terminal, firewall, services, Nginx, systemctl) throw controlled errors on Windows — the UI and database work fully for development.

## Language

The project's UI, comments, API error messages, and commit messages are in **Spanish**. Maintain this convention.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).
