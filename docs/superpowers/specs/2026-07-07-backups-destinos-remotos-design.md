# Diseño: Backups — Destinos remotos (S3/SFTP) — Fase 2

Fecha: 2026-07-07
Estado: aprobado (pendiente de plan de implementación)

## Objetivo

Cerrar el hueco de recuperación ante desastres del módulo de backups: hoy los
`.tar.gz` viven solo en el mismo VPS. Esta Fase 2 añade **destinos remotos**
(S3-compatible y SFTP) con **cifrado opcional**, subida automática tras cada
backup, listado y restauración desde el remoto, y retención remota. Reutiliza
íntegramente el motor y el catálogo actual (Fase 1); PowerDNS del módulo DNS y
docker-mailserver del correo no son relevantes aquí.

## Decisiones tomadas

- **Motor de transporte: `rclone`** (un binario único), NO SDKs Node ni
  aws-cli/s3cmd sueltos. Cubre S3-compatible + SFTP con una sola herramienta y
  encaja con el patrón `execFile` del panel; sin dependencias npm pesadas
  (identidad ligera).
- **Backends Fase 2 v1**: **S3-compatible** (Amazon S3, Backblaze B2, Wasabi,
  MinIO, DigitalOcean Spaces) y **SFTP**. Cada uno con su formulario propio.
- **Cifrado opcional con passphrase del usuario** (modelo restic/borg/rclone
  crypt). Al activarlo, el usuario define una passphrase (o el panel la genera
  y la muestra UNA SOLA VEZ con un aviso claro de "guárdala fuera del VPS").
  Sin la passphrase no hay restauración tras pérdida total del VPS — se
  documenta explícitamente.
- **Config de rclone por variables de entorno del proceso hijo** (`RCLONE_CONFIG_<REMOTO>_<CLAVE>=…`), NO por `rclone.conf` en disco ni por argv.
  Los secretos no aparecen en `ps`, no persisten en ficheros de rclone y no se
  filtran a logs de sistema.
- **Fila única de configuración** (patrón `n8n_config`/`dns_config`): un
  operador tiene un único destino remoto activo.
- **Retención remota independiente** de la local: el runner de cron borra del
  remoto los backups programados más antiguos que `retention_days` (los
  `manual` y `pre-restore` no se auto-borran, igual que en la retención local).
- **Restore desde remoto**: descarga a `BACKUP_DIR` local y reutiliza el motor
  granular ya existente (manifest → piezas).

Fuera de alcance v1: más backends (Google Drive, Dropbox, etc.), backups
incrementales, verificación de integridad remota (`rclone check`),
y multi-destino.

## Arquitectura (2 capas nuevas + integración)

- `backend/lib/rclone.js` — **helpers puros y testeables** (sin estado ni DB):
  - `RCLONE_REMOTE = 'txpl'` y `RCLONE_CRYPT = 'txplcrypt'` (nombres de remoto
    internos, invariantes; el usuario no los ve).
  - `buildS3Env({ endpoint, region, accessKey, secretKey })` → objeto
    `{ RCLONE_CONFIG_TXPL_TYPE:'s3', RCLONE_CONFIG_TXPL_PROVIDER:'Other', RCLONE_CONFIG_TXPL_ENDPOINT:…, RCLONE_CONFIG_TXPL_REGION:…, RCLONE_CONFIG_TXPL_ACCESS_KEY_ID:…, RCLONE_CONFIG_TXPL_SECRET_ACCESS_KEY:…, RCLONE_CONFIG_TXPL_ENV_AUTH:'false' }`.
  - `buildSftpEnv({ host, port, user, password, keyContent })` → env con
    `RCLONE_CONFIG_TXPL_TYPE:'sftp'`, `_HOST`, `_PORT`, `_USER`, y
    `_PASS`/`_KEY_FILE` (la clave se materializa en un fichero temporal solo
    durante la ejecución, no persistente).
  - `buildCryptEnv({ passphrase })` → env que define el remoto `txplcrypt` de
    tipo `crypt` sobre `txpl:<remote_path>`, con
    `RCLONE_CONFIG_TXPLCRYPT_PASSWORD` obtenido via `rclone obscure` (el helper
    lo indica; el ejecutor lo aplica).
  - `effectiveRemote(encryptEnabled, remotePath)` → devuelve la ruta destino:
    `txplcrypt:` si el cifrado está activo (el propio crypt apunta al
    `remote_path` bajo el hood), o `txpl:<remotePath>` si no.
  - `copyArgs(local, remote)` → `['copy', local, remote, '--s3-no-check-bucket']`.
  - `lsjsonArgs(remote)` → `['lsjson', remote]`.
  - `deleteArgs(remote)` → `['deletefile', remote]`.
  - `checkRemoteArgs(remote)` → `['lsd', remote]` (test de conexión).
  - `parseLsjson(text)` → array `[{ name, size, modTime }]`.
