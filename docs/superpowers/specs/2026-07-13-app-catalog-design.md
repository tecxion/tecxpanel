# Catálogo one-click de aplicaciones — Diseño

**Fecha:** 2026-07-13
**Estado:** Aprobado por el usuario

## Objetivo

Página "Catálogo" en TecXPaneL para instalar aplicaciones populares con un clic, eligiendo el modo de despliegue por app: contenedor Docker, nativo (PHP-FPM) o proceso PM2. Generaliza el precedente de n8n (instalación one-click de contenedor con streaming y proxy Nginx).

## Catálogo v1

| App | Modos | DB | Notas |
|-----|-------|----|-------|
| WordPress | `docker`, `native` | MySQL (host) | Nativo = PHP-FPM + vhost del panel |
| Ghost | `docker`, `pm2` | MySQL (host) | PM2 vía ghost-cli |
| Nextcloud | `docker` | — (SQLite interno) | MySQL para Nextcloud fuera de v1; SQLite basta para uso personal |
| Vaultwarden | `docker` | — (SQLite interno) | |
| Uptime Kuma | `docker`, `pm2` | — (SQLite interno) | Es una app Node |

Decisión: **la DB de las apps que la necesitan vive en el MySQL del host**, creada por el módulo de bases de datos del panel (aparece en la página Bases de datos y entra en los backups existentes). Nada de contenedores MySQL por app (duplicaría RAM y quedaría fuera de backups).

## Arquitectura (patrón 3 capas del repo)

### `backend/lib/catalog.js` — helpers puros (unit-tested)

- `CATALOG`: array declarativo, una entrada por app:

```js
{
  id: 'wordpress',
  name: 'WordPress',
  description: '...',            // español
  logo: '...',                   // ruta en public/ o data URI
  modes: ['docker', 'native'],
  docker: {
    image: 'wordpress',
    tag: '6.8-apache',           // SIEMPRE tag fijado (regla del repo: nunca pull sin tag)
    port: 80,                    // puerto interno del contenedor
    volumes: [['txpl_wordpress_data', '/var/www/html']],
    env: (opts) => [...]         // constructor puro de env vars
  },
  native: { type: 'php' },       // o { type: 'node', ... } para pm2
  db: 'mysql'                    // o null
}
```

- `buildAppContainerConfig(entry, opts)` — config JSON para el socket Docker (patrón `buildN8nContainerConfig`).
- `validateInstallOptions(entry, opts)` — nombre, dominio (validadores existentes), modo soportado.
- `buildDbEnv(entry, dbCreds, dbHost)` — env vars de conexión a DB por app.
- `buildWpConfig(dbCreds, salts)` — contenido de `wp-config.php`.
- `containerName(id)` → `txpl-app-<id>`; `pm2Name(id)` → `txpl-app-<id>`; `volumeName(id)` → `txpl_<id>_data`.

### `backend/lib/catalogEngine.js` — efectos

- `installApp(appId, mode, opts, write)` — orquesta según modo (ver Flujos). `write` = streaming.
- `uninstallApp(appId, { purgeData, purgeDb }, write)`.
- `getInstallStatus(appId)` — combina `catalog_installs` + estado real (contenedor / PM2 / vhost).
- Reutiliza: `dockerRequest`/pull con progreso (patrón n8n), módulo databases para crear DB+usuario (contraseña `generatePassword`, cifrada AES-256-GCM), `lib/nginx.js` (`buildProxy`, `buildPhpFpmSite`, `enableSite`, `installSsl`), pipeline PM2 de `apps.js`.

### `backend/routes/catalog.js` — HTTP (JWT ya aplicado)

- `GET /` — catálogo completo + estado de instalación por app.
- `POST /:id/install` — body `{ mode, domain?, ssl?, email? }`. Streaming `text/plain` con centinela `__TXPL_DONE__<code>`.
- `POST /:id/:action` — start / stop / restart (despacha a Docker o PM2 según `mode` registrado).
- `DELETE /:id` — body `{ purgeData?, purgeDb? }`. Streaming.
- Auditoría con `audit()` en cada mutación (sin secretos en `detail`).

### Tabla nueva `catalog_installs`

