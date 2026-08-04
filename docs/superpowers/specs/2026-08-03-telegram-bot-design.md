# Bot de Telegram bidireccional — controlar el VPS por comandos

**Fecha:** 2026-08-03
**Rama:** `feat/telegram-bot`
**Alcance:** backend solo (`backend/lib/notifications/`, `backend/routes/notifications.js`, `backend/db/schema/…`). Cero cambios de frontend salvo un input nuevo en Ajustes → Notificaciones para la allowlist de admins.

## Motivación

`notify_config` ya guarda un `telegram_token` + `telegram_chat_id` cifrados que hoy solo se usan para *enviar* alertas (disco, servicios caídos, SSL expirando). El mismo bot puede recibir comandos por `getUpdates` (long-polling) — sin abrir puertos, sin webhook público, sin dependencias nuevas — y ejecutar consultas contra los helpers que ya existen. Esto añade "control remoto seguro desde el móvil" sin construir una API nueva ni un cliente móvil.

## Motor

**Long-polling `getUpdates`.** Alternativas descartadas:

- **Webhook** → requiere URL pública HTTPS estable, expone el panel a POSTs de terceros, y ya sabemos por el módulo de mail que abrir puertos hacia el exterior en un panel autoinstalado es una fuente de bugs. Descartado.
- **MTProto / librería tipo `telegraf`** → dependencia nueva, más superficie de código para una feature que se resuelve con dos `fetch` a `api.telegram.org`. Ponytail.

Un solo `setInterval` no vale (se solapan peticiones si el long-poll pendiente tarda más que el intervalo). Se usa un **bucle recursivo**: cada `getUpdates` con `timeout=30` (long-poll HTTP) → al resolver, procesa los mensajes → programa el siguiente. Si falla la petición (red, token revocado), backoff exponencial 5 s → 60 s hasta que vuelva a funcionar.

## Decisiones clave

### Seguridad (obligatorio antes de exponer verbo alguno)

- **Allowlist estricta por `from.id`.** Nueva columna `telegram_admin_ids TEXT` en `notify_config` (JSON array de números). Cualquier mensaje cuyo `from.id` no esté en la lista se **ignora en silencio** (no responder ni siquiera "no autorizado" — no darle al atacante confirmación de que el bot existe). Si la lista está vacía, el bot no acepta ningún comando (solo envía alertas como hoy).
- **Autoprovisión del admin.** Como el usuario del panel puede no conocer su `user_id` de Telegram, el primer mensaje `/start` recibido cuando la lista está vacía muestra en el panel (mediante `audit_log` + una notificación toast al recargar Ajustes) el `from.id` para que el operador lo pegue en el campo. Nunca se auto-agrega sin acción del operador.
- **Sin `/exec` genérico.** Solo verbos concretos con validación por argumento (nombre de app contra `queries.listApps`, servicio contra whitelist `['nginx','mysql','postgresql','redis','ssh']`, etc.). Los mismos validadores que ya usa la API REST.
- **Auditoría.** Cada comando aceptado se registra en `audit_log` con `user = 'telegram:<from.id>'`, `ip = 'telegram'`, `action = 'bot.<comando>'`, `detail = args`. Idéntico patrón al resto del panel.
- **Rate limit.** Por `from.id`, máximo 30 comandos/minuto en memoria (map con timestamps). Excedido → respuesta "espera un momento" y descarte. Evita bucles accidentales del propio operador y frena a un admin comprometido.

### Comandos v1

Solo lectura + un puñado de acciones idempotentes/reversibles. Nada destructivo (no `/delete`, no `/drop`, no `/rm`).

| Comando | Acción |
|---|---|
| `/start` | Alta del admin (si allowlist vacía) o saludo con lista de comandos. |
| `/help` | Lista de comandos disponibles. |
| `/status` | CPU, RAM, disco, uptime, hostname (una línea cada uno). |
| `/services` | Estado de nginx, mysql, postgresql, redis, ssh. |
| `/errors [N]` | Últimas N líneas (default 20, máx 50) del feed unificado de errores (mismo backend que la pestaña "Errores"). |
| `/apps` | Lista de apps PM2 con estado. |
| `/restart <app>` | Reinicia una app PM2 concreta. Verbo idempotente, reversible. |
| `/ssl` | Certificados con días restantes, marcados los que caducan en <30 días. |
| `/backups [N]` | Últimos N backups (default 10) con tamaño y fecha. |

Explícitamente fuera de v1:
- Crear/borrar recursos, subir ficheros, ejecutar SQL, reiniciar el propio panel, tocar firewall, renovar/emitir SSL. Se pueden añadir en v2 tras validar el modelo de seguridad en producción.

### Reutilización de helpers

Cada comando llama a **helpers puros ya existentes**, no a los handlers HTTP (que dependen de `req`/`res` y del middleware JWT). Los helpers viven en `lib/`:

- `/status` → `systeminformation` (mismo que `routes/system.js`).
- `/services` → whitelist + `systemctl is-active <name>` via `runSafe`.
- `/errors` → nueva función `readErrorFeed(lines)` extraída de `routes/logs.js /errors` a `lib/logs.js`.
- `/apps`, `/restart` → `queries.listApps` + `pm2` via `runSafe`.
- `/ssl` → `parseCertbotCertificates(await runSafe('certbot', ['certificates']))` + `certCategory` de `lib/ssl`.
- `/backups` → `queries.listBackups` + tamaño desde `fs.stat`.

Solo el router de comandos y el poller son código nuevo. Los verbos que hoy no tienen helper puro (por ejemplo la lectura de errores) se extraen en la misma tarea que los usa.

### Ciclo de vida del bot

- El bot arranca en `server.js` **solo si** `queries.getNotifyConfig()` devuelve `telegram_enabled = 1 && telegram_token && telegram_admin_ids != '[]'`. Sin admins, no polea (ahorra la petición constante).
- Al guardar `notify_config` desde el panel, si `telegram_enabled` cambió → `bot.stop()` + `bot.start()` para tomar el nuevo token/allowlist sin reiniciar el proceso.
- Al parar el proceso (SIGTERM de PM2), `bot.stop()` cancela el `AbortController` del `fetch` pendiente para que PM2 no espere 30 s.

### Formato de respuestas

Mensajes cortos en texto plano (sin Markdown ni HTML, para no lidiar con escapado de caracteres especiales de Telegram y no perder texto por parseo). Ejemplo `/status`:

```
CPU: 12% · RAM: 1.2G/4G (30%)
Disco /: 18G/40G (45%)
Uptime: 5d 2h · Host: vps01
```

## Aviso honesto al usuario

- **Telegram no es un canal auditado.** Un token filtrado + un `from.id` correcto = control total del subset de comandos v1. Rotar el token en Ajustes anula al atacante en el próximo `getUpdates`. La allowlist mitiga suplantación pero no protege ante robo del propio dispositivo del admin.
- **Long-polling consume una petición cada 30 s.** ~3.000 peticiones/día. api.telegram.org lo tolera de sobra pero conviene saberlo.
- **No hay confirmación en dos pasos.** `/restart nginx` reinicia sin `/confirm`. Es aceptable en v1 porque los verbos son idempotentes/reversibles; si en v2 se añade `/delete <site>` habrá que meter confirmación de doble paso obligatoria.
