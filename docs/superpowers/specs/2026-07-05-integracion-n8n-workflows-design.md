# Diseño — Integración de n8n (Workflows) en el panel

**Fecha:** 2026-07-05
**Estado:** Aprobado (Fase 1)

## Contexto

TecXPaneL gestiona apps (PM2), contenedores (Docker), webs (Nginx), bases de
datos, firewall y SSL desde una única UI. Se quiere añadir **n8n** (automatización
de flujos) integrado con el panel, no como herramienta suelta.

n8n no es un simple paquete: es un **servicio web persistente** (puerto 5678 por
defecto) que necesita ejecución continua, proxy Nginx, dominio, SSL y datos
persistentes — más parecido a desplegar una app que a instalar Redis.

Decisiones tomadas en el brainstorming:

- **Ejecución en Docker** (método oficial de n8n; además el proyecto tiende a
  migrar todo a Docker más adelante).
- **Nivel de integración: "panel como orquestador"** (opción B). El panel muestra
  y controla workflows/ejecuciones sin salir de TecXPaneL. El **editor de n8n NO
  se reimplementa**: para editar se hace **deep-link** a la UI propia de n8n.
- **Una instancia n8n por VPS**, con **una** config de conexión (URL + API key)
  configurada por un admin. n8n community es single-tenant: no tiene sentido una
  key por usuario del panel.

### Límites confirmados de la API de n8n

- **Sí** se puede: listar workflows con su estado, activar/desactivar
  (`POST /api/v1/workflows/:id/activate` y `/deactivate`), listar ejecuciones con
  estado (`/api/v1/executions`).
- **Disparo:** el camino fiable es la **URL de webhook** del propio workflow
  (cubre ~90% de casos). El endpoint `/execute` es inconsistente y no acepta datos
  de entrada, por lo que **no** se promete.
- **Iframe:** n8n bloquea el embebido por defecto (`frame-ancestors 'self'` +
  `X-Frame-Options`). Se descarta embeber el editor; se usa deep-link.

## Principio transversal: sin secretos hardcodeados

El repositorio es **público**: cualquiera puede clonarlo e instalar el panel en su
propio VPS. Por tanto **ningún secreto del autor puede vivir en el código ni en los
instaladores**. Cada instalación **genera o solicita** sus propias credenciales.

Aplicación concreta:

- **n8n:** la API key se **pide** en el asistente de conexión y se guarda cifrada
  con `encryptSecret`. Nunca hay un valor por defecto.
- **`setup.sh` / `update.sh`:** deben generar frescos `JWT_SECRET` y
  `TXPL_SECRET_KEY`, y solicitar `ADMIN_USER` / `ADMIN_PASS`. No pueden traer
  valores del autor. **Se auditará** durante la implementación y se corregirá si
  algún secreto está fijado.
- **`.env` de apps desplegadas:** los valores sensibles (tokens, claves) se piden
  a quien despliega; no se asumen ni se rellenan con datos del autor.

## Alcance

**Incluido (Fase 1):**

- Módulo backend dedicado `backend/routes/n8n.js` (montado en `/api/n8n`, JWT).
- Instalación de n8n como contenedor Docker con volumen persistente + proxy Nginx
  opcional, vía streaming (como los plugins).
- Tabla `n8n_config` (fila única) con URL base y API key cifrada.
- Asistente de conexión en el frontend para pegar y validar la API key.
- Dashboard "Workflows": listar workflows, activar/desactivar, ver ejecuciones
  recientes, deep-link a n8n, y URL de webhook + "probar" para workflows con
  trigger webhook.
- Tests con `node:test` (sin dependencias nuevas).

**Excluido (YAGNI / futuras fases):**

- Editor embebido / iframe de n8n.
- Multi-tenant (una config por usuario del panel).
- Disparo genérico vía `/execute`.
- Crear/editar workflows desde el panel (siempre en la UI de n8n).

## Arquitectura

