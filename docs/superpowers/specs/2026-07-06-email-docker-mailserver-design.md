# Diseño: Correo (docker-mailserver) — Fase 1

Fecha: 2026-07-06
Estado: aprobado (pendiente de plan de implementación)

## Objetivo

Añadir un módulo de **correo electrónico** al panel, estilo Plesk pero acorde a
la identidad ligera de TecXPaneL. Motor: **docker-mailserver** (un solo
contenedor con Postfix + Dovecot + Rspamd + DKIM), gestionado íntegramente desde
el panel: instalar/arrancar/parar/desinstalar, configurar hostname + TLS +
puertos, crear/borrar buzones y alias, generar DKIM y mostrar los registros DNS
a añadir. El panel ES la interfaz de gestión (no hay UI ajena que replicar) y el
contenedor es la fuente de la verdad de los buzones.

## Decisiones tomadas

- **Motor: docker-mailserver** (no Mailcow). Un contenedor `txpl-mail`, imagen
  `ghcr.io/docker-mailserver/docker-mailserver:latest`, ~1 GB RAM. Se descartó
  Mailcow por su peso (~4-6 GB, ~30 contenedores) frente a la identidad ligera
  del panel.
- **Feature dividida en fases.** Esta es la **Fase 1** ("correo funcional
  gestionable").
- **TLS**: reusar el Certbot del panel para el hostname del correo y montar
  `/etc/letsencrypt` en el contenedor (`SSL_TYPE=letsencrypt`). Sin una segunda
  ACME.
- **UFW**: abrir 25, 465, 587, 143, 993 en la instalación, vía el módulo de
  firewall del panel.
- **Buzones/alias**: el contenedor es la fuente de la verdad; el panel lo
  acciona por la **Docker socket exec API** (sin depender del CLI de docker,
  coherente con `docker.js`), ejecutando el script `setup` de docker-mailserver.
- **Contraseñas nunca persistidas** en la DB del panel (el contenedor guarda solo
  el hash).

Fuera de alcance (Fase 2): webmail (Roundcube), cuotas por buzón, catch-all,
integración automática con el módulo DNS (cuando exista), multi-dominio avanzado.

## Arquitectura (3 capas, patrón n8n)

- `backend/lib/mail.js` — **helpers puros y testeables** (sin estado ni DB):
  - `buildMailContainerConfig({ hostname, letsencryptDir })` — config para la
    Docker API `/containers/create`: imagen, env (`SSL_TYPE=letsencrypt`,
    `PERMIT_DOCKER`, `ENABLE_RSPAMD`, `ENABLE_OPENDKIM=0`/DKIM por Rspamd, etc.),
    `Hostname`, `ExposedPorts` y `PortBindings` (25/465/587/143/993), `Binds`
    (volúmenes mail-data/state/config/logs + `/etc/letsencrypt` en solo lectura).
  - `MAIL_CONTAINER = 'txpl-mail'`, `MAIL_IMAGE`, `MAIL_PORTS` (constantes).
  - `isValidEmail(addr)`, `isValidMailDomain(d)`, `isValidMailPassword(p)` —
    validación estricta (forma del email, dominio, contraseña no vacía sin
    espacios/saltos de línea).
  - `parseEmailList(text)` — parsea la salida de `setup email list` a un array
    `[{ address }]`.
  - `parseAliasList(text)` — parsea `setup alias list` a `[{ source, destination }]`.
  - `buildSetupArgs(...)` — construye el array de argumentos para el `setup`
    dentro del contenedor (email add/del/update, alias add/del, config dkim).
  - `buildDnsRecords({ domain, hostname, serverIp, dkimPublic, dkimSelector })`
    — devuelve los registros a mostrar: MX, SPF (`v=spf1 mx ~all`), DKIM (TXT con
    la clave), DMARC (`v=DMARC1; p=quarantine; ...`), y una nota del PTR (rDNS).
- `backend/routes/mail.js` — router `/api/mail` (JWT):
  - `GET /status` — estado (not_installed/stopped/needs_config/ready).
  - `POST /install` (streaming) — descarga imagen + crea contenedor + abre UFW +
    (si hay hostname con DNS) intenta el cert TLS.
  - `POST /config` — guarda hostname/dominio; (re)emite el cert TLS con Certbot.
  - `POST /:action` — start/stop/restart.
  - `DELETE /` — desinstala (para y elimina el contenedor; conserva u opcional
    borra volúmenes — por defecto conserva los datos de correo).
  - `GET /mailboxes`, `POST /mailboxes`, `PUT /mailboxes/:addr` (cambiar
    contraseña), `DELETE /mailboxes/:addr`.
  - `GET /aliases`, `POST /aliases`, `DELETE /aliases`.
  - `POST /dkim` — genera DKIM y guarda la clave pública.
  - `GET /dns` — devuelve los registros DNS a añadir.
- `backend/database.js` — tabla `mail_config` (fila única, id=1): `hostname`,
  `domain`, `container_id`, `status`, `dkim_selector`, `dkim_public`,
  `created_at`.

Reutiliza: el patrón de streaming con centinela `__TXPL_DONE__` y el acceso a la
Docker socket de `routes/docker.js`/`routes/n8n.js`; `installSsl` de `lib/nginx.js`
para el cert; el módulo de firewall para abrir puertos.

## Ciclo de vida y configuración

1. **Instalar** (`POST /install`, streaming): descarga la imagen (con `&tag=`
   fijo, como n8n, para no bajar todas las etiquetas), crea `txpl-mail` con
   `buildMailContainerConfig`, abre los puertos en UFW y arranca. Registra la
   fila en `mail_config`.
2. **Configurar** (`POST /config`): guarda hostname (`mail.tudominio.com`) y
   dominio; emite el certificado TLS con Certbot (`installSsl`), que
   docker-mailserver consume vía `SSL_TYPE=letsencrypt` (volumen `/etc/letsencrypt`).
3. **Arrancar/parar/reiniciar/desinstalar** como n8n.

## Buzones y alias

Todas las operaciones ejecutan el script `setup` **dentro del contenedor** vía la
Docker socket exec API (crear exec → iniciar → leer stream):

- Crear buzón: `setup email add <address> <password>`.
- Borrar buzón: `setup email del <address>`.
- Cambiar contraseña: `setup email update <address> <password>`.
- Listar buzones: `setup email list` → `parseEmailList`.
- Alias: `setup alias add|del <source> <destination>`; listar → `parseAliasList`.

La contraseña se valida (`isValidMailPassword`) y se pasa como argumento del
exec; **no se guarda** en la DB. El email/dominio se validan antes de accionar.

## DKIM y DNS

- **Generar DKIM** (`POST /dkim`): ejecuta `setup config dkim` en el contenedor;
  el panel lee el fichero de clave pública generado (en el volumen de config) y
  guarda `dkim_public` + `dkim_selector` en `mail_config`.
- **Registros DNS** (`GET /dns`): `buildDnsRecords` devuelve MX (→ hostname,
  prioridad 10), SPF, DKIM (TXT con la clave pública), DMARC y la nota del PTR
  (rDNS, que se solicita al proveedor del VPS). La UI los muestra para
  copiar-pegar. La automatización llegará con el módulo DNS.

## Frontend

Nuevo item **"Correo"** en el sidebar → `frontend/views/pages/mail.html`
(cargada por `loadTemplates`), lógica en `frontend/js/app.js`:

- Vista adaptativa según el estado (sin Docker → not_installed → stopped →
  needs_config → ready), como n8n.
- En estado ready: formulario de configuración (hostname), gestión de **buzones**
  (tabla + crear/borrar/cambiar contraseña), **alias**, botón de **generar DKIM**
  y una tarjeta con los **registros DNS**.
- Consola de streaming para la instalación.
- Todo dato externo (direcciones, dominios) se escapa con `esc()`.

## Seguridad

- **Zero shell interpolation**: la exec API recibe arrays de argumentos; nada de
  cadenas para una shell. Validación estricta de email/dominio/contraseña antes
  de accionar el contenedor.
- **Contraseñas de buzón no persistidas** (solo el hash vive en el contenedor).
- **Auditoría** (`audit`) en instalar/desinstalar, alta/baja de buzón, cambio de
  contraseña, alta/baja de alias y generación de DKIM.
- **Puertos UFW**: solo los del correo; se abren explícitamente en la instalación.
- Sin secretos hardcodeados (coherente con el repo público).

## Pruebas

Tests unitarios de `backend/lib/mail.js` con `node:test`:

- `isValidEmail` / `isValidMailDomain` / `isValidMailPassword`: aceptan válidos,
  rechazan basura, espacios y saltos de línea.
- `buildMailContainerConfig`: imagen, puertos (25/465/587/143/993), volúmenes
  (incluye `/etc/letsencrypt`), env `SSL_TYPE=letsencrypt`, hostname.
- `parseEmailList` / `parseAliasList`: parsean la salida real del `setup` a
  arrays estructurados; toleran líneas vacías/ruido.
- `buildDnsRecords`: MX, SPF, DKIM (con la clave), DMARC con los valores
  esperados a partir de dominio/hostname/IP/clave.

## Notas honestas (a documentar)

- El correo **no funciona de verdad** hasta que los registros DNS (sobre todo MX
  y PTR) estén puestos — inherente al email autohospedado.
- Enviar a Gmail/Outlook desde una IP de VPS nueva puede ir a spam hasta
  "calentar" la reputación de la IP.
- Requiere Docker (desde Plugins) y RAM suficiente (~1 GB para el contenedor).

## Patrones reutilizados del código existente

- Streaming con centinela `__TXPL_DONE__` y acceso a la Docker socket (de
  `routes/docker.js` / `routes/n8n.js`).
- Descarga de imagen con `&tag=` fijo (regresión ya resuelta en n8n).
- `installSsl` de `lib/nginx.js` para el certificado.
- Helpers puros aislados y testeados (de `lib/n8n.js` / `lib/backups.js` /
  `lib/cron.js`).
- Tabla + queries de fila única (patrón `n8n_config`).
- Sección frontend adaptativa por estado (de la sección n8n).
