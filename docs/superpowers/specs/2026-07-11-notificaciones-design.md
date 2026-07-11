# Diseño: Notificaciones (Telegram + Email) — Fase 1

Fecha: 2026-07-11
Estado: aprobado (pendiente de plan de implementación)

## Objetivo

Que el panel avise al operador cuando algo va mal **sin que tenga que entrar a
mirar**: disco por encima de un umbral, servicio o contenedor caído, y eventos
de seguridad (bloqueo por fuerza bruta, login desde IP nueva). Canales:
**Telegram** (bot propio del operador) y **email por SMTP configurable**. Es la
mejora nº 1 del roadmap tras la comparativa con Plesk/cPanel/Hestia/Coolify.

## Decisiones tomadas

- **Telegram sin proceso bot**: enviar = `POST https://api.telegram.org/bot<TOKEN>/sendMessage`
  con `fetch` nativo (Node ≥ 18). No se despliega nada, no hay proceso que se
  caiga. El operador crea su bot con @BotFather (una vez, ~2 min) y pega el
  token en la UI; el `chat_id` se **autodetecta** con `getUpdates` tras pulsar
  /start en el bot (botón "Detectar chat").
- **Email por SMTP configurable** con **nodemailer** (dependencia nueva, JS puro
  sin binarios nativos). Sirve tanto para el propio `txpl-mail` (localhost) como
  para un SMTP externo (Gmail, Brevo…).
- **Monitor integrado en el proceso del panel** (`setInterval` de 60 s), NO un
  proceso separado por cron. El panel ya corre siempre bajo PM2; un proceso
  aparte añadiría spawns constantes contra la identidad de bajo consumo.
  Hallazgo que lo motiva: el tick de stats de `websocket.js` solo corre con el
  dashboard abierto — no sirve como vigilante.
- **Transición + recuperación** (estilo Uptime Kuma): un mensaje al aparecer el
  problema, silencio mientras persista, mensaje ✅ al recuperarse. Nada de
  re-avisos periódicos en esta fase.
- **Anti-flapping**: se exigen **2 chequeos consecutivos** en el nuevo estado
  antes de emitir. Evita el spam "🔴 caído / ✅ recuperado" al reiniciar un
  servicio desde el propio panel. Detección real ≈ 2 min.
- **Dos tipos de evento**:
  - *De estado* (disco, servicios, contenedores): pasan por transiciones,
    anti-flapping y recuperación, con estado persistido.
  - *Puntuales* (fuerza bruta, IP nueva): `notify(evento)` directo desde
    `auth.js`, sin estado ni recuperación.
- **"Login desde IP nueva" sin tabla nueva**: se consulta `audit_log` — si no
  existe login exitoso previo desde esa IP, se notifica.
- **Credenciales cifradas en reposo** (AES-256-GCM, patrón `n8n_config`):
  token de Telegram y contraseña SMTP. Nunca en logs ni en `audit_log`.
- **Qué se vigila**: los servicios del dashboard que estén instalados (Nginx,
  MySQL, PostgreSQL, Redis, SSH) por `systemctl is-active`, y los contenedores
  gestionados `txpl-*` por el socket Docker. Toggles por tipo de evento.
- **Mensajes con contexto**: `🔴 [<hostname>] Nginx caído desde 14:32` — el
  hostname distingue entre varios VPS con el mismo bot.
- **Aviso honesto en la UI**: si el VPS entero se cae, nada dentro de él puede
  avisar. Para eso: monitor externo (UptimeRobot, Uptime Kuma en otro servidor).
  Fuera del alcance de esta feature.

Fuera de alcance (fases futuras): notificación de backups fallidos/completados
(será una llamada a `notify()` en `backup-runner.js`), re-avisos periódicos,
más canales (Discord/webhook genérico), umbrales de CPU/RAM.

## Arquitectura (3 capas, patrón n8n/mail)

- `backend/lib/notifications.js` — **helpers puros y testeables** (sin estado ni DB):
  - `isValidTelegramToken(t)` / `isValidChatId(id)` / `isValidSmtpConfig(cfg)` —
    validadores de config.
  - `applyTick(prevState, currentStatus, now)` — la lógica de transiciones:
    recibe el estado persistido de un recurso y su estado actual, devuelve
    `{ nextState, event }` donde `event` es `null`, `'down'` o `'recovered'`.
    Implementa el anti-flapping (contador de confirmación: 2 ticks consecutivos)
    y el reintento (si `notified=false`, re-emite el evento en el siguiente tick).
  - `buildTelegramMessage(event)` / `buildEmailMessage(event)` — payloads:
    texto con emoji/hostname/recurso/hora para Telegram; subject + body para
    email. `event = { kind, resource, status, since, hostname, detail }`.
  - `RESOURCE_KEYS` — construcción de claves de estado (`disk`, `service:nginx`,
    `container:txpl-n8n`).
