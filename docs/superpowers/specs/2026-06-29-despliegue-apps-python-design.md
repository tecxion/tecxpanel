# Diseño — Despliegue de apps Python en la sección Apps (PM2)

**Fecha:** 2026-06-29
**Estado:** Aprobado (Fase 1)

## Contexto

El panel ya tiene un pipeline de despliegue de apps por PM2 (`backend/routes/apps.js`)
que auto-detecta el tipo de proyecto. La detección de Python ya existe parcialmente
(`detectProject` reconoce `requirements.txt` y archivos `.py`), pero falla en la
práctica por tres motivos:

1. **`pip3 install -r requirements.txt` global falla** en Ubuntu/Debian modernos con
   el error `externally-managed-environment` (PEP 668).
2. **La detección de entrypoint es limitada** (`app.py/main.py/wsgi.py/server.py`):
   un bot de Telegram suele ser `bot.py`, y arranques tipo `gunicorn wsgi:app` o
   `python -m paquete` no se contemplan.
3. **El flujo empuja a definir puerto/dominio/proxy**, que no aplica a un
   worker/bot (polling) sin servidor web.

El objetivo es soportar **ambos casos**: servicios web (Flask/FastAPI/Django con
puerto + proxy Nginx) y workers/bots (sin puerto). Esta Fase 1 cubre solo la
sección **Apps (PM2)**. El soporte equivalente en la sección **Docker** queda
para una Fase 2 con su propio spec.

## Alcance

**Incluido (Fase 1):**
- Virtualenv por app para instalar y arrancar Python.
- Detección ampliada de entrypoint y pre-selección web/worker.
- Selector de archivo `.py` + campo de comando de arranque editable en el frontend.
- Toggle web/worker en el formulario de despliegue de apps.

**Excluido (Fase 2, otro spec):**
- Mejoras equivalentes en la plantilla Python de Docker
  (`DEPLOY_TEMPLATES.python` en `backend/routes/docker.js`): CMD editable y
  puerto opcional para workers. Dentro de Docker **no** se usa virtualenv (el
  contenedor ya aísla y no sufre PEP 668).

## Modelo de datos

Sin cambios de esquema.
- **Worker/Bot** = app sin puerto (`port` null). El proxy Nginx ya se omite cuando
  no hay puerto, y la acción `start` ya funciona sin puerto.
- **Web** = app con puerto. Comportamiento actual (proxy si además hay dominio).
- El comando de arranque se sigue guardando en la columna existente `start_cmd`.

## Componentes y cambios

### 1. Virtualenv por app (`backend/routes/apps.js`)

- **Creación del venv:** antes de instalar dependencias Python, crear `.venv`
  dentro de la carpeta de la app con `python3 -m venv .venv` (solo si no existe ya).
- **Instalación:** sustituir `pip3 install -r requirements.txt` por
  `.venv/bin/pip install -r requirements.txt`. Esto evita el error PEP 668 y aísla
  dependencias entre apps.
- **Arranque:** PM2 debe usar el intérprete del venv. Para un script Python directo,
  `--interpreter <app>/.venv/bin/python`. Para `gunicorn`/`uvicorn` u otros binarios,
  resolver el ejecutable dentro de `<app>/.venv/bin/` (p. ej. `.venv/bin/gunicorn`).
- **`detectProject`** pasa a devolver, para Python:
  - `installCmd` basado en el venv (creación + `pip install`).
  - `startCmd` con el entrypoint detectado (ver §2).
  - una marca de "web" vs "worker" para la pre-selección del frontend.
- **`buildPm2Launch`** se ajusta para Python: si el comando es un script `.py`,
  usar el intérprete del venv; si es `gunicorn`/`uvicorn`/binario, lanzar el binario
  del venv con sus argumentos.

### 2. Detección de entrypoint y tipo (`detectProject`)

- Ampliar la lista de entrypoints candidatos a:
  `app.py, main.py, wsgi.py, server.py, bot.py, run.py`.
- **Pre-selección web/worker:** inspeccionar `requirements.txt`; si contiene
  `flask`, `fastapi`, `django`, `gunicorn` o `uvicorn` → **web** (sugiere puerto);
  en caso contrario → **worker** (sin puerto).
- El `startCmd` resultante es solo una **sugerencia editable** por el usuario.

### 3. Frontend — sección Apps (`frontend/js/app.js`, `frontend/index.html`)

- **Toggle "Servicio web / Worker-Bot"** en el formulario de despliegue:
  - Se auto-preselecciona según la detección del backend, pero es editable.
  - En modo **worker** se ocultan los campos de puerto y dominio.
  - En modo **web** se muestran puerto (y dominio opcional) como hoy.
- **Selector de archivo de arranque:** lista los `.py` de la raíz del proyecto
  (disponibles tras extraer el ZIP o tras clonar Git). Al elegir uno, rellena el
  campo de comando.
- **Campo de comando editable:** muestra el valor sugerido
  (`python bot.py`, `gunicorn -w 2 app:app`, etc.) y el usuario puede ajustarlo
  antes de desplegar.

### 4. Dependencia del sistema

- Añadir `python3-venv` al aprovisionamiento:
  - en `txpl-setup.sh` (instalador del VPS), y/o
  - como dependencia gestionable desde la sección de plugins.
- Si `python3-venv` no está disponible al crear el venv, devolver un mensaje claro
  indicando cómo instalarlo (sin ocultar el fallo).

## Flujo de despliegue

Reutiliza el pipeline por pasos existente:

```
crear (carpeta o git clone)
  → subir/extraer (solo ZIP)
  → crear .venv + pip install -r requirements.txt
  → build (no aplica en Python)
  → arrancar vía PM2 con el intérprete/binario del .venv
  → proxy (solo si es web: abrir puerto y, si hay dominio, vhost Nginx)
```

## Manejo de errores

- **Falta `python3-venv`:** mensaje explícito con la instrucción de instalación;
  no continuar silenciosamente.
- **`pip install` falla:** devolver la salida real (stdout/stderr) al log de
  despliegue. No usar patrones tipo `|| true` que oculten errores.
- **Selector de archivo sin archivos:** el selector solo se ofrece cuando ya hay
  código extraído/clonado en la carpeta.
- **Comando de arranque vacío o inválido:** validar antes de lanzar PM2 y avisar.

## Criterios de éxito

1. Desplegar un bot de Telegram (`bot.py`, sin puerto) desde un ZIP:
   el panel crea el venv, instala `requirements.txt` sin error PEP 668, y el bot
   arranca y queda `running` en PM2 sin pedir puerto ni proxy.
2. Desplegar un servicio web (FastAPI con `uvicorn`, con puerto):
   el panel lo detecta como web, instala en el venv, arranca con el binario del
   venv y crea el proxy Nginx si se indica dominio.
3. El usuario puede cambiar el comando de arranque sugerido y elegir otro `.py`
   antes de desplegar.
4. Un fallo de instalación de dependencias se muestra con su salida real en el log.