```
┌─────────────── TecXPaneL ───────────────┐
│  Frontend: sección "Workflows" (n8n)     │
│    - Estado n8n (instalado/corriendo)    │
│    - Asistente de instalación/conexión   │
│    - Lista workflows + toggle activo     │
│    - Ejecuciones recientes + estado      │
│    - Webhook URL + "probar"              │
│    - Botón "Abrir en n8n" (deep-link)    │
└──────────────┬───────────────────────────┘
               │ /api/n8n/*  (JWT)
┌──────────────▼─────────── backend/routes/n8n.js ───────────┐
│  Infra        →  dockerRequest() crea contenedor n8nio/n8n │
│                  + volumen persistente + proxy Nginx        │
│  Config       →  tabla n8n_config (base_url, api_key cifr.) │
│  Orquestación →  proxy a la Public API de n8n con la key    │
└───────┬───────────────────────────────┬────────────────────┘
        │ Docker UNIX socket            │ HTTP + X-N8N-API-KEY
┌───────▼─────────┐          ┌──────────▼───────────┐
│ Contenedor n8n  │◄──Nginx──│  API pública de n8n  │
│ (Docker+volumen)│  proxy   │  /api/v1/workflows…  │
└─────────────────┘          └──────────────────────┘
```

Dos responsabilidades separadas dentro del módulo:

1. **Ciclo de vida (infra):** instalar/arrancar/parar/desinstalar el contenedor
   n8n + proxy. Usa el socket Docker (`dockerRequest`).
2. **Orquestación (datos):** el panel actúa de proxy autenticado hacia la Public
   API de n8n. Nunca reimplementa el editor.

## Modelo de datos

Tabla nueva `n8n_config` (una sola fila, `id = 1`), creada con
`CREATE TABLE IF NOT EXISTS` (mismo patrón que el resto del esquema):

| columna | tipo | nota |
|---|---|---|
| `id` | INTEGER PK | siempre 1 |
| `base_url` | TEXT | ej. `https://n8n.midominio.com` |
| `api_key_enc` | TEXT | cifrada con `encryptSecret` |
| `container_id` | TEXT | id/nombre del contenedor |
| `domain` | TEXT | dominio del proxy (nullable) |
| `host_port` | INTEGER | por defecto 5678 |
| `status` | TEXT | estado |
| `created_at` | TEXT | timestamp |

Queries nuevas exportadas desde `database.js`: `getN8nConfig`, `upsertN8nConfig`,
`setN8nApiKey`, `clearN8nConfig`.

## Componentes y endpoints

Todos bajo `/api/n8n`, protegidos por JWT como el resto del panel. Toda acción
mutadora pasa por `audit(user, ip, action, detail)`.

### Infra (ciclo de vida)

- `GET /status` — devuelve si n8n está **instalado** (contenedor existe),
  **corriendo** y **configurado** (hay API key). El frontend decide la vista.
- `POST /install` — *streaming* (patrón de plugins): `pull n8nio/n8n`, crear
  contenedor con volumen persistente `n8n_data:/home/node/.n8n`, puerto host
  (5678 por defecto), `RestartPolicy: unless-stopped`, envs (`N8N_HOST`,
  `N8N_PORT`, `WEBHOOK_URL`, zona horaria). Si se indica dominio, crea el vhost
  Nginx reutilizando el helper de `websites.js`. **Requiere Docker**: si el socket
  no responde, mensaje accionable ("instala Docker desde Plugins") y no continúa.
- `POST /config` — guardar/actualizar `base_url` + API key. **Valida la key**
  llamando una vez a `/api/v1/workflows?limit=1`; si responde OK, la cifra con
  `encryptSecret` y la guarda; si no, error explícito.
- `POST /:action` — `start` / `stop` / `restart` del contenedor (vía
  `dockerRequest`). Valida `action` contra una whitelist.
- `DELETE /` — desinstalar: borra el contenedor; volumen y vhost opcionales con
  confirmación explícita.

### Orquestación (proxy a la API de n8n; requiere config)