- `backend/lib/backupRemote.js` — **ejecutor** (efectos):
  - `obscurePassword(pass)` — llama a `rclone obscure` y devuelve el string;
    necesario porque `crypt` exige la passphrase "obscurecida".
  - `uploadArchive({ filename })` — construye el env combinando storage +
    crypt (si aplica), materializa la clave SSH temporal si es SFTP con
    `keyContent`, ejecuta `rclone copy` y limpia el fichero temporal en
    `finally`.
  - `listRemote()` — `rclone lsjson` y devuelve `parseLsjson`.
  - `downloadArchive({ filename })` — descarga a `BACKUP_DIR` (el motor
    existente restaura desde ahí).
  - `deleteRemote({ filename })` — `rclone deletefile`.
  - `testConnection()` — `rclone lsd` best-effort; devuelve `{ ok, message }`.
- `backend/routes/backups.js` — **modificar** para añadir endpoints y la subida
  automática tras `createBackup`.
- `backend/database.js` — **modificar** para añadir la tabla `backup_remote`.

## Datos

Tabla `backup_remote` (fila única, id=1):

| Campo             | Tipo    | Descripción                                          |
| ----------------- | ------- | ---------------------------------------------------- |
| id                | INTEGER | PK, `CHECK (id = 1)`                                 |
| type              | TEXT    | `s3` \| `sftp`                                       |
| config_enc        | TEXT    | JSON con credenciales, cifrado AES-256-GCM           |
| remote_path       | TEXT    | Bucket+prefijo (S3) o ruta absoluta (SFTP)           |
| encrypt_enabled   | INTEGER | 0/1                                                  |
| crypt_pass_enc    | TEXT    | Passphrase del `crypt` cifrada (si `encrypt_enabled`)|
| auto_upload       | INTEGER | 0/1 — subir automáticamente tras crear un backup     |
| retention_days    | INTEGER | Días de retención remota (`scheduled` únicamente)    |
| status            | TEXT    | `ok` \| `error` \| `unconfigured`                    |
| created_at        | TEXT    | Timestamp                                            |

`config_enc` contiene, según `type`:
- `s3`: `{ endpoint, region, accessKey, secretKey }`.
- `sftp`: `{ host, port, user, password?, keyContent? }` (uno de los dos).

## Endpoints (añadidos a `/api/backups`)

- `GET /remote` → devuelve la config sin secretos (`{ type, remote_path,
  encrypt_enabled, auto_upload, retention_days, status }`).
- `POST /remote` → guarda/actualiza la config (body con credenciales); cifra
  antes de persistir; **prueba la conexión** (`rclone lsd`) antes de guardar;
  responde `{ ok, status }`. Si `encrypt_enabled`, exige `crypt_pass` en el
  body y la cifra.
- `POST /remote/test` → prueba la conexión con la config actual.
- `POST /:id/upload` → sube un backup local al remoto.
- `GET /remote/list` → lista los backups presentes en el remoto (nombre, size,
  modTime).
- `POST /remote/:filename/restore` → descarga el archivo a `BACKUP_DIR` y
  ejecuta el restore granular existente (mismo flujo que Fase 1, con snapshot
  pre-restore).
- `DELETE /remote/:filename` → borra el archivo del remoto.
- `DELETE /remote` → limpia la config remota.

## Flujos

- **Configurar destino**: `POST /remote` valida forma (`type`, campos por
  tipo), prueba conexión con `testConnection`, si OK cifra credenciales +
  passphrase y persiste. Auditoría.
- **Subida automática**: en `POST /` (crear backup) y en `backup-runner.js`,
  tras `createBackup` con éxito, si `getBackupRemote().auto_upload` es 1,
  invoca `uploadArchive`. La subida NO bloquea la respuesta ni la creación:
  se registra su resultado (log + audit) y, si falla, el backup queda
  igualmente en local.
