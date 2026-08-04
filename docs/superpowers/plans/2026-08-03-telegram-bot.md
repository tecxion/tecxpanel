# Plan — Bot de Telegram bidireccional

**Spec:** `docs/superpowers/specs/2026-08-03-telegram-bot-design.md`
**Rama:** `feat/telegram-bot`
**Estilo:** TDD por tarea. Cada paso deja código y test verdes antes de pasar al siguiente. Sin placeholders.

---

## Tarea 1 — Extracción de `readErrorFeed` a `lib/logs.js`

**Motivo:** el comando `/errors` del bot necesita el mismo feed que la pestaña "Errores" del panel, sin duplicar la lectura de disco ni la regex.

**Código a añadir en `backend/lib/logs.js`:**

```js
const fs = require('fs');
const { runSafe } = require('./common/run');
const { LOG_FILES } = require('./validators');

const RE_ERR = /(error|crit|alert|emerg|denied|fail|warn|fatal)/i;

// Devuelve las últimas líneas de nginx_error + syslog filtradas a errores,
// cada una prefijada con [nginx]/[system]. Sin efectos: solo lee ficheros.
async function readErrorFeed(lines = 20) {
  const collect = async (label, file) => {
    if (!fs.existsSync(file)) return [];
    const r = await runSafe('tail', ['-n', String(lines), file]);
    return (r.stdout || '').split('\n')
      .filter((l) => l && RE_ERR.test(l))
      .map((l) => `[${label}] ${l}`);
  };
  const [n, s] = await Promise.all([
    collect('nginx',  LOG_FILES.nginx_error),
    collect('system', LOG_FILES.system),
  ]);
  return [...n, ...s].slice(-lines);
}

module.exports.readErrorFeed = readErrorFeed;
```

**Cambio en `backend/routes/logs.js`:** `GET /errors` pasa a llamar a `readErrorFeed(lines)` y ya no tiene la regex ni el `tail` inline.

**Test:** `backend/test/logs.test.js` (nuevo) — mock de `fs.existsSync` y `runSafe`, verifica que `readErrorFeed(5)`:
- Devuelve array.
- Filtra líneas sin patrón de error.
- Prefija con `[nginx]`/`[system]`.
- Recorta al límite pedido.

---

## Tarea 2 — Esquema BD: `telegram_admin_ids`

**Archivo:** `backend/db/schema/notify_config.sql` — añadir columna al `CREATE TABLE`:

```sql
telegram_admin_ids TEXT NOT NULL DEFAULT '[]',
```

**Query nueva en `backend/db/queries/notify.js`:**

```js
setTelegramAdmins: db.prepare('UPDATE notify_config SET telegram_admin_ids = ? WHERE id = 1'),
```

`getNotifyConfig` ya devuelve la fila entera, así que la nueva columna aparece sola.

**Test:** `backend/test/notify.test.js` — helper puro nuevo `parseAdminIds(raw)` que devuelve `[]` si el JSON es inválido y filtra a enteros positivos. Testea entrada válida, entrada vacía, entrada rota, entrada con basura.

**Instalación limpia:** como no hay migraciones (spec v2), este cambio solo aplica a BD nueva. Aviso en el commit: quien tenga instalación previa debe borrar `data/txpl.db` o hacer el `ALTER TABLE` a mano una vez (`ALTER TABLE notify_config ADD COLUMN telegram_admin_ids TEXT NOT NULL DEFAULT '[]';`).

---

## Tarea 3 — Helpers puros del bot (`lib/notifications/bot-commands.js`)

Función pura por comando. Todas devuelven `{ text }` para que el poller solo tenga que enviar. Ninguna toca `req/res`.

```js
// Firmas
async function cmdStatus()                      // { text }
async function cmdServices()                    // { text }
async function cmdErrors(lines)                 // { text }
async function cmdApps()                        // { text }
async function cmdRestart(appName)              // { text, audit: {action, detail} }
async function cmdSsl()                         // { text }
async function cmdBackups(n)                    // { text }
function cmdHelp()                              // { text }  (síncrona)
```

