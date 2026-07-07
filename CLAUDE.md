# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is TecXPaneL

A self-hosted, lightweight VPS control panel for Ubuntu/Debian servers. Manages websites (Nginx), apps (PM2), databases (MySQL/PostgreSQL), Docker containers, firewall (UFW), SSL (Certbot), file browsing, and SSH terminal — all from a single web UI consuming <30 MB RAM.

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

No test suite, no linter, no build step. The frontend is vanilla JS served as static files.

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
  - `backups.js` — Copias de seguridad gestionadas. Crea backups completos o por recurso (bases de datos, sitios, apps, config del panel), los cataloga en la tabla `backups`, restaura piezas sueltas desde el `manifest.json` con snapshot de seguridad previo (`origin='pre-restore'`), y programa backups por cron (`backup_schedule` + `backup-runner.js`). Streaming con el centinela `__TXPL_DONE__`. Helpers puros en `lib/backups.js`, motor en `lib/backupEngine.js`.
  - `cron.js` — Tareas programadas (cron). CRUD de tareas (comando + campos de programación) en la tabla `cron_jobs`, con toggle activar/desactivar y log por tarea (`/var/log/txpl/cron/<id>.log`). La base de datos es la fuente de la verdad: cada mutación reescribe el crontab de root conservando las líneas ajenas (incluida la de `backup-runner.js`) y regenerando solo el bloque marcado `# txpl-cron:`. Helpers puros en `lib/cron.js`.
  - `mail.js` — Correo (docker-mailserver). Instala/gestiona un contenedor `txpl-mail` por el socket de Docker: ciclo de vida (install streaming, config con TLS vía Certbot, start/stop/restart/uninstall), y gestión de buzones/alias/DKIM ejecutando el script `setup` dentro del contenedor por la exec API. El contenedor es la fuente de la verdad; las contraseñas no se persisten. Config (hostname/dominio/dkim) en la tabla `mail_config`. Helpers puros en `lib/mail.js`.
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
- `backend/lib/cron.js` — Helpers puros de cron (validación de campos y de comando, construcción de las líneas de una tarea, reconstrucción del crontab preservando líneas ajenas), unit-tested en `backend/test/cron.test.js`.
- `backend/lib/mail.js` — Helpers puros de correo (validadores de email/dominio/contraseña, config del contenedor docker-mailserver, constructores de argumentos del `setup`, parseo de listados de buzones/alias, y construcción de registros DNS), unit-tested en `backend/test/mail.test.js`.
- `backend/lib/n8n.js` — Pure n8n helpers (no DB/server state, unit-tested): `buildN8nContainerConfig` (Docker create config), `n8nApi` (HTTP client with injectable fetch), `computeN8nStatus` (not_installed/stopped/needs_config/ready).
- `backend/lib/websocket.js` — Two WS endpoints: `/ws/stats` (real-time CPU/RAM/network push every 2s) and `/ws/terminal` (interactive shell via node-pty).

**Frontend** — Single `frontend/index.html` + `frontend/js/app.js` (1700 lines vanilla JS) + `frontend/css/styles.css`. SPA routing via `navigate()` function that toggles page visibility. No framework, no bundler.

**Shell scripts** (for VPS, not for dev):
- `txpl-setup.sh` — Full VPS provisioner (Node, Nginx, PM2, UFW, Certbot, optional MySQL/PG).
- `txpl-cli.sh` — Terminal CLI (`txpl status`, `txpl restart`, `txpl logs`, etc.).
- `txpl-backup.sh` — Backup script for DB + configs + sites.
- `txpl-nginx.conf` — Nginx reverse proxy config template for the panel.

## Key Patterns

- **Shell commands always use `execFile` with argument arrays** (never string interpolation) to prevent command injection. Use `run()` or `runSafe()` from `helpers.js`.
- **Secrets are encrypted at rest** with AES-256-GCM (`encryptSecret`/`decryptSecret` in `crypto.js`). The encryption key derives from `TXPL_SECRET_KEY` or `JWT_SECRET` via scrypt.
- **File manager has path jail** — `safePath()` resolves paths via `path.resolve('/')` to prevent traversal.
- **Apps directory guard** — `removeAppDir()` refuses to delete shallow or forbidden system paths.
- **Audit trail** — `audit(user, ip, action, detail)` logs every mutating action to `audit_log` table.
- **Plugin install streams output** — Uses `spawn` + chunked `res.write()` with `__TXPL_DONE__<code>` sentinel for completion. `n8n.js`'s `POST /install` reuses the same streaming sentinel.
- **No hardcoded secrets (public repo)** — Since the repo is public, no operator secret is baked into code or installers. `txpl-setup.sh` generates fresh `JWT_SECRET`/`ADMIN_PASS` per install (`openssl rand`); the n8n API key is prompted in the UI and stored encrypted, never defaulted.

## Environment

Requires a `.env` file (see `.env.example`). Critical vars: `JWT_SECRET` (min 32 chars), `ADMIN_USER`, `ADMIN_PASS`, `TXPL_PORT` (default 8585). For local dev on Windows, set `TXPL_DIR=./` and `FRONTEND_DIR=./frontend`.

Linux-only features (terminal, firewall, services, Nginx, systemctl) throw controlled errors on Windows — the UI and database work fully for development.

## Language

The project's UI, comments, API error messages, and commit messages are in **Spanish**. Maintain this convention.
