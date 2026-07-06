# Diseño: Backups Gestionados (Copias de seguridad)

Fecha: 2026-07-06
Estado: aprobado (pendiente de plan de implementación)

## Objetivo

Convertir el backup actual (solo script `txpl-backup.sh` en CLI, sin UI ni
registro) en un módulo **gestionado desde el panel**, estilo Plesk: crear
backups (completos o por recurso), restaurarlos de forma **granular** con red de
seguridad, programarlos automáticamente y consultarlos desde una UI dedicada.

## Alcance de la v1 (decisiones tomadas)

- **Modelo híbrido + granular**: el backup puede ser un snapshot completo del
  servidor o de un solo recurso; el restore es siempre granular (todo el
  servidor o una pieza suelta desde cualquier backup).
- **Recursos independientes** (respaldables/restaurables por separado):
  1. Bases de datos (MySQL/PostgreSQL, dump individual por BD).
  2. Sitios web (archivos de `/var/www/<sitio>` + su config Nginx).
  3. Aplicaciones (PM2): código + `.env` + config PM2.
  4. Config del panel: DB SQLite (`data/txpl.db`) + `.env`.
- **Destinos v1**: **local** (`/opt/txpl/backups`) + **descarga manual** desde el
  navegador. S3 y SFTP quedan para v2 (la arquitectura los dejará enchufables).
- **Programación**: **cron del sistema** (crontab), coherente con el futuro
  módulo "Cron jobs" y robusto ante caídas del panel/PM2.
- **Seguridad en restore**: **snapshot de seguridad automático** antes de
  sobrescribir (estilo Plesk), restaurable como cualquier otro backup.

Fuera de alcance v1: destinos remotos (S3/SFTP), cifrado del archivo de backup,
backups incrementales, multiusuario.

## Arquitectura y componentes

El motor pasa de script shell monolítico a **orquestación desde Node**, para
soportar piezas independientes, manifest y streaming en vivo.

- `backend/routes/backups.js` — router montado en `/api/backups` (JWT).
  Endpoints de listar/crear/restaurar/descargar/borrar/programar.
- `backend/lib/backups.js` — **helpers puros y testeables** (sin estado ni DB):
  construir/parsear `manifest.json`, validar nombres de archivo, calcular
  retención, construir la línea de cron, mapear recursos seleccionados. Mismo
  patrón que `lib/n8n.js`.
- `backend/lib/backupEngine.js` — ejecutor real: `mysqldump` / `pg_dump` /
  `sqlite3 .backup` / `tar` vía `execFile` (usando `run()` de `helpers.js`),
  escritura del manifest y empaquetado. Aislado del router.
- `txpl-backup.sh` — se conserva para uso CLI; el **cron programado invoca el
  runner de Node** para tener una sola lógica y manifest consistente.

Principio: router (transporte) / helpers puros (lógica testeable) / motor
(efectos en el sistema) separados, cada uno con una responsabilidad clara.

## Modelo de datos

Tabla `backups` (catálogo que consume la UI):

| Campo        | Tipo    | Descripción                                          |
| ------------ | ------- | ---------------------------------------------------- |
| id           | INTEGER | PK                                                   |
| filename     | TEXT    | Nombre del `.tar.gz` en `/opt/txpl/backups`          |
| created_at   | TEXT    | Timestamp de creación                                |
| size_bytes   | INTEGER | Tamaño del archivo                                   |
| kind         | TEXT    | `full` \| `resource`                                 |
| scope        | TEXT    | JSON con la lista de recursos incluidos              |
| origin       | TEXT    | `manual` \| `scheduled` \| `pre-restore`             |
| status       | TEXT    | `running` \| `ok` \| `failed`                        |
| notes        | TEXT    | Mensaje/error opcional                               |

Tabla `backup_schedule` (fila única, id=1):

| Campo          | Tipo    | Descripción                                |
| -------------- | ------- | ------------------------------------------ |
| enabled        | INTEGER | 0/1                                        |
| frequency      | TEXT    | `daily` \| `weekly`                        |
| time           | TEXT    | Hora `HH:MM`                               |
| retention_days | INTEGER | Días que se conservan los backups          |
| resources      | TEXT    | JSON de recursos a respaldar en cada corte |

## Formato del backup y manifest

Cada backup es un `.tar.gz` en `/opt/txpl/backups/` que **incluye un
`manifest.json`** en su raíz describiendo el contenido:

```json
{
  "version": 1,
  "created_at": "2026-07-06T03:00:00Z",
  "kind": "full",
  "items": [
    { "class": "db-mysql", "name": "clientea", "path": "db/mysql/clientea.sql.gz", "size": 12345 },
    { "class": "db-pg",     "name": "clienteb", "path": "db/pg/clienteb.sql.gz",   "size": 6789 },
    { "class": "site",      "name": "clientea.com", "path": "sites/clientea.com.tar.gz", "size": 999 },
    { "class": "app",       "name": "bot-telegram",  "path": "apps/bot-telegram.tar.gz", "size": 111 },
    { "class": "panel",     "name": "panel",         "path": "panel/txpl.db",            "size": 222 }
  ]
}
```

El manifest permite el **restore granular**: saber qué hay dentro y extraer solo
la pieza necesaria sin desempaquetar todo. `class` ∈
`db-mysql | db-pg | site | app | panel`.

## Flujo de creación

`POST /api/backups` con `{ kind, resources[] }`:

1. Responde en **streaming** reutilizando el centinela `__TXPL_DONE__<code>` de
   `plugins.js`/`n8n.js`, emitiendo progreso por pieza.
2. El motor crea un directorio de trabajo, vuelca cada recurso seleccionado,
   escribe `manifest.json`, empaqueta en `.tar.gz`, registra la fila en
   `backups` (status `running`→`ok`/`failed`) y aplica retención.
3. Variantes: "Backup ahora" (full) o "Respaldar solo este recurso".

## Flujo de restore (con red de seguridad)

1. Lee el `manifest.json` del backup → la UI muestra las piezas disponibles.
2. El usuario elige **restaurar todo** o **una pieza** concreta.
3. **Snapshot de seguridad automático** de lo que se va a sobrescribir
   (backup con `origin='pre-restore'`), restaurable como cualquier otro.
4. Se aplica: extrae solo lo necesario y restaura según la clase
   (`mysql <`, `pg_restore`/`psql`, `tar -x` para sitios, copia de `txpl.db`),
   recargando servicios (`nginx -t && reload`, `pm2 restart`).
5. **Apps** (pieza delicada): restaura código + `.env` + config PM2 y hace
   `pm2 restart`; si falta build o venv, **avisa** (como el pipeline de apps
   actual con `checkBuildRequirements`) en lugar de arrancar un proceso roto.

## Programación (cron del sistema)

- UI: activar/desactivar, frecuencia (diario/semanal), hora, retención y
  recursos a incluir.
- Al guardar, el panel escribe una línea en crontab que invoca el runner de Node
  con la config de `backup_schedule`. `lib/backups.js` construye la línea de
  cron (testeable). Retención vía `retention_days` (borra backups `scheduled`
  más antiguos; los `pre-restore` y `manual` no se auto-borran salvo que se
  decida lo contrario en UI).

## Frontend

Nuevo item **"Copias de seguridad"** en `frontend/views/sidebar.html` →
`frontend/views/pages/backups.html` cargada dinámicamente (patrón `loadTemplates`),
con lógica en `frontend/js/app.js`:

- Tabla del catálogo: fecha, tipo (full/recurso), tamaño, origen, estado.
- Botón **Backup ahora** (elegir full o recurso concreto).
- Acciones por backup: **Restaurar todo**, **Restaurar pieza**, **Descargar**,
  **Borrar**.
- Panel de **Programación**: activar, frecuencia, hora, retención, recursos.
- Consola de streaming para backup/restore reutilizando el patrón visual
  existente (centinela + barra de progreso).

Todo dato externo (nombres de recursos, ficheros) se escapa con `esc()` antes de
interpolar en `innerHTML`.

## Seguridad

- **Path jail**: descarga/restore/borrado solo dentro de `/opt/txpl/backups`
  (resolver ruta y verificar prefijo antes de tocar nada).
- **Zero shell interpolation**: todo `mysqldump`/`tar`/etc. vía `execFile` con
  arrays de argumentos.
- **Auditoría**: `audit(user, ip, action, detail)` en cada creación, restore,
  descarga y borrado.
- Credenciales (root MySQL) desde `.env` como hoy; nada nuevo hardcodeado.

## Pruebas

Tests unitarios de `backend/lib/backups.js` con `node:test` (sin dependencias):

- `buildManifest` / `parseManifest` (ida y vuelta, clases válidas).
- Construcción de la línea de cron según frecuencia/hora.
- Cálculo de retención (qué backups caen, respeta `manual`/`pre-restore`).
- Validación de nombres de archivo (rechaza traversal/basura).
- Mapeo de recursos seleccionados → items del manifest.

## Patrones reutilizados del código existente

- Streaming con centinela `__TXPL_DONE__<code>` (de `plugins.js`/`n8n.js`).
- Helpers puros aislados y testeados (de `lib/n8n.js`).
- `run()`/`runSafe()` de `helpers.js` para ejecución segura.
- Recarga Nginx (`lib/nginx.js`) y patrón PM2 de `apps.js`/`appdeploy.js`.
- Cifrado/patrones de `.env` sin cambios.
