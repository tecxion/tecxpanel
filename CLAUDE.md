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

Sin linter ni build step. El frontend es vanilla JS servido como estático.
El script `test` de `package.json` usa la forma glob `node --test "backend/test/**/*.test.js"` para recoger automáticamente cualquier `*.test.js` nuevo.

## Architecture

**Backend** — Express REST API + WebSocket server in `backend/server.js`. All routes require JWT auth except `/api/auth/login` and `/api/webhooks/deploy/:secret`.

- `backend/database.js` — SQLite via better-sqlite3 (WAL mode). Schema defined inline. Pre-compiled prepared statements exported as `queries`. Migration is try/catch ALTER TABLE.
- `backend/routes/` — One router per domain:
  - `auth.js` — Login, JWT issuance, password change, TOTP 2FA setup/enable/disable. Factory function that receives JWT_SECRET.
  - `websites.js` — CRUD for Nginx vhosts (static HTML, PHP-FPM, Node proxy, React SPA). Writes Nginx configs directly.
  - `apps.js` — Multi-step deploy pipeline: create (or git clone) → upload zip → extract → install deps → build → start via PM2 → setup Nginx proxy. Supports Node.js, Python, React, TypeScript.
  - `databases.js` — Create/delete MySQL and PostgreSQL databases + users. Passwords encrypted with AES-256-GCM. Also handles phpMyAdmin and Adminer status endpoints.
  - `docker.js` — Container CRUD via Docker UNIX socket (raw HTTP, no docker SDK). Supports Dockerfile builds and docker-compose.
  - `n8n.js` — n8n (Workflows) integration. Lifecycle: install/start/stop/restart/uninstall n8n as a Docker container (`txpl-n8n`, image `n8nio/n8n`, persistent volume `n8n_data`, optional Nginx proxy) via streaming; store connection config (`base_url` + AES-encrypted API key) in the `n8n_config` table; `POST /config` validates the key against n8n before persisting. Orchestration: proxies n8n's Public API (`X-N8N-API-KEY`) to list workflows, activate/deactivate, and read recent executions. Editing workflows is a deep-link to n8n's own UI (no iframe); manual triggering is via a workflow's webhook URL (no generic `/execute`). Pure/testable helpers live in `lib/n8n.js` (`backend/test/n8n.test.js`).
  - `backups.js` — Copias de seguridad gestionadas. Crea backups completos o por recurso (bases de datos, sitios, apps, config del panel), los cataloga en la tabla `backups`, restaura piezas sueltas desde el `manifest.json` con snapshot de seguridad previo (`origin='pre-restore'`), y programa backups por cron (`backup_schedule` + `backup-runner.js`). Streaming con el centinela `__TXPL_DONE__`. Helpers puros en `lib/backups.js`, motor en `lib/backupEngine.js`. (Fase 2) integra destinos remotos vía `lib/backupRemote`: `/remote` (config), `/remote/test`, `/:id/upload`, `/remote/list`, `/remote/:filename/restore`, `DELETE /remote/:filename`. Tras crear un backup con `auto_upload` activo, sube al remoto best-effort. Config remota en la tabla `backup_remote` (credenciales y passphrase cifradas).
  - `cron.js` — Tareas programadas (cron). CRUD de tareas (comando + campos de programación) en la tabla `cron_jobs`, con toggle activar/desactivar y log por tarea (`/var/log/txpl/cron/<id>.log`). La base de datos es la fuente de la verdad: cada mutación reescribe el crontab de root conservando las líneas ajenas (incluida la de `backup-runner.js`) y regenerando solo el bloque marcado `# txpl-cron:`. Helpers puros en `lib/cron.js`.
  - `mail.js` — Correo (docker-mailserver). Instala/gestiona un contenedor `txpl-mail` por el socket de Docker: ciclo de vida (install streaming, config con TLS vía Certbot, start/stop/restart/uninstall), y gestión de buzones/alias/DKIM ejecutando el script `setup` dentro del contenedor por la exec API. El contenedor es la fuente de la verdad; las contraseñas no se persisten. Config (hostname/dominio/dkim) en la tabla `mail_config`. Helpers puros en `lib/mail.js`.
  - `dns.js` — DNS autoritativo (PowerDNS). Instala PowerDNS nativo (apt) con backend SQLite y API HTTP (install streaming: apt + api-key cifrada + esquema + config con `local-address` a la IP pública + UFW 53). Gestiona nameservers (`dns_config`), y zonas/registros (A/AAAA/CNAME/MX/TXT) por la API de PowerDNS por loopback (`X-API-Key`). Incluye glue records y verificación de delegación (`dig NS`). Helpers puros en `lib/dns.js`.
  - `notifications.js` — Notificaciones (Telegram + SMTP). Config en fila única `notify_config` (token/contraseña cifrados), endpoints de prueba por canal y autodetección del chat_id de Telegram (`getUpdates`). Los eventos de estado los vigila `lib/monitor.js` (setInterval 60 s en el proceso del panel: disco, servicios systemd, contenedores `txpl-*`) con transición+recuperación y anti-flapping de 2 ticks (`lib/notifications.js`, puro y testeado) y envío por `lib/notifyExecutor.js`. Hooks puntuales de seguridad en `auth.js` (fuerza bruta, IP nueva vía `audit_log`). Estado por recurso en `notify_state`.
  - `catalog.js` — Catálogo de aplicaciones one-click (WordPress, Ghost, Nextcloud, Vaultwarden, Uptime Kuma). Instala en modo Docker (socket + pull con tag fijado + volumen persistente), nativo PHP-FPM (WordPress en /var/www/<dominio>) o PM2 (Ghost, Uptime Kuma en /opt/txpl-apps), según los modos declarados por app. DB MySQL del host creada vía el módulo databases (usuario con acceso desde 172.17.% para contenedores). Streaming con `__TXPL_DONE__`, rollback best-effort si falla a mitad, registro en `catalog_installs` solo al éxito. Desinstalación con purga de datos/DB opt-in. Helpers puros en `lib/catalog.js`, motor en `lib/catalogEngine.js`.
  - `ssl.js` — Dashboard de certificados SSL (Let's Encrypt). Fuente de la verdad = `certbot`, no la BD: `GET /certificates` parsea `certbot certificates` (dominios, caducidad, estado válido/caduca-pronto/caducado); `POST /:name/renew` (opción `?force=true`), `POST /issue` (dominio nuevo, proxy a `nginx.installSsl`) y `DELETE /:name` (revoca + borra) en streaming `__TXPL_DONE__`. Valida el nombre de certificado (anti-inyección en `--cert-name`). Helpers puros en `lib/ssl.js`.
  - `files.js` — File manager: browse, read, write, upload (binary streaming), mkdir, rename, delete, extract archives.
  - `firewall.js` — UFW rule management.
  - `plugins.js` — Install/uninstall server packages (Docker, phpMyAdmin, Adminer, Redis, Fail2Ban, Composer, Certbot) with streaming output.
  - `system.js` — Server stats (CPU, RAM, disk), service control (systemctl), process list, PHP version detection.
  - `logs.js` — Tail Nginx/system logs + audit log from DB.
  - `webhooks.js` — Public endpoint for Git push auto-deploy (no auth; uses per-app secret).
- `backend/lib/crypto.js` — AES-256-GCM encrypt/decrypt, TOTP implementation (RFC 6238), password generator.
- `backend/lib/helpers.js` — `ok()`, `fail()`, `run()` (execFile wrapper), `runSafe()`, `wrap()` (async error handler).
- `backend/lib/validators.js` — Whitelists, regexes, and validators for domains, ports, app names, DB names, IPs.
- `backend/lib/nginx.js` — Nginx vhost builders (`buildProxy`, `buildSite`, `buildPhpFpmSite`), `enableSite`/`removeSite` (symlink + `nginx -t` + reload), and `installSsl` (Certbot). Reused by `websites.js`, `docker.js`, and `n8n.js`.
- `backend/lib/backups.js` — Helpers puros de backups (manifest, validación de nombres, retención, línea de cron, constructores de argumentos de dump/tar), unit-tested en `backend/test/backups.test.js`.
- `backend/lib/backupEngine.js` — Motor de backups: `createBackup`, `restoreItem`, `readManifest`. Usa los helpers puros + `run`/`runSafe` + `queries`.
- `backend/lib/appdeploy.js` — Helpers puros del pipeline de despliegue de apps (detección de modo Python web/worker por frameworks en `requirements.txt`, entrypoints reconocidos, etc.). Unit-tested en `backend/test/appdeploy.test.js`.
- `backend/lib/rclone.js` — Helpers puros de rclone (env por tipo S3/SFTP, montaje del remoto crypt, args de copy/lsjson/deletefile/lsd/obscure, parseo de lsjson), unit-tested en `backend/test/rclone.test.js`.
- `backend/lib/backupRemote.js` — Ejecutor de rclone: sube/lista/descarga/borra archivos de backup en un remoto (S3/SFTP) leyendo `backup_remote`. Descifra credenciales y las inyecta por env vars del proceso hijo; materializa temporalmente la clave SSH en 0600 si aplica.
- `backend/lib/cron.js` — Helpers puros de cron (validación de campos y de comando, construcción de las líneas de una tarea, reconstrucción del crontab preservando líneas ajenas), unit-tested en `backend/test/cron.test.js`.
- `backend/lib/mail.js` — Helpers puros de correo (validadores de email/dominio/contraseña, config del contenedor docker-mailserver, constructores de argumentos del `setup`, parseo de listados de buzones/alias, y construcción de registros DNS), unit-tested en `backend/test/mail.test.js`.
- `backend/lib/dns.js` — Helpers puros de DNS (validadores de dominio/IP/registro por tipo, `canonical` FQDN, construcción de payloads de zona y de rrset para la API de PowerDNS, contenido de registro por tipo, glue records y parseo de respuestas), unit-tested en `backend/test/dns.test.js`.
- `backend/lib/n8n.js` — Pure n8n helpers (no DB/server state, unit-tested): `buildN8nContainerConfig` (Docker create config), `n8nApi` (HTTP client with injectable fetch), `computeN8nStatus` (not_installed/stopped/needs_config/ready).
- `backend/lib/notifications.js` — Helpers puros de notificaciones (validadores de token/chat/SMTP, transiciones de estado `applyTick` con anti-flapping y reintento, constructores de eventos y mensajes Telegram/email), unit-tested en `backend/test/notifications.test.js`.
- `backend/lib/notifyExecutor.js` — Executor de envío: descifra `notify_config`, `fetch` a la API de Telegram (timeout 10 s) y SMTP vía nodemailer. `dispatch()` nunca lanza; errores logueados sin secretos.
- `backend/lib/catalog.js` — Helpers puros del catálogo (CATALOG declarativo con imagen:tag fijado por app, validación de opciones, config de contenedor, env de DB, wp-config.php, config de Ghost), unit-tested en `backend/test/catalog.test.js`.
- `backend/lib/catalogEngine.js` — Motor del catálogo: instala/desinstala según modo (docker/native/pm2), crea la DB, configura proxy Nginx + SSL y hace rollback si falla.
- `backend/lib/ssl.js` — Helpers puros de SSL (parseo de la salida de `certbot certificates`, clasificación por caducidad, validación de nombre de certificado), unit-tested en `backend/test/ssl.test.js`.
- `backend/lib/monitor.js` — Vigilante integrado (60 s): disco (`df`), servicios (`systemctl is-active`), contenedores `txpl-*` (socket Docker). Sin config no hace nada; en Windows/dev se omiten los chequeos limpiamente.
- `backend/lib/websocket.js` — Two WS endpoints: `/ws/stats` (real-time CPU/RAM/network push every 2s) and `/ws/terminal` (interactive shell via node-pty).

**Frontend** — Single `frontend/index.html` + `frontend/js/app.js` (1700 lines vanilla JS) + `frontend/css/styles.css`. SPA routing via `navigate()` function that toggles page visibility. No framework, no bundler.

**Shell scripts** (for VPS, not for dev):
- `txpl-setup.sh` — Full VPS provisioner (Node, Nginx, PM2, UFW, Certbot, optional MySQL/PG).
- `txpl-update.sh` — Actualización in-place del panel en el VPS (pull + reinstalación de deps + reload PM2).
- `txpl-cli.sh` — Terminal CLI (`txpl status`, `txpl restart`, `txpl logs`, etc.).
- `txpl-backup.sh` — Backup script for DB + configs + sites.
- `txpl-nginx.conf` — Nginx reverse proxy config template for the panel.

**Static assets** — `public/` sirve los logotipos (`logo1.png`, `logo2.png`, `txpanel_logo.png`) usados por el frontend y el login.

## Key Patterns

- **Shell commands always use `execFile` with argument arrays** (never string interpolation) to prevent command injection. Use `run()` or `runSafe()` from `helpers.js`.
- **`execFile` no soporta stdin.** Para pasar datos por stdin (restaurar SQL con `mysql`/`psql`, escribir la clave crypt en `rclone`, etc.) usar un helper `runInput` basado en `spawn`, o escribir a un fichero temporal y pasar la ruta como argumento (patrón usado con `crontab <file>`). NO usar `run(..., { input })` — ignora el input.
- **`run()` tiene timeout por defecto de 30 s.** Para procesos largos (dumps, tar, pull de imágenes, restore) pasar `{ timeout: 0, maxBuffer: N }`; si no, se matan a mitad de camino. El motor de backups aprendió esto por las malas.
- **Arquitectura de 3 capas para features nuevas:** `lib/<feature>.js` (helpers PUROS testeables, sin estado ni DB) + `lib/<feature>Engine.js` o `Executor.js` (efectos: `execFile`, DB, filesystem) + `routes/<feature>.js` (HTTP, JWT ya aplicado). Fila única de config cifrada en su propia tabla (patrón `n8n_config` / `mail_config` / `dns_config` / `backup_remote`).
- **Secrets are encrypted at rest** with AES-256-GCM (`encryptSecret`/`decryptSecret` in `crypto.js`). The encryption key derives from `TXPL_SECRET_KEY` or `JWT_SECRET` via scrypt.
- **Env-vars, no fichero de config, no argv** para pasar secretos a procesos hijos externos (patrón `rclone`): monta `env: { PATH, HOME, LANG, ...RCLONE_CONFIG_TXPL_* }`. Envs mínimos (no heredar `process.env` completo) para no dejar que `RCLONE_*`/`AWS_*` del host pisen la config del panel.
- **Docker socket directo** (`/var/run/docker.sock`) con `http` nativo (patrón de `docker.js`, `n8n.js`, `mail.js`): `dockerRequest(method, path, body)` para la API y `dockerExec(id, cmd)` para el `exec` API (crear exec → start → leer stdout Tty → GET /json para exit code). Sin dependencias de SDK. **Al descargar una imagen**: SIEMPRE pasar `&tag=<version>` a `/images/create` (sin él descarga TODAS las etiquetas del repositorio — decenas de GB).
- **Streaming en respuestas largas** — cabeceras `Content-Type: text/plain`, `X-Accel-Buffering: no`, `res.flushHeaders()`; escribir chunks con `res.write()`; terminar SIEMPRE con `__TXPL_DONE__<code>` (0=éxito). El frontend usa el mismo centinela para saber que acabó. Aplicable a instalar plugins, n8n, mail, dns, restore, subir a remoto.
- **`wrap()` en `helpers.js` honra `e.http`**: si un handler lanza un error con `err.http = 400|409|502|…`, la respuesta usa ese código y expone `err.message` (útil para mensajes de negocio como "El correo no está instalado."). Sin `e.http`, se responde `500 { error: 'Error interno del servidor' }` (no filtra internals).
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