Cada una:
- Valida sus args (número entero acotado, nombre de app existente en `queries.listApps`, etc.). Si falla la validación → `{ text: 'Uso: /restart <nombre-app>' }` con la ayuda concreta.
- Reutiliza los helpers listados en la spec (`systeminformation`, `runSafe`, `parseCertbotCertificates`, `queries.*`).
- Formatea a texto plano corto.

**Test:** `backend/test/bot-commands.test.js` — mockea `runSafe` y `queries` con doubles. Testea:
- `cmdRestart('inexistente')` → mensaje de error sin llamar a `runSafe`.
- `cmdRestart('valida')` → llama a `runSafe('pm2', ['restart', 'valida'])` y devuelve texto de éxito.
- `cmdErrors(9999)` → clampa a máximo 50.
- `cmdHelp()` → contiene la lista de todos los comandos.

---

## Tarea 4 — Router de comandos (`lib/notifications/bot-router.js`)

Único punto de entrada: `dispatch(update, cfg)` donde `update` es el objeto que devuelve `getUpdates` de Telegram y `cfg` es la fila de `notify_config`.

Responsabilidades:
1. Extrae `msg = update.message`. Si no hay, ignora.
2. `fromId = msg.from.id`. Si `!cfg.telegram_admin_ids.includes(fromId)`:
   - Si la lista está vacía **y** el texto es `/start` → registra en `audit_log` `action='bot.start-unclaimed'`, `detail='from_id=<n>'` y responde con "Este bot no tiene admins. Pega este ID en Ajustes → Notificaciones → Admins: `<n>`".
   - En cualquier otro caso: ignorar en silencio (no responder, no auditar).
3. Rate limit (map en memoria del módulo, `Map<fromId, [ts,ts,…]>`): si en la última ventana de 60 s hay ≥30 comandos → responder "espera un momento" y salir.
4. Parsear el texto: primera palabra es el comando (case-insensitive), resto son args.
5. Buscar en un `COMMANDS = { status: cmdStatus, services: cmdServices, ... }`. Si no existe → responder con `/help`.
6. Ejecutar, capturar excepciones (responden "error interno"), enviar `text` de vuelta, auditar `bot.<comando>` con args.

**Test:** `backend/test/bot-router.test.js` — inyecta `sendTelegram` y `audit` como spies. Cubre:
- Mensaje de admin desconocido con allowlist no vacía → sin efecto (sin spy invocado).
- `/start` con allowlist vacía → responde con el ID y audita `bot.start-unclaimed`.
- Comando válido → invoca `sendTelegram` una vez y audita.
- Comando inválido → responde con `/help` y audita `bot.unknown`.
- 31 comandos válidos seguidos del mismo `from.id` → el 31 responde "espera un momento".

---

## Tarea 5 — Poller (`lib/notifications/bot.js`)

Un solo módulo exportando `{ start, stop }` como singleton.

```js
let controller = null;
let offset = 0;
let backoffMs = 5000;

async function loop(token, getCfg) {
  while (controller) {
    try {
      controller = new AbortController();
      const url = `https://api.telegram.org/bot${token}/getUpdates?timeout=30&offset=${offset}`;
      const res = await fetch(url, { signal: controller.signal });
      const data = await res.json();
      if (!data.ok) throw new Error(data.description);
      backoffMs = 5000;
      for (const upd of data.result) {
        offset = upd.update_id + 1;
        try { await require('./bot-router').dispatch(upd, getCfg()); }
        catch (e) { console.error('[bot] router:', e.message); }
      }
    } catch (e) {
      if (e.name === 'AbortError') return;
      console.error('[bot] poll:', e.message);
      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, 60000);
    }
  }
}

