# Changelog

Versionado `MAYOR.MENOR.PARCHE`, empezando en 2.0.0:

- **Actualización grande** (funciones nuevas, cambios importantes): suma `0.1` → `2.1.0`, `2.2.0`…
- **Actualización pequeña** (arreglos, ajustes; todo cambio, por pequeño que sea, sube la versión): suma `0.0.1` → `2.1.1`, `2.1.2`…

Para publicar una versión: editar `VERSION` y `package.json`, añadir su sección aquí
(`## X.Y.Z — fecha`) y hacer push a `main`. Los paneles detectan el cambio de `VERSION`.

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
