# Diseño — Barra de progreso en la descarga de la imagen de n8n

**Fecha:** 2026-07-05
**Estado:** Aprobado

## Contexto

La instalación de n8n (`POST /api/n8n/install`, en `backend/routes/n8n.js`) descarga
la imagen Docker `n8nio/n8n` con:

```js
write(`⏳ Descargando imagen ${N8N_IMAGE}...\n`);
const pull = await dockerRequest('POST', `/images/create?fromImage=...`);
```

`dockerRequest` **bufferiza toda la respuesta** y solo resuelve al terminar. La
imagen de n8n es grande y tarda varios minutos, durante los cuales el usuario no
ve ningún avance: parece que el VPS se ha colgado.

La API de Docker `/images/create` en realidad emite líneas JSON de progreso en
vivo (una por evento), p. ej.:

```json
{"status":"Downloading","progressDetail":{"current":N,"total":M},"id":"capa"}
{"status":"Download complete","id":"capa"}
{"status":"Extracting","progressDetail":{"current":N,"total":M},"id":"capa"}
{"status":"Pull complete","id":"capa"}
{"error":"..."}                     // en caso de fallo
```

El objetivo es leer ese progreso en streaming y mostrar una **barra de % de
descarga** en la consola de instalación del panel.

## Alcance

**Incluido:**
- Helper puro `accumulatePullProgress` en `backend/lib/n8n.js` que agrega el
  progreso por capa y devuelve un `%` global + fase, testeado con `node:test`.
- Pull en streaming en `POST /install`: leer el socket de Docker, parsear líneas
  JSON, y emitir al cliente marcadores `__TXPL_PROGRESS__<pct>` (throttled).
- Barra de progreso en el frontend (`n8n.html` + `n8nInstall` en `app.js`).

**Excluido (YAGNI):**
- Barra de progreso para la fase de extracción (se muestra como texto; es corta).
- % por capa individual en la UI (solo el global).
- Barra de progreso para otras instalaciones (plugins, apps) — fuera de alcance.

## Componentes

### 1. `backend/lib/n8n.js` — `accumulatePullProgress(state, event)`

- **Entrada:** `state` = objeto acumulador `{ layers: { <id>: { current, total } } }`
  (inicialmente `{ layers: {} }`); `event` = un objeto JSON ya parseado de la API
  de Docker.
- **Comportamiento:**
  - Si `event.status === 'Downloading'` y hay `progressDetail.total`, guarda/actualiza
    `state.layers[event.id] = { current, total }`.
  - Calcula `pct = Math.floor(100 * sum(current) / sum(total))` sobre las capas
    conocidas (0 si `sum(total) === 0`), acotado a [0, 100].
  - Determina `phase`: `'extracción'` si el evento es `Extracting`/`Extract`;
    `'descarga'` en caso contrario.
  - Detecta error: si `event.error` existe, devuelve `{ error: event.error }`.
- **Salida:** `{ pct, phase, error }` (con `error` normalmente `null`). Sin efectos
  secundarios: muta el `state` que recibe (patrón acumulador) y devuelve el cálculo.
- **Testeable** con una secuencia de eventos, sin red.

### 2. `backend/routes/n8n.js` — pull en streaming

- Reemplazar el `await dockerRequest('POST', '/images/create?...')` por una
  petición `http.request` directa al socket de Docker (mismo socket
  `/var/run/docker.sock`, mismo patrón que `dockerRequest`), envuelta en una
  promesa, que:
  - Acumula chunks y los parte por saltos de línea; cada línea completa se
    `JSON.parse` (ignorando líneas vacías / parciales, que se guardan para el
    siguiente chunk).
  - Por cada evento llama a `accumulatePullProgress(state, event)`.
  - Si devuelve `error`: escribe `✖ Error al descargar la imagen: <error>` y
    resuelve la promesa como fallo → `done(1)`.
  - Si el `pct` entero cambió respecto al último emitido, escribe al cliente
    `__TXPL_PROGRESS__<pct>\n` (throttling por cambio de entero).
  - Al cerrarse el stream sin error (fase de descarga completa), escribe
    `✓ Imagen lista.\n` y continúa con el resto del handler (crear contenedor,
    proxy, guardar config) **sin cambios**.
- Manejo de corte: si el socket emite `error` o se cierra inesperadamente antes de
  completar, se resuelve como fallo con el mensaje real y `done(1)`.

### 3. Frontend — `frontend/views/pages/n8n.html` + `frontend/js/app.js`

- **`n8n.html`:** añadir sobre/junto a la consola una barra de progreso oculta por
  defecto (`id="n8n-progress"`), con una barra interior (`id="n8n-progress-bar"`)
  cuyo ancho se fija a `<pct>%`, y una etiqueta con el número.
- **`n8nInstall` (`app.js`):** en el bucle de lectura del stream, además del
  centinela `__TXPL_DONE__`, procesar las líneas `__TXPL_PROGRESS__<N>`:
  - Mostrar la barra (`display`), fijar el ancho a `N%` y la etiqueta a `N%`.
  - **Filtrar** esas líneas del texto que se vuelca en la consola (para no
    ensuciarla con cientos de marcadores).
  - Al terminar (`__TXPL_DONE__` o error), ocultar la barra.

## Protocolo de streaming

- El backend sigue usando el centinela final existente `__TXPL_DONE__<code>`.
- Se añade un marcador de progreso, una línea propia: `__TXPL_PROGRESS__<entero>`.
- El frontend separa líneas por `\n`; las que empiezan por `__TXPL_PROGRESS__`
  actualizan la barra y no se muestran como texto; el resto se muestra igual que hoy.

## Manejo de errores

- **Línea de error de Docker** (`{"error":...}`): mensaje real + `done(1)`; la barra
  se queda en su último valor.
- **Socket cortado / JSON inválido:** las líneas no parseables se ignoran de forma
  segura (se acumulan por si son parciales); un corte del socket resuelve como
  fallo con el mensaje real.
- Sin `|| true` que oculte fallos; sin cambios en el resto del pipeline de install.

## Tests

En `backend/test/n8n.test.js` (runner `node:test`, sin dependencias nuevas):

1. `accumulatePullProgress`: dos capas descargando (`current/total` distintos) →
   `pct` = suma combinada; una capa que completa mantiene su `total`; un evento
   `Extracting` marca `phase: 'extracción'`; un evento con `error` devuelve `error`.
2. Acotado: `sum(total) === 0` → `pct = 0`; nunca > 100.

## Criterios de éxito

1. Al instalar n8n, la consola muestra una barra que avanza con la descarga real de
   la imagen, en vez de quedarse aparentemente congelada.
2. Los marcadores de progreso no ensucian el texto de la consola.
3. Un fallo de descarga muestra el mensaje real y termina con código de error.
4. El resto del flujo de instalación (contenedor, proxy, config) no cambia.
