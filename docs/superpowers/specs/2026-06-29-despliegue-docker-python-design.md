# Diseño — Despliegue de apps Python en Docker (Fase 2)

**Fecha:** 2026-06-29
**Estado:** Propuesto
**Depende de:** [Fase 1 — despliegue de apps Python en Apps/PM2](2026-06-29-despliegue-apps-python-design.md)

## Contexto

La Fase 1 añadió despliegue de apps Python en la sección **Apps (PM2)**: virtualenv por
app, detección de modo web/worker, comando de arranque editable y selector de `.py`.

La sección **Docker** ya tiene un flujo de "Desplegar mi app" con plantillas de
Dockerfile (`DEPLOY_TEMPLATES` en `backend/routes/docker.js`), incluida una plantilla
`python`. Pero esa plantilla arrastra los mismos problemas que tenía Apps antes de la
Fase 1, adaptados a Docker:

1. **Entrypoint fijo**: la plantilla genera `CMD ["python","app.py"]`. Un bot de
   Telegram (`bot.py`) o un web con `gunicorn`/`uvicorn` no arranca.
2. **Errores de instalación ocultos**: `RUN pip install --no-cache-dir -r requirements.txt || true`.
   El `|| true` hace que un fallo de dependencias produzca una imagen rota
   silenciosamente (viola la convención del proyecto de no ocultar errores).
3. **Asume servicio web con puerto**: el flujo inyecta `PORT`, exige Puerto
   Contenedor y empuja a mapear Puerto Host / dominio. Un worker/bot (polling)
   no escucha en ningún puerto.

**Diferencia clave con la Fase 1:** dentro de Docker **no** se usa virtualenv. El
contenedor ya aísla las dependencias y la imagen base (`python:3.12-slim`) no sufre
el error PEP 668; el `pip install` se ejecuta en la fase `RUN` del build. Por tanto,
lo que se traslada de la Fase 1 a Docker es: **comando de arranque editable** +
**distinción web/worker (puerto opcional)** + **no ocultar errores de build**.

## Alcance

**Incluido (Fase 2):**
- Comando de arranque editable para la plantilla Docker `python`, usado para generar
  el `CMD` del Dockerfile.
- Distinción web/worker en el formulario de despliegue Docker: en modo worker no se
  pide Puerto Contenedor / Puerto Host / dominio, no se inyecta `PORT`, no se genera
  `EXPOSE`, no se mapea puerto ni se abre firewall.
- Quitar el `|| true` del `pip install` de la plantilla `python` para que un fallo de
  dependencias detenga el build con su salida real.

**Excluido:**
- Selector de archivo `.py` "tras extraer" (como en Apps): el flujo Docker
  `deploy/build` es un único paso en streaming que extrae el ZIP **dentro** del build,
  sin una pausa intermedia. El comando se indica en el formulario inicial (no hay
  archivos listados antes de construir). YAGNI: no se reestructura el flujo para
  añadir la pausa.
- Cambios en otras plantillas (`static`, `php`, `node`). El `|| true` del template
  `node` se menciona como mejora relacionada pero queda fuera de alcance salvo que se
  decida lo contrario.
- Virtualenv (no aplica en contenedores).

## Modelo de datos

Sin cambios. El despliegue Docker no persiste configuración de app en SQLite por este
flujo (construye imagen + contenedor y limpia el directorio temporal). El comando y el
modo viajan en el cuerpo de la petición `deploy/build`.

## Componentes y cambios

### 1. Plantilla `python` parametrizada (`backend/routes/docker.js`)

`DEPLOY_TEMPLATES.python.gen` pasa a recibir el comando de arranque y el modo, y genera
el Dockerfile en consecuencia:

- **Modo web** (con puerto interno `port`):
  ```dockerfile
  FROM python:3.12-slim
  WORKDIR /app
  COPY . .
  RUN pip install --no-cache-dir -r requirements.txt
  EXPOSE <port>
  CMD ["sh","-c","<startCmd>"]
  ```
- **Modo worker** (sin puerto): igual pero **sin** la línea `EXPOSE`.

Notas:
- El `pip install` ya **no** lleva `|| true`: si falla, el `docker build` falla y el
  usuario ve el error real en el log en vivo (que ya se transmite por streaming).
- Si el código del usuario incluye su propio `Dockerfile`, el flujo actual lo respeta
  (se usa ese en lugar de la plantilla); ese comportamiento no cambia.

