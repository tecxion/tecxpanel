# Despliegue simple de web-apps (Node / React / Python) — diseño (2026-08-19)

## Problema
Desplegar una app Node/React/Python es hoy **complicado y propenso a errores**:
- **Dos secciones que se solapan.** *Sitios web* (`routes/websites.js`) solo crea el
  **vhost de Nginx**: para `react` deja una carpeta con un index de bienvenida, y para
  node/python haría un proxy a un puerto **donde no hay nada corriendo**. *Apps*
  (`routes/apps.js`) es el despliegue real, pero vive aparte.
- **Pipeline manual por pasos.** En *Apps* el frontend orquesta 6 endpoints sueltos:
  crear → subir ZIP → `/extract` → `/install` → `/build` → `/proxy` → arrancar. Cada
  paso es un clic que puede fallar, sin un "desplegar y ya". Ahí está el dolor.

## Objetivo
Un **único flujo guiado**: eliges lenguaje → subes ficheros (ZIP o Git) → el panel
**detecta**, **instala dependencias**, **compila si hace falta**, **arranca el backend**
(o sirve el build estático) y **monta Nginx + SSL** — con **consola en streaming**,
errores en llano y valores por defecto sensatos. Un botón.

## Principio clave
Mover la orquestación del frontend al **backend, en un solo endpoint de streaming**
(patrón `streamStart/streamWrite/__TXPL_DONE__`, como el instalador de correo). El
frontend solo sube el ZIP y mira la consola/barra. Se para al primer fallo con mensaje
claro y hace **rollback** (no deja apps a medias).

## Diseño

### Detección por lenguaje (extiende la actual `checkBuildRequirements`)
`lib/apps/detect.js` (PURO, testeable) → `{ runtime, pkgManager, installCmd, buildCmd, startCmd, port, servesStatic, warnings }`:
- **Node.js**: `package.json` → `npm ci` (si hay lockfile) / `npm install` → `npm run build`
  (si existe script) → arranque por `scripts.start` o `main`. Proxy Nginx al puerto.
- **React / Vite / build estático**: `npm install` → `npm run build` → **servir `dist/`|`build/`
  como estático** por Nginx. `servesStatic=true` → **sin proceso PM2** (gran simplificación).
- **Python**: `requirements.txt` → **venv** + `pip install -r` → arranque por `Procfile`
  o detección (gunicorn/uvicorn/`python app.py`). Proxy Nginx al puerto.
- Muestra el plan detectado antes de ejecutar ("Voy a: npm install → npm run build →
  servir dist/") con **"editar comando"** como vía de escape para casos raros.

### Endpoint único: `POST /api/apps/:id/deploy` (streaming)
Orquesta server-side, parando al primer fallo, transmitiendo cada comando:
1. `extract` (ZIP) o `git pull` (Git) → aplanar subcarpeta única.
2. `detect` → emite el plan.
3. `install` (deps) con `{ timeout: 0, maxBuffer }` (npm/pip son lentos; el motor de
   backups aprendió esto por las malas).
4. `build` (si aplica).
5. **arranque**: PM2 (`buildPm2Launch`) para node/python; para estático, nada.
6. `proxy` Nginx (`buildProxy` al puerto, o `buildSite` estático al `dist/`) + SSL opcional.
7. En éxito: guarda estado; en fallo: mensaje claro + rollback (borra pm2/vhost/fila a medias).

### Preflight (mata la mayoría de "errores")
Antes de desplegar, comprueba y avisa en llano: ¿está **Node**/`npm` instalado?,
¿**Python**/`pip`?, ¿queda **RAM**/disco?, ¿el **puerto** libre? Si falta un runtime,
enlaza a **Plugins** para instalarlo. Fail-fast con "cómo arreglarlo".

### Asistente de una sola pantalla (frontend)
1. **Nombre/Dominio** (o IP:puerto sin dominio).
2. **Origen**: subir **ZIP** (drag&drop, reutiliza el uploader) o **repo Git**.
3. **Lenguaje**: autodetectado (con opción de forzar Node/React/Python).
4. Botón **Desplegar** → **consola en streaming con barra** (como el correo) + pasos.
5. **Resultado**: URL, estado, **logs**, y **Redeploy en un clic**.

### Robustez (el "suele dar error")
- `npm ci` con lockfile (reproducible) y fallback a `npm install`.
- Python **siempre en venv** (no romper el pip del sistema).
- Timeouts amplios en install/build; puerto asignado con `findFreePort` e inyectado como `PORT`.
- Errores típicos con mensaje + arreglo: falta script de build, entry point erróneo,
  puerto ocupado, `engines` de Node incompatible, `requirements.txt` ausente.
- Rollback transaccional al fallar.

## Decisión tomada: B — Unificar *Sitios web* + *Apps*
Una sola sección **"Sitios"** con selector de tipo (**Estático · PHP · Node · React ·
Python**). Los estáticos/PHP siguen el flujo actual de vhost; Node/React/Python usan el
**asistente único de despliegue**. Se conserva `routes/apps.js` (motor PM2/deploy) por
debajo, pero la UI queda fusionada y el pipeline pasa a ser de una sola pasada.

Implicaciones de la fusión:
- La página *Apps* del sidebar desaparece; su gestión (logs, env, start/stop, redeploy)
  se integra en la ficha de cada sitio de tipo app.
- `routes/websites.js` (vhosts estáticos/PHP) y `routes/apps.js` (apps PM2) conviven
  como capas; la UI unificada decide a cuál llamar según el tipo elegido.
- Riesgo: no romper el flujo estático/PHP que ya funciona → los tipos existentes quedan
  intactos; solo se **añade** el camino de app con el nuevo endpoint de deploy.

## Tareas (TDD, bite-sized)
1. `lib/apps/detect.js` (detección pura + tests): runtime, gestor, install/build/start, puerto, `servesStatic`, warnings.
2. Preflight de runtimes/recursos (helper + endpoint) con mensajes en llano.
3. `POST /apps/:id/deploy` en streaming: orquesta extract→install→build→start→proxy con parada al primer fallo + rollback.
4. React/estático: build → servir `dist/` por Nginx sin PM2.
5. **Sección "Sitios" unificada** (frontend): selector de tipo; para app → asistente de una pantalla (ZIP/Git → detectar → Desplegar con consola+barra → resultado). Estático/PHP conservan su flujo.
6. Integrar gestión de app en la ficha del sitio (logs, env, start/stop) + **Redeploy en un clic**; retirar la página *Apps* del sidebar.
7. Migración/compat: apps existentes siguen visibles en la sección unificada.
8. Docs (README + manual).

## Fuera de alcance (v1)
- Multi-versión de Node/Python (se usa la del sistema).
- Frameworks fuera de convención sin `scripts`/`Procfile` (se cubren con "editar comando").
- Contenedores por app (eso ya es el módulo Docker).
