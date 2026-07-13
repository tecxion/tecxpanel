# Aviso de caducidad SSL + Publicar DNS de correo + Webmail Roundcube — Diseño

**Fecha:** 2026-07-13
**Estado:** Aprobado por el usuario
**Rama:** `feat/correo-ssl-webmail` (tres grupos de tareas independientes)

## Objetivo

Tres mejoras que rematan features existentes:

1. **F1 — Aviso de caducidad SSL**: el monitor integrado avisa por Telegram/SMTP cuando un certificado va a caducar (umbrales 15/7/1 días).
2. **F2 — Publicar registros de correo en DNS**: un clic lleva MX/SPF/DKIM/DMARC de la página Correo a la zona PowerDNS del panel (upsert con resumen previo).
3. **F5 — Webmail Roundcube**: instalación one-click de Roundcube desde la página Correo, conectado al docker-mailserver del panel.

## F1 — Aviso de caducidad SSL

### Decisiones

- Umbrales fijos **15, 7 y 1 días** (elegido por el usuario). Sin UI de umbral; solo un checkbox activar/desactivar.
- Chequeo **una vez cada 24 h** dentro del `tick()` del monitor existente (60 s); un timestamp en memoria del proceso decide si toca (si el panel se reinicia, re-chequea — inofensivo).
- Anti-spam: **un aviso por umbral cruzado y certificado**; no se repite el mismo umbral. Si el cert se renueva (vuelve a >15 días) el estado se resetea y avisa de la recuperación.

### Componentes

- `backend/lib/notifications.js` (puro, unit-tested):
  - `applySslThreshold(prevNotified, daysLeft)` → `{ next, event }` donde `event` ∈ `null | 'threshold' | 'recovered'` y `next` es el umbral notificado a persistir (15/7/1/null). Umbrales `SSL_THRESHOLDS = [15, 7, 1]`.
  - `buildSslExpiryEvent({ name, domains, daysLeft, hostname, recovered })` → `{ title, text }` para Telegram/email (mismo formato que `buildStatusEvent`).
- `backend/lib/monitor.js` (efectos):
  - `checkSslExpiry()`: `runSafe('certbot', ['certificates'])` → `parseCertbotCertificates` (reuso de `lib/ssl.js`) → por cada cert lee `notify_state` clave `sslexp:<name>`, aplica `applySslThreshold`, persiste y despacha con `notifyExecutor.dispatch`. Si certbot no está instalado, sale limpio sin ruido.
  - En `tick()`: ejecutar solo si `cfg.ev_ssl_enabled` y han pasado ≥24 h del último chequeo.
- `backend/database.js`: columna `ev_ssl_enabled INTEGER DEFAULT 1` en `notify_config` (migración try/catch ALTER TABLE, patrón del repo) + incluirla en `upsertNotifyConfig`.
- `backend/routes/notifications.js` + frontend Ajustes: checkbox "Avisar de certificados SSL a punto de caducar".

## F2 — Publicar registros de correo en DNS

### Decisiones

- **Upsert con resumen previo** (elegido por el usuario): el usuario ve qué se creará y qué se sobrescribirá antes de confirmar.
- Requiere: correo configurado (`mail_config` con dominio) y DNS del panel instalado con **la zona del dominio de correo ya creada**. Si falta algo → `409` con mensaje claro (patrón `e.http`).

### Componentes

- `backend/routes/dns.js`: exportar el cliente de la API de PowerDNS (`module.exports.pdnsApi = ...`, patrón export `mysqlExec` de databases.js). Sin cambios de comportamiento.
- `backend/routes/mail.js`:
  - `GET /dns/preview` — construye los registros con `buildDnsRecords` (ya existe en `lib/mail.js`), lee la zona actual por `pdnsApi` y devuelve por registro: `{ type, name, value, action: 'crear' | 'sobrescribir' | 'igual' }`.
  - `POST /dns/publish` — mismo cálculo y upsert de los rrsets (MX, TXT SPF, TXT DKIM, TXT DMARC) vía PATCH a la API loopback de PowerDNS, reutilizando los constructores puros de `lib/dns.js` (`canonical`, payloads de rrset). DKIM solo si ya está generado; si no, se omite con nota en la respuesta. `audit('mail.dns.publish', dominio)`.
