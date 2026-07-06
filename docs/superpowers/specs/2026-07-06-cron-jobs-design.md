# Diseño: Tareas Programadas (Cron Jobs)

Fecha: 2026-07-06
Estado: aprobado (pendiente de plan de implementación)

## Objetivo

Añadir un gestor visual de **tareas cron** al panel, estilo cPanel/Plesk: crear
tareas con un comando arbitrario y una programación construida con un asistente
guiado, activarlas/desactivarlas, editarlas, borrarlas y ver la salida (log) de
cada una. El panel gestiona **solo sus propias tareas** en el crontab de root,
sin tocar líneas ajenas (incluida la del `backup-runner.js`).

## Decisiones tomadas

- **Editor de crontab completo** (opción A): comando arbitrario + programación,
  con CRUD completo.
- **El panel gestiona solo "sus" tareas, marcadas**: cada tarea creada desde el
  panel lleva un marcador `# txpl-cron:<id>`. Las líneas externas (incluida la
  de backups) se respetan y no se muestran ni se editan.
- **Constructor guiado** para la programación (desplegables minuto/hora/día/mes/
  día-semana + presets comunes). Sin campo de expresión cron cruda en la v1.
- **Log por tarea**: la salida se redirige a `/var/log/txpl/cron/<id>.log` y el
  panel deja ver ese log. Sin email (el módulo de email llega más adelante).
- **Toggle activar/desactivar** (estilo Plesk): desactivar = no emitir la tarea
  al crontab, conservándola en la base de datos.

Fuera de alcance v1: expresión cron cruda / modo avanzado, envío por email,
tareas curadas por catálogo, gestión de crontabs de otros usuarios (solo root,
que es bajo quien corre el panel).

## Modelo y fuente de la verdad

La **base de datos es la fuente de la verdad**; el crontab de root es una
**proyección** de las filas activas (mismo patrón que la programación de
backups).

Tabla `cron_jobs`:

| Campo      | Tipo    | Descripción                                        |
| ---------- | ------- | -------------------------------------------------- |
| id         | INTEGER | PK                                                 |
| name       | TEXT    | Nombre legible de la tarea                         |
| command    | TEXT    | Comando a ejecutar (arbitrario, sin saltos de línea)|
| minute     | TEXT    | Campo cron (minuto)                                |
| hour       | TEXT    | Campo cron (hora)                                  |
| dom        | TEXT    | Campo cron (día del mes)                           |
| month      | TEXT    | Campo cron (mes)                                   |
| dow        | TEXT    | Campo cron (día de la semana)                      |
| enabled    | INTEGER | 0/1                                                |
| created_at | TEXT    | Timestamp                                          |

En cada mutación (crear/editar/toggle/borrar), el panel **reescribe el crontab
de root**:

1. Lee el crontab actual (`crontab -l`).
2. Conserva **todas** las líneas que NO pertenecen al bloque gestionado por cron
   (se identifican por el marcador `# txpl-cron:` y su línea de comando
   siguiente). Esto preserva la línea de `backup-runner.js` y cualquier entrada
   que el usuario o el instalador hayan puesto a mano.
3. Regenera el bloque gestionado a partir de las filas `enabled = 1` de
   `cron_jobs`. Cada tarea produce dos líneas:
   ```
   # txpl-cron:<id>
   <minute> <hour> <dom> <month> <dow> <command> >> /var/log/txpl/cron/<id>.log 2>&1
   ```
4. Escribe el resultado vía **fichero temporal + `crontab <file>`** (execFile con
   array, sin shell ni stdin), igual que hace la programación de backups.

### Invariante de convivencia (importante)

El crontab de root lo escriben dos módulos: backups (línea con `backup-runner.js`)
y cron (bloque `# txpl-cron:`). **Cada módulo, al reescribir, solo elimina SUS
propias líneas y conserva el resto.** Así nunca se pisan:

- Backups filtra fuera las líneas que contienen `backup-runner.js` y conserva el
  resto (incluidos los bloques `# txpl-cron:`).
- Cron filtra fuera los marcadores `# txpl-cron:` y su línea de comando siguiente,
  y conserva el resto (incluida la de `backup-runner.js`).

## Arquitectura (3 capas, patrón de backups/n8n)