- **Restaurar desde remoto**: `POST /remote/:filename/restore` valida el
  nombre (`isValidBackupFilename`), descarga a `BACKUP_DIR`, cataloga la fila
  como si fuera un backup local (`origin='remote-restore'` para trazabilidad)
  y ejecuta el restore por el motor existente (snapshot pre-restore +
  `restoreItem` por pieza).
- **Retención remota**: `backup-runner.js`, tras la retención local, si hay
  remoto activo con `retention_days`, lista el remoto, borra los `scheduled`
  cuyo `modTime` supere el umbral. Los `manual`/`pre-restore` no se auto-borran.

## Frontend

Sección **Copias de seguridad** amplía con una nueva tarjeta **"Destino
remoto"**:

- Selector `S3-compatible | SFTP`; formulario por tipo (endpoint/region/keys y
  bucket-prefix para S3; host/port/user y password *o* key para SFTP).
- Toggle **cifrado**; si se activa, campo passphrase (con opción "generar"
  que la muestra una vez con aviso).
- Toggle **auto_upload** y **retention_days**.
- Botón **Probar conexión** (llama a `POST /remote/test`).
- En la tabla de backups locales, botón **Subir** por fila.
- Sub-tarjeta **Backups remotos** con listar + restaurar + borrar.

Todo dato externo se escapa con `esc()`.

## Seguridad

- **Zero shell interpolation**: rclone se invoca con `execFile`/arrays; nunca
  cadenas de shell.
- **Secretos por variables de entorno del proceso hijo**, NO en argv ni
  fichero en disco. La clave SSH de SFTP con `keyContent` se materializa en
  un fichero temporal con permisos `0600` solo durante la ejecución y se
  borra en `finally`.
- **Credenciales y passphrase cifradas en reposo** con AES-256-GCM
  (`encryptSecret`/`decryptSecret`), patrón n8n/dns.
- **Path jail** para las rutas locales (mismo `BACKUP_DIR` y
  `isValidBackupFilename`).
- **Auditoría** en configurar/probar/subir/restaurar-desde-remoto/borrar-remoto.
- **Aviso honesto** en UI y docs: sin la passphrase, el backup remoto cifrado
  no se puede descifrar tras pérdida total del VPS.

## Pruebas

Tests unitarios de `backend/lib/rclone.js` con `node:test` (sin dependencias
externas):

- `buildS3Env` produce el env con las claves `RCLONE_CONFIG_TXPL_*` esperadas
  y sin filtrar el secret en objetos derivados.
- `buildSftpEnv` produce el env con `_HOST/_PORT/_USER` y elige `_PASS` o
  `_KEY_FILE` según input.
- `buildCryptEnv` monta `txplcrypt` de tipo `crypt` sobre `txpl:<remote_path>`.
- `effectiveRemote` devuelve `txplcrypt:` o `txpl:<remote_path>` según flag.
- `copyArgs`/`lsjsonArgs`/`deleteArgs`/`checkRemoteArgs` estructura exacta.
- `parseLsjson` devuelve `[{name,size,modTime}]` y tolera JSON vacío/malformado.

## Notas honestas (a documentar)

- Sin la passphrase de cifrado no hay recuperación tras perder el VPS entero.
  El panel avisa al activarlo y anima a guardarla fuera del VPS.
- Los backups del panel siguen conteniendo el `.env` con `JWT_SECRET`; sin
  cifrar, esos secretos viven en el remoto en claro (documentado ya en Fase 1).
- La subida es best-effort tras cada backup; un fallo remoto no cancela el
  backup local, pero se refleja en el catálogo (`notes`) y auditoría.

## Patrones reutilizados del código existente

- Cifrado de secretos en reposo (`encryptSecret`/`decryptSecret`) — patrón
  `n8n_config`/`dns_config`.
- Tabla de fila única con `CHECK (id = 1)` — patrón `n8n_config`/`mail_config`.
- Comandos externos via `execFile`/arrays — patrón usado en todo el repo.
- Retención basada en `selectExpiredBackups` (`lib/backups.js`) — reusada
  pasando la lista remota parseada.
- Streaming de instalación (`__TXPL_DONE__` sentinel) — si el operador
  necesita instalar `rclone`, se reusa el flujo de `plugins.js`.