function start(getCfg) {
  const cfg = getCfg();
  if (!cfg?.telegram_enabled || !cfg.telegram_token) return;
  const admins = JSON.parse(cfg.telegram_admin_ids || '[]');
  if (!admins.length) return;
  if (controller) return;
  controller = new AbortController();
  loop(cfg.telegram_token, getCfg);
}

function stop() {
  if (controller) { controller.abort(); controller = null; }
}

module.exports = { start, stop };
```

**Sin tests unitarios** para este módulo — es glue puro sobre `fetch`, el valor de testear estaría todo mockeando `fetch`. Sí se verifica manualmente en la Tarea 8.

---

## Tarea 6 — Arranque en `server.js` y hot-reload en la ruta

**Cambio en `backend/server.js`:** tras `seedAdmin()`:

```js
require('./lib/notifications/bot').start(() => queries.getNotifyConfig());
process.on('SIGTERM', () => require('./lib/notifications/bot').stop());
```

**Cambio en `backend/routes/notifications.js` (POST de guardado de config):** al final del handler, tras persistir:

```js
const bot = require('../lib/notifications/bot');
bot.stop();
bot.start(() => queries.getNotifyConfig());
```

Reinicia el poller para tomar el nuevo token/allowlist sin reiniciar PM2.

**Test:** ninguno nuevo, solo verificar que `npm test` sigue verde tras el cambio del `server.js` (el test suite ya carga `server.js` para los tests de routes).

---

## Tarea 7 — UI mínima en Ajustes → Notificaciones

**Cambios en `frontend/views/pages/settings.html`** (o la vista de notificaciones — a confirmar al abrirla): añadir campo:

```html
<label>Admins de Telegram (IDs separados por coma)
  <input id="notify-tg-admins" placeholder="123456789, 987654321">
</label>
```

**Cambios en el JS correspondiente:** al cargar la config poblar el input con `admins.join(', ')`; al guardar, `admins.split(',').map(s => parseInt(s.trim(),10)).filter(Number.isFinite)` y enviarlo al backend.

**Backend (`routes/notifications.js`):** el POST acepta `telegram_admin_ids` como array de números; lo valida (array de enteros positivos ≤ 32 bits) y lo guarda como JSON.

**Test:** `backend/test/notify.test.js` extendido — el helper `parseAdminIds` ya cubre el parseo; añadir un caso de la validación del router (POST con array mixto → guarda solo los enteros).

---

## Tarea 8 — Verificación manual + docs

1. Sobre BD nueva: instalar panel, configurar bot con token real, enviar `/start` desde móvil → panel debe auditar `bot.start-unclaimed` con el ID.
2. Pegar el ID en el input de Ajustes → guardar → enviar `/status` → recibir respuesta con CPU/RAM/disco.
3. Probar `/errors`, `/apps`, `/restart <app>` (verificar en `pm2 list` que el proceso reinició), `/ssl`, `/backups`.
4. Con otro usuario Telegram (ID no en la lista) enviar `/status` → sin respuesta, sin audit.
5. Reiniciar el panel con PM2 → verificar que SIGTERM cierra el poll en <2 s (no cuelga 30 s esperando el long-poll).
6. **README.md** y **CLAUDE.md**: sección nueva "Bot de Telegram" con la tabla de comandos y las decisiones de seguridad. Añadirlo a las novedades v2.1 en README.

---

## Orden de ejecución sugerido

Tareas 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8. Cada una es fusionable por sí sola (el bot solo arranca en la 6, así que 1-5 no cambian comportamiento visible). Tras 5 el bot ya "existe" pero sin allowlist ni ruta que lo arranque, sigue siendo inerte.

## Fuera del plan (v2 futura)

- Comandos destructivos con doble confirmación (`/delete-site`, `/drop-db`).
- Inline keyboards (botones) en respuestas — requiere manejar `callback_query`, más superficie.
- Notificaciones proactivas del monitor con botones "Reiniciar servicio" inline.
