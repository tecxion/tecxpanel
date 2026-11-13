# Changelog

Versionado `MAYOR.MENOR.PARCHE`, empezando en 2.0.0:

- **Actualización grande** (funciones nuevas, cambios importantes): suma `0.1` → `2.1.0`, `2.2.0`…
- **Actualización pequeña** (arreglos, ajustes; todo cambio, por pequeño que sea, sube la versión): suma `0.0.1` → `2.1.1`, `2.1.2`…

Para publicar una versión: editar `VERSION` y `package.json`, añadir su sección aquí
(`## X.Y.Z — fecha`) y hacer push a `main`. Los paneles detectan el cambio de `VERSION`.

## 2.3.2 — 2026-11-14

- Panel: botón **ⓘ** en la barra superior que abre una ventana con la guía del MCP (token, instalación por consola, ámbitos).
- README: sección MCP ampliada (ámbitos, interruptor, ejecución de comandos, URL propia, paso manual de nginx en paneles ya instalados).

## 2.3.1 — 2026-11-14

- MCP: `npm run setup` en `mcp/` registra el servidor en Claude Desktop o Claude Code por consola (con comprobación del token y copia de seguridad), sin editar JSON a mano. Instala el modo de solo lectura; las variables `TXPL_ENABLE_WRITE`/`TXPL_ENABLE_ADMIN` se añaden a mano.

## 2.3.0 — 2026-11-13

- **Ámbitos de token de API**: `read` (solo lectura), `write` «Lectura y acciones» (reiniciar app/contenedor, crear backup completo, renovar SSL; 30/90/365 días) y `admin` «Control total» (cualquier ruta `/api/*` salvo `/api/auth*`; caducidad 7 o 30 días). Los paneles ya instalados amplían solos el `CHECK` de `api_tokens` al arrancar.
- **Interruptor «Control total de IA»** en Ajustes (apagado por defecto, requiere contraseña): apagarlo neutraliza al instante los tokens `admin` (no deshace lo que ya hicieron: ante una sospecha, trátalo como un compromiso de root; ver `mcp/README.md`). Crear un token `admin` exige interruptor encendido, contraseña y código 2FA si está activo.
- **Auditoría**: toda petición no-GET con token de API queda como `apitoken.call`.
- **`POST /api/system/exec`** (solo tokens `admin`): `bash -lc` con límite de 1-110 s (60 por defecto); al agotarse se mata el grupo de procesos y se devuelven los últimos 64 KB de salida. El comando se audita antes de ejecutarse y corre con un entorno mínimo (sin los secretos del panel); la respuesta envía un espacio cada 10 s para que nginx no la corte a los 30 s.
- `POST /api/backups` con `kind: 'full'` y sin `resources` respalda todo.
- **MCP 0.2.0**: herramientas de acción (`reiniciar_app`, `reiniciar_contenedor`, `crear_backup`, `renovar_ssl`) con `TXPL_ENABLE_WRITE=1` y de control total (`ejecutar_comando`, `llamar_api`) con `TXPL_ENABLE_ADMIN=1`; sin variables solo las 13 de lectura. Guía y advertencias en `mcp/README.md`.

## 2.2.1 — 2026-11-13

- Arreglo: se sube la versión de los recursos del frontend (`ASSET_V` y `main.js?v=`) para que los navegadores recarguen `settings.js` y el botón «Crear token» funcione tras actualizar.

## 2.2.0 — 2026-11-13

- **Tokens de API** con permisos y caducidad (30/90/365 días): solo lectura, lista blanca de rutas (todo lo demás se deniega), gestión desde Ajustes → Tokens de API con la contraseña actual.
- **Servidor MCP de solo lectura para Claude** (13 herramientas, carpeta `mcp/`): corre en el ordenador del usuario, no en el VPS. Guía en `mcp/README.md`.
- Los tokens de API reciben las URLs de repositorio sin credenciales embebidas (webs y apps).

## 2.1.1 — 2026-10-26

- Terminal: las pestañas nuevas usan el número libre más bajo ("Terminal 1", "Terminal 2"…) en vez de seguir sumando.

## 2.1.0 — 2026-10-26

- Sitios y Apps: dos botones separados (**Nuevo sitio web** / **Nueva app**).
- Código por ZIP, archivos o carpeta sueltos, o GitHub (público o privado con token cifrado); webhook también para sitios.
- Sitios: modos HTML, PHP, React/Vue/Vite (build compilado) y Proxy a un puerto local.
- Nuevo actualizador: versión visible en Ajustes → Acerca de, botón **Actualizar** en segundo plano, `txpl update` descarga desde GitHub.
- `txpl-update.sh` por pasos que miran el estado real (PHP ya parcheado se omite), copia de BD consistente, comprobación de salud con rollback automático, modo `--check`.
- Aviso de notificaciones si hay PHP sin parchear.

## 2.0.0

- Reestructura modular del panel (backend por capas, frontend ES modules).
