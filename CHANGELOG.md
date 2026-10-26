# Changelog

Versionado `MAYOR.MENOR.PARCHE`, empezando en 2.0.0:

- **Actualización grande** (funciones nuevas, cambios importantes): suma `0.1` → `2.1.0`, `2.2.0`…
- **Actualización pequeña** (arreglos, ajustes): suma `0.0.1` → `2.1.1`, `2.1.2`…

Para publicar una versión: editar `VERSION` y `package.json`, añadir su sección aquí
(`## X.Y.Z — fecha`) y hacer push a `main`. Los paneles detectan el cambio de `VERSION`.

## 2.1.0 — 2026-10-26

- Sitios y Apps: dos botones separados (**Nuevo sitio web** / **Nueva app**).
- Código por ZIP, archivos o carpeta sueltos, o GitHub (público o privado con token cifrado); webhook también para sitios.
- Sitios: modos HTML, PHP, React/Vue/Vite (build compilado) y Proxy a un puerto local.
- Nuevo actualizador: versión visible en Ajustes → Acerca de, botón **Actualizar** en segundo plano, `txpl update` descarga desde GitHub.
- `txpl-update.sh` por pasos que miran el estado real (PHP ya parcheado se omite), copia de BD consistente, comprobación de salud con rollback automático, modo `--check`.
- Aviso de notificaciones si hay PHP sin parchear.

## 2.0.0

- Reestructura modular del panel (backend por capas, frontend ES modules).