```sql
CREATE TABLE IF NOT EXISTS catalog_installs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_id TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL,              -- docker | native | pm2
  domain TEXT,
  port INTEGER,                    -- puerto host (loopback) asignado
  ref TEXT,                        -- container id | pm2 name | site path
  db_name TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

La DB del panel es la fuente de la verdad de qué está instalado (patrón del repo). El registro se escribe **solo al final con éxito**. Una instalación por app en v1 (UNIQUE en `app_id`).

## Flujos de instalación

### Modo Docker (todas)

1. `validateInstallOptions`; comprobar Docker instalado (si no, `409` apuntando a Plugins).
2. Si `db: 'mysql'`: crear DB + usuario vía módulo databases. El contenedor conecta al MySQL del host: el instalador prueba `host.docker.internal` y la IP del bridge (`172.17.0.1`), y ajusta/avisa sobre `bind-address` por streaming.
3. Pull de imagen **con `&tag=` fijado** + progreso por streaming.
4. Crear y arrancar contenedor `txpl-app-<id>`, volumen persistente, puerto interno mapeado a un puerto libre en `127.0.0.1`.
5. Con dominio: `buildProxy` + `enableSite` + SSL opcional (Certbot). Sin dominio: acceso por `http://IP:puerto` (documentado en el resumen final).
6. Insertar en `catalog_installs`; resumen final: URL + credenciales mostradas **una sola vez**.

### Modo nativo PHP (WordPress)

1. Crear DB (como arriba).
2. Descargar `https://wordpress.org/latest.tar.gz`, extraer a `/var/www/<dominio>` (dominio obligatorio en este modo).
3. Generar `wp-config.php`: credenciales de DB + salts (API `api.wordpress.org/secret-key` con fallback a `crypto.js`).
4. `buildPhpFpmSite` + `enableSite` + SSL opcional. Permisos `www-data`.
5. Insertar registro y resumen final.

### Modo PM2 (Ghost, Uptime Kuma)

1. Directorio `/opt/txpl-apps/<id>`.
2. Ghost: `ghost-cli` local (`npx ghost install local` adaptado a producción con DB MySQL del host). Uptime Kuma: `git clone` + `npm ci` + build.
3. Arranque PM2 con nombre `txpl-app-<id>` (aparece en la página Aplicaciones).
4. Proxy Nginx + SSL opcional, registro, resumen.

> Procesos largos: `{ timeout: 0, maxBuffer }` en `run()` (regla del repo).

## Desinstalación

- Para y borra contenedor / proceso PM2 / vhost según `mode`.
- `purgeData` y `purgeDb` son checkboxes **desmarcados por defecto**; la UI pide confirmación doble si se marcan. Nunca se borran datos por defecto.
- Borra el registro de `catalog_installs` al terminar.

## Manejo de errores

- Validación previa completa (dominio/puerto/DB libres) antes de tocar el sistema.
- Errores de negocio con `err.http` (patrón `wrap()`): `409` Docker ausente, `409` app ya instalada, `400` modo no soportado.
- Fallo a mitad: **rollback best-effort** (borrar contenedor/volumen/DB recién creados), informado por streaming; sin registro en DB, reintentable.

## Frontend

- Entrada "Catálogo" en el menú. Grid de tarjetas: logo, descripción, badges de modos, botón Instalar / estado Instalado.
- Modal: selector de modo (solo soportados), dominio opcional (obligatorio en nativo PHP), checkbox SSL, nota informativa de DB.
- Streaming en `<pre>` con centinela (mismo mecanismo que plugins/n8n).
- Tarjeta instalada: Abrir, start/stop/restart, Desinstalar (confirmación doble si purga).
- Los contenedores y procesos PM2 instalados aparecen además en las páginas Docker y Aplicaciones automáticamente (listan del sistema real).

## Seguridad

- Contraseñas generadas con `generatePassword`, cifradas AES-256-GCM en reposo (patrón databases).
- Nunca secretos en `audit_log` ni persistidos en claro; credenciales mostradas una sola vez en el resumen.
- `execFile` con arrays de argumentos siempre; descargas solo de fuentes oficiales (wordpress.org, Docker Hub oficial, GitHub oficial de Uptime Kuma) con tags/versiones fijadas.

## Tests (`backend/test/catalog.test.js`)

- Integridad del `CATALOG`: campos obligatorios, tags Docker fijados, coherencia `modes`/`db`/recetas.
- `buildAppContainerConfig` por app (imagen:tag, volúmenes, puertos, env).
- `validateInstallOptions`: casos válidos e inválidos.
- `buildWpConfig` y `buildDbEnv`.
- `containerName`/`pm2Name`/`volumeName`.

## Avisos honestos

- Nextcloud v1 usa SQLite interno: válido para uso personal, no para equipos grandes. MySQL para Nextcloud, fase 2.
- Ghost en PM2 con MySQL del host requiere Node compatible con la versión de ghost-cli; si el Node del VPS no cumple, el instalador falla con mensaje claro antes de tocar nada.
- El modo nativo no aísla la app: comparte PHP/Node del host.

## Fuera de alcance (v1)

- Múltiples instancias de la misma app.
- Actualizaciones automáticas de las apps instaladas (el usuario actualiza desde la propia app o recreando el contenedor).
- Backups específicos por app del catálogo (las DB ya entran por el módulo de backups; volúmenes Docker, fase 2).
- Migración de n8n al catálogo.

## Docs

`README.md` y `CLAUDE.md` se actualizan como última tarea del plan (regla del repo).