- `backend/lib/cron.js` — **helpers puros y testeables** (sin estado ni DB):
  - `isValidCronField(token)` — valida un campo cron (`*`, números, rangos
    `a-b`, pasos `*/n` o `a-b/n`, listas separadas por comas). Rechaza basura.
  - `isValidCommand(cmd)` — comando no vacío y **sin `\n` ni `\r`** (evita
    inyección de líneas adicionales en el crontab).
  - `buildCronJobLines({ id, minute, hour, dom, month, dow, command })` →
    string de dos líneas (marcador + línea de cron con redirección al log).
  - `cronLogPath(id)` → `/var/log/txpl/cron/<id>.log`.
  - `rebuildCrontab(currentText, jobs)` — dado el texto actual del crontab y las
    tareas activas, devuelve el texto nuevo: conserva las líneas ajenas
    (filtra los bloques `# txpl-cron:` previos) y añade el bloque regenerado.
  - `describeSchedule(fields)` — texto legible para la UI (ej. "cada día a las
    03:00"); opcional, puede vivir en el frontend.
- `backend/routes/cron.js` — router `/api/cron` (JWT). Endpoints:
  - `GET /` — lista de tareas desde la DB.
  - `POST /` — crea (valida campos + comando, inserta, reescribe crontab).
  - `PUT /:id` — edita (valida, actualiza, reescribe crontab).
  - `POST /:id/toggle` — activa/desactiva (actualiza `enabled`, reescribe).
  - `DELETE /:id` — borra la fila, reescribe crontab, borra el log si existe.
  - `GET /:id/log` — devuelve las últimas líneas del log (path jail dentro de
    `/var/log/txpl/cron`).
- `backend/database.js` — tabla `cron_jobs` + queries (`listCronJobs`,
  `getCronJob`, `insertCronJob`, `updateCronJob`, `setCronJobEnabled`,
  `deleteCronJob`).

## Frontend

Nuevo item **"Tareas programadas"** en `frontend/views/sidebar.html` →
`frontend/views/pages/cron.html` (cargada por `loadTemplates`), lógica en
`frontend/js/app.js`:

- Tabla de tareas: nombre, programación legible, comando, estado
  (activa/inactiva), acciones.
- Formulario de alta/edición con **constructor guiado**: nombre, comando, y la
  programación mediante desplegables (minuto/hora/día del mes/mes/día de la
  semana) más presets rápidos ("cada hora", "cada día a las HH:MM", "cada
  semana el <día>").
- Acciones por tarea: **editar**, **activar/desactivar**, **ver log**, **borrar**.
- Todo dato externo (nombre, comando) se escapa con `esc()` antes de
  interpolar en `innerHTML`.

## Seguridad

- El comando es **arbitrario y se ejecuta como root** — potente por diseño (como
  la terminal integrada); el acceso ya está tras JWT de admin. La defensa clave
  es **evitar la inyección en el crontab**: `isValidCommand` rechaza `\n`/`\r`, y
  cada campo de programación se valida con `isValidCronField`.
- **Escritura de crontab sin shell**: fichero temporal + `crontab <file>` con
  `execFile` (array de argumentos).
- **Path jail** al leer el log: resolver la ruta y verificar que empieza por
  `/var/log/txpl/cron/` antes de leer.
- **Auditoría** (`audit`) en cada alta, edición, toggle y borrado.
- El directorio `/var/log/txpl/cron` se crea con permisos razonables (`0700`).

## Pruebas

Tests unitarios de `backend/lib/cron.js` con `node:test`:

- `isValidCronField`: acepta `*`, `5`, `1-5`, `*/10`, `0-30/5`, `1,15,30`;
  rechaza `abc`, `*/`, `60` fuera de rango razonable (validación de forma, no
  necesariamente de rango exacto), cadenas con espacios.
- `isValidCommand`: rechaza vacío y cadenas con `\n`/`\r`; acepta un comando
  normal.
- `buildCronJobLines`: produce el marcador + la línea con los 5 campos, el
  comando y la redirección `>> /var/log/txpl/cron/<id>.log 2>&1`.
- `rebuildCrontab`: conserva una línea ajena (ej. la de `backup-runner.js`),
  elimina bloques `# txpl-cron:` previos y añade el bloque nuevo; con lista
  vacía deja el crontab sin bloque gestionado pero con las líneas ajenas.

## Patrones reutilizados del código existente

- Escritura de crontab vía fichero temporal + `crontab <file>` (de
  `routes/backups.js`).
- Helpers puros aislados y testeados (de `lib/backups.js` / `lib/n8n.js`).
- `run()`/`runSafe()` de `helpers.js`; `audit()`; patrón de tabla + queries de
  `database.js`; sección frontend con `esc()` y `req()`.
- Lectura de log al estilo del módulo `logs.js` (tail acotado).