### 2. Generación segura del `CMD`

El comando de arranque es entrada del usuario que se incrusta en el Dockerfile. Para
evitar **inyección de directivas Dockerfile** (p. ej. saltos de línea que añadan
instrucciones):

- **Validar** el comando antes de generar: rechazar si contiene saltos de línea
  (`\r`/`\n`) o está vacío; longitud máxima razonable (p. ej. 500 chars).
- Incrustarlo en forma exec con `sh -c` y **escapado JSON**:
  `CMD ["sh","-c", ${JSON.stringify(startCmd)}]`, de modo que comillas y caracteres
  especiales queden contenidos en una cadena JSON válida de una sola línea.
- El comando se ejecuta como proceso del contenedor (el usuario ya controla el
  contenido de su propia imagen), así que el único riesgo a cerrar es la inyección en
  el texto del Dockerfile, cubierta por la validación + `JSON.stringify`.

### 3. Ruta `deploy/build` (`backend/routes/docker.js`)

- Aceptar dos campos nuevos en el cuerpo: `startCmd` (string) y `mode`
  (`'web'` | `'worker'`).
- **Modo worker:**
  - No exigir `containerPort`; ignorar `hostPort` y `domain` (o rechazar con aviso si
    se enviaron, para evitar confusión).
  - No inyectar `PORT` en las variables de entorno.
  - Generar el Dockerfile sin `EXPOSE`.
  - En `buildContainerConfig`: no publicar puertos (sin `PortBindings`/`ExposedPorts`).
  - Saltar la apertura de firewall y la configuración de dominio/HTTPS.
- **Modo web:** comportamiento actual (puerto interno efectivo, inyección de `PORT`,
  mapeo de Puerto Host, firewall, dominio/SSL), pero usando el `startCmd` para el `CMD`.
- Validar `startCmd` (ver §2) y devolver `fail(400, ...)` en español si es inválido.

### 4. Frontend — formulario de despliegue Docker (`frontend/index.html`, `frontend/js/app.js`)

En la pestaña "Desplegar mi app" de Docker, cuando la plantilla es `python`:

- **Toggle "Servicio web / Worker-Bot"**. En modo worker se ocultan Puerto Host,
  Puerto Contenedor y Dominio/SSL.
- **Campo "Comando de arranque"** editable, con valor por defecto `python app.py` y
  ayuda con ejemplos (`python bot.py`, `gunicorn -w 2 app:app`,
  `uvicorn main:app --host 0.0.0.0 --port 8000`).
- `deployDockerApp()` envía `startCmd` y `mode` en el cuerpo de `deploy/build`.
- Ajustar `onDeployTemplateChange()` para mostrar/ocultar estos controles según la
  plantilla y el modo.

## Flujo de despliegue (Docker, sin cambios estructurales)

```
subir ZIP
  → deploy/build (streaming):
      extraer → generar Dockerfile (plantilla python con CMD del usuario; EXPOSE solo si web)
      → docker build (falla si pip install falla)
      → crear contenedor (publica puerto solo si web)
      → arrancar
      → red: firewall + dominio + HTTPS solo si web
```

## Manejo de errores

- **`pip install` falla:** el `docker build` termina con código ≠ 0 y su salida real ya
  se transmite al log en vivo; el flujo aborta y limpia el directorio temporal (como hoy).
- **Comando de arranque inválido** (vacío o con saltos de línea): `fail(400)` con
  mensaje en español antes de empezar a construir.
- **Worker con puerto/dominio enviados por error:** aviso claro (o se ignoran de forma
  documentada), nunca se mapea un puerto en modo worker.

## Criterios de éxito

1. Desplegar un bot de Telegram en Docker (ZIP con `bot.py` + `requirements.txt`,
   modo **worker**): la imagen se construye instalando dependencias, el contenedor
   arranca ejecutando `python bot.py`, **sin** `EXPOSE`, sin mapeo de puerto, sin
   firewall ni dominio.
2. Desplegar un servicio web en Docker (FastAPI con `uvicorn`, modo **web** con puerto):
   se inyecta `PORT`, se publica el Puerto Host, y si hay dominio se crea el proxy/HTTPS.
3. Un `requirements.txt` con un paquete inexistente **falla el build** y muestra el
   error real en el log (no produce una imagen rota silenciosa).
4. El usuario puede cambiar el comando de arranque por defecto, y un comando con saltos
   de línea es rechazado con un mensaje claro.
```