- `backend/lib/notifyExecutor.js` — **efectos**:
  - Lee la fila única de `notify_config`, descifra credenciales.
  - `sendTelegram(cfg, text)` — `fetch` a la API de Telegram con timeout.
  - `sendEmail(cfg, subject, body)` — nodemailer.
  - `dispatch(event)` — envía a todos los canales activos; el fallo de uno no
    bloquea al otro; devuelve si al menos uno tuvo éxito.
  - `detectChatId(token)` — `getUpdates` y extrae el chat del último /start.
- `backend/lib/monitor.js` — **el vigilante**:
  - `startMonitor()` llamado desde `server.js`; `setInterval(60_000).unref()`
    con guard anti-solapamiento (flag `busy`).
  - Cada tick: si no hay config o todo desactivado → return (coste cero).
    Recoge % disco, `systemctl is-active` de servicios instalados y estado de
    contenedores `txpl-*`; por cada recurso ejecuta `applyTick` contra
    `notify_state`, despacha eventos con el executor y persiste el nuevo estado
    (incluido `notified` según el resultado del envío).
  - En Windows/dev: los chequeos que dependen de Linux fallan controladamente y
    se omiten (el módulo no revienta).
- `backend/routes/notifications.js` — router `/api/notifications` (JWT):
  - `GET /config` — config actual (sin secretos: solo flags de "configurado").
  - `POST /config` — guarda config (valida con los helpers puros; cifra secretos).
  - `POST /test/telegram` y `POST /test/email` — envío de prueba con la config
    recibida (sin persistir si falla, patrón backups-remoto).
  - `POST /telegram/detect-chat` — autodetección del chat_id.
- Hooks puntuales en `backend/routes/auth.js`: bloqueo por fuerza bruta y login
  desde IP nueva llaman a `dispatch()` (fire-and-forget, sin bloquear el login).

## Modelo de datos

- `notify_config` (fila única):
  - `telegram_enabled`, `telegram_token` (cifrado), `telegram_chat_id`
  - `smtp_enabled`, `smtp_host`, `smtp_port`, `smtp_secure`, `smtp_user`,
    `smtp_pass` (cifrado), `smtp_from`, `smtp_to`
  - `ev_disk_enabled`, `ev_disk_threshold` (default 90),
    `ev_services_enabled`, `ev_security_enabled`
  - `updated_at`
- `notify_state` (una fila por recurso):
  - `key` (PK: `disk`, `service:nginx`, `container:txpl-mail`…)
  - `status` (`ok` | `down`), `pending_status`, `pending_count`
  - `since`, `notified` (0/1), `updated_at`
- Migración: `CREATE TABLE IF NOT EXISTS` en `database.js` (patrón existente).

## Manejo de errores

- Envío fallido en **todos** los canales → `notified=0`; el siguiente tick
  re-emite el evento (no se pierde el aviso). Si al menos un canal entrega,
  `notified=1`.
- Errores de envío a `console.error` **sin token ni contraseña** (redactados).
- `POST /config` valida antes de cifrar/persistir; los endpoints `/test` operan
  sobre la config del body para probar antes de guardar.
- Timeouts: `fetch` a Telegram con `AbortSignal.timeout(10_000)`; nodemailer con
  `connectionTimeout` acotado. El tick nunca queda colgado (guard + timeouts).
- El monitor arranca aunque la config no exista; simplemente no hace nada hasta
  que el operador configure.

## UI (tarjeta "Notificaciones" en Ajustes)

- Bloque **Telegram**: token + botón "Detectar chat" (instrucciones: crea el bot
  con @BotFather, pulsa /start, dale a Detectar) + "Enviar prueba" + toggle.
- Bloque **Email (SMTP)**: host/puerto/TLS/usuario/contraseña/de/para +
  "Enviar prueba" + toggle.
- Bloque **Eventos**: disco (toggle + umbral %), servicios/contenedores (toggle),
  seguridad (toggle).
- Aviso honesto visible sobre la caída total del VPS y el monitor externo.
- Español, mismo estilo de tarjetas que el resto de Ajustes.

## Testing (`backend/test/notifications.test.js`, node:test)

Sobre los helpers puros:
- `applyTick`: ok→down exige 2 ticks; down→ok emite `recovered`; flapping
  (ok→down→ok en ticks alternos) no emite nada; `notified=false` re-emite;
  primer tick de un recurso nuevo no emite.
- Constructores de payload: texto Telegram con emoji/hostname/hora; subject y
  body de email; escapado de contenido.
- Validadores: formato de token, chat_id numérico, config SMTP completa/incompleta.
- `RESOURCE_KEYS`: claves estables por tipo de recurso.

Executor, monitor y rutas no se unit-testean (efectos), como el resto del
proyecto.

## Riesgos conocidos

- `getUpdates` no devuelve nada si el operador no ha pulsado /start o si el bot
  tiene un webhook configurado — la UI debe explicar el paso previo y el error.
- SMTP de Gmail requiere "contraseña de aplicación" — nota en la UI.
- Si el operador cambia el hostname del VPS, los mensajes cambian de prefijo
  (cosmético).