- Helpers puros nuevos en `lib/mail.js` si hace falta mapear `buildDnsRecords` → rrsets de PowerDNS (`mailRecordsToRrsets(records, zone)`), unit-tested.
- Frontend página Correo (sección DNS existente): botón **"Publicar en DNS del panel"** → modal con el resumen del preview (crear/sobrescribir/igual) → confirmar → toast + refresco. Si el DNS no está instalado o falta la zona, el botón muestra el aviso con enlace a la página DNS.

## F5 — Webmail Roundcube

### Decisiones

- Vive en la **página Correo** (elegido por el usuario), sección "Webmail", visible solo con el correo instalado.
- Contenedor Docker `txpl-webmail`, imagen `roundcube/roundcubemail` con **tag fijado `1.6-apache`** (minor pinneado, mismo criterio que `ghost:5-alpine` del catálogo — nunca `latest` implícito).
- Conexión al mailserver por su **hostname público** (`mail.<dominio>`): `ROUNDCUBEMAIL_DEFAULT_HOST=ssl://<hostname>:993`, `ROUNDCUBEMAIL_SMTP_SERVER=tls://<hostname>:587`. TLS válido con el cert del mailserver; sin redes Docker custom.
- Volumen persistente `txpl_webmail_data` (config + SQLite interno). Puerto host libre en loopback reutilizando `findFreePort` **ya exportado por `lib/catalogEngine.js`**. Dominio + SSL opcionales (`buildProxy` + `installSsl`).
- Desinstalación con purga de volumen **opt-in**.

### Componentes

- `backend/lib/mail.js` (puro, unit-tested): `buildWebmailContainerConfig({ hostPort, mailHostname, domain })` — config JSON para el socket Docker (patrón `buildN8nContainerConfig`): imagen:tag, env IMAP/SMTP, volumen, puerto publicado SOLO en 127.0.0.1, RestartPolicy unless-stopped, label `txpl.domain` si hay dominio. `WEBMAIL_CONTAINER = 'txpl-webmail'`, `WEBMAIL_VOLUME = 'txpl_webmail_data'`.
- `backend/routes/mail.js`:
  - `GET /webmail/status` — existe/corre el contenedor + config guardada.
  - `POST /webmail/install` — streaming `__TXPL_DONE__`: pull con tag fijado (+progreso), crear contenedor, arrancar, proxy Nginx + SSL opcionales. Requiere correo configurado (409 si no).
  - `POST /webmail/:action` — start|stop|restart.
  - `DELETE /webmail` — para/borra contenedor, `?volume=true` borra el volumen, quita vhost.
- `backend/database.js`: columnas en `mail_config` (migración): `webmail_domain TEXT`, `webmail_port INTEGER`, `webmail_container TEXT`.
- Frontend página Correo: tarjeta Webmail con instalar (modal: dominio opcional + SSL), estado, abrir, start/stop/restart, desinstalar (purga opt-in). Streaming en `<pre>` (patrón n8n).

## Manejo de errores (común)

- Validación previa antes de tocar el sistema; errores de negocio con `err.http`.
- F5: rollback best-effort si la instalación falla a mitad (borrar contenedor creado); la config solo se persiste al éxito.
- F1: `dispatch()` nunca lanza (garantía existente de notifyExecutor); errores de certbot se loguean sin tumbar el tick.

## Tests

- `backend/test/notifications.test.js` (ampliar): `applySslThreshold` — cruces de umbral, no-repetición, recuperación, casos borde (daysLeft null/0). `buildSslExpiryEvent`.
- `backend/test/mail.test.js` (ampliar): `buildWebmailContainerConfig` (imagen:tag, env, loopback, volumen); `mailRecordsToRrsets` si se crea.
- Sin tests de rutas/efectos (convención del repo).

## Fuera de alcance

- Umbrales SSL configurables por UI.
- Webmail nativo (apt) o multi-instancia.
- Sincronización inversa DNS→Correo.
- Renovación automática forzada del cert al avisar (el usuario decide desde la página SSL).

## Docs

`README.md` y `CLAUDE.md` se actualizan como última tarea del plan.