- `GET /workflows` — proxy a `/api/v1/workflows` (id, nombre, activo, tags).
- `POST /workflows/:id/activate` · `POST /workflows/:id/deactivate` — proxy.
- `GET /executions` — proxy a `/api/v1/executions?limit=N` (estado:
  éxito/error/en curso).
- Disparo manual: **solo para workflows con trigger webhook** — el panel expone la
  URL de webhook de producción y un botón "probar". No se ofrece `/execute`
  genérico.

### Helper `n8nApi(method, path, body)`

Lee `n8n_config`, descifra la API key, pone la cabecera `X-N8N-API-KEY`, llama a
`base_url + path`. Mismo espíritu que `dockerRequest`. Aislado y testeable con
`fetch` mockeado. Propaga errores (no los oculta).

## Frontend — sección "Workflows"

Vanilla JS sobre la SPA existente (`navigate()`), sin framework. Vista
**adaptativa** según `GET /status`:

- **Docker ausente** → aviso + enlace a la sección Plugins.
- **n8n no instalado** → botón "Instalar n8n" con consola de streaming.
- **n8n corre pero sin key** → asistente de conexión: instrucciones ("abre n8n,
  crea tu cuenta propietaria, Settings → API, genera tu key"), botón "Abrir n8n"
  y campo para pegar la API key (se valida antes de guardar).
- **Instalado + configurado** → dashboard:
  - Estado del contenedor + start/stop/restart.
  - Tabla de workflows: nombre, tags, toggle activo/inactivo, "Abrir en n8n"
    (deep-link, pestaña nueva); si tiene webhook, su URL + "probar".
  - Tabla de ejecuciones recientes: workflow, estado (✓/✗/⏳), fecha.
  - Botón "Reconfigurar" (cambiar dominio/key).

## Flujo de despliegue (feliz)

```
Workflows → Instalar n8n (Docker + volumen + proxy)
  → abrir n8n, crear cuenta propietaria, generar API key
  → pegar key en el asistente → panel valida → guarda cifrada
  → dashboard: listar / activar / monitorizar / disparar-webhook
  → editar workflows = "Abrir en n8n" (deep-link)
```

## Manejo de errores

Criterio del proyecto: **sin fallos silenciosos**, salida real al usuario.

- **Docker ausente / socket caído:** mensaje accionable; no continúa.
- **`pull` o creación de contenedor falla:** salida real al log de streaming.
- **API key inválida o n8n inaccesible:** error explícito en `/config` y en cada
  llamada de orquestación; el dashboard muestra "n8n no responde / reconfigura".
- **Puerto 5678 ocupado:** detectar y permitir elegir otro puerto en el install.
- **Auditoría:** toda acción mutadora se registra con `audit(...)`.

## Tests

Con el runner `node:test` (sin dependencias nuevas), en línea con
`backend/test/appdeploy.test.js`:

1. `n8nApi` construye bien URL y cabecera `X-N8N-API-KEY`, y propaga errores
   (con `fetch` mockeado).
2. La config del contenedor n8n es correcta: imagen `n8nio/n8n`, volumen
   `n8n_data`, puerto, `RestartPolicy: unless-stopped`.
3. Validación de la API key (caso éxito y caso fallo).
4. Lógica de `/status` (instalado / corriendo / configurado) con distintos
   estados de entrada.

## Criterios de éxito

1. Desde "Workflows", instalar n8n en Docker con volumen persistente y (opcional)
   proxy Nginx; el contenedor queda corriendo con `RestartPolicy: unless-stopped`.
2. Pegar una API key válida en el asistente: el panel la valida contra la API de
   n8n y la guarda cifrada; una key inválida se rechaza con mensaje claro.
3. El dashboard lista los workflows reales, permite activar/desactivar uno y el
   cambio se refleja en n8n.
4. Las ejecuciones recientes se muestran con su estado.
5. "Abrir en n8n" lleva al editor de n8n en pestaña nueva.
6. Ningún secreto del autor queda hardcodeado: la key se solicita siempre, y
   `setup.sh`/`update.sh` generan/solicitan sus propias credenciales.
