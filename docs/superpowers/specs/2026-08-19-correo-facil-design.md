# Correo fácil — diseño (2026-08-19)

## Objetivo
Que una persona que **nunca ha gestionado email** pueda montar correo funcional en su
VPS desde TecXPaneL sin conocer MX, SPF, DKIM, DMARC, PTR ni "puerto 25". El panel
guía, diagnostica y automatiza; la jerga queda detrás de "¿qué es esto?".

## Verdad de partida (avisos honestos)
Auto-hospedar email es difícil hasta para expertos. La UI reduce el dolor, no lo elimina:
- Si el proveedor **bloquea el puerto 25 saliente**, el envío directo NO funciona → hay
  que usar un **relay SMTP** (Fase 4). Es el muro nº1 en VPS baratos.
- El **PTR / DNS inverso** se configura en el panel del proveedor de VPS; el panel solo
  puede **detectarlo y guiar**, no ponerlo.
- La **reputación de IP** (listas negras) no se arregla al instante.

## Principios de diseño
1. Un solo flujo lineal (asistente), no tarjetas sueltas.
2. Cero jerga por defecto; explicaciones en llano, jerga en tooltips.
3. Automatizar todo lo automatizable (hostname = `mail.<dominio>`, DKIM auto, TLS auto).
4. Diagnosticar y decir **exactamente qué hacer**, en su idioma.
5. Estado único y honesto: "¿Funciona tu correo? ✅/⚠️/❌" con checklist accionable.

## Alcance (las 4 fases, todas aprobadas)
- **F1 Asistente + estado**: flujo por pasos + checklist con semáforos y botones "Arreglar".
- **F2 Diagnóstico (preflight)**: puerto 25 saliente, A resuelve a la IP, PTR, presencia
  de MX/SPF/DKIM/DMARC, IP en DNSBL. Cada check verde/ámbar/rojo + "cómo arreglarlo".
- **F3 Registros DNS "copiar y pegar"**: genera todos los registros ya rellenados
  (A, MX, SPF, DKIM, DMARC + `autoconfig`/`autodiscover`) con botón "copiar todo".
- **F4 Relay SMTP (smarthost)**: enviar vía Brevo/SendGrid/Mailgun/SES/Gmail
  (`RELAY_HOST/PORT/USER/PASSWORD` de docker-mailserver). Desbloquea el envío con 25 bloqueado.
- **F5 Prueba + puntuación**: botón "enviar correo de prueba" + integración opcional
  con mail-tester.com (puntuación /10 y qué falla).
- (**F6 Modo experto**: lo avanzado detrás de "Opciones avanzadas" — transversal.)

## Orden de construcción recomendado
**F2 (diagnóstico) → F1 (asistente/estado) → F4 (relay) → F3 (DNS auto) → F5 (prueba).**
Razonamiento: el **motor de diagnóstico es la piedra angular** — el asistente, la checklist
de estado, la Fase 5 (puntuación) y los avisos de "necesitas relay" (F4) consumen sus
resultados. Se construye primero, aislado y testeable, y todo lo demás se cuelga de él.

## Diseño técnico

### Arquitectura (patrón de 3 capas del repo)
- `backend/lib/mail/diagnose.js` — helpers PUROS: parseo de resultados de sonda, mapeo
  a estado (ok/warn/error) + mensaje llano + acción. **Testeable sin red ni Docker.**
- `backend/routes/mail.js` — endpoints que ejecutan las sondas (efectos: DNS, TCP, exec)
  y delegan el veredicto a `diagnose.js`.
- `frontend/js/mail.js` + `views/pages/mail.html` — asistente y checklist.

### F2 — Diagnóstico
Nuevo `GET /api/mail/diagnose` → `{ checks: [{ id, level, title, detail, fix }] }`.
Sondas (cada una best-effort, con timeout, nunca tira el endpoint):
- **port25_out**: TCP connect saliente a un MX conocido (p. ej. `gmail-smtp-in.l.google.com:25`)
  con `net.connect` + timeout 5 s. Fallo → level=error, fix="tu proveedor bloquea el 25; usa un relay (Fase 4)".
- **dns_a**: resolver A del hostname (`dns.promises.resolve4`) y comparar con la IP del VPS.
- **ptr**: `dns.promises.reverse(ip)` y comprobar que coincide con el hostname.
- **mx / spf / dkim / dmarc**: `resolveMx` / `resolveTxt` del dominio y del selector DKIM.
- **dnsbl**: consultar 2-3 listas (p. ej. `zen.spamhaus.org`, `bl.spamcop.net`) via
  `resolve4` de `<ip-invertida>.<lista>` (NXDOMAIN = limpio).
Todo con `dns.promises` (stdlib) y `net` (stdlib) — sin dependencias nuevas.

### F1 — Asistente + estado
- `mail.html`: contenedor de asistente por pasos (Dominio → Comprobaciones → Registros →
  Instalar → Buzón → Probar) + tarjeta "Estado" que pinta la checklist de `/diagnose` con
  semáforos y botón "Arreglar" (scroll/expand al paso relevante).
- Reutiliza `mailFeedback`/`mailSetBusy`/barra de progreso ya existentes.

### F4 — Relay SMTP
- Tabla nueva `mail_relay` (fila única, secretos cifrados con `encryptSecret`): host, port,
  user, pass_enc, enabled.
- `POST /api/mail/relay` (guarda + recrea contenedor con `RELAY_HOST/RELAY_PORT` y el
  fichero `postfix-sasl-password.cf` vía `setup relay` de docker-mailserver o envs).
- `buildMailContainerConfig` acepta `relay` y añade los envs `RELAY_*`.
- UI: "¿No puedes enviar? Configura un relay" con presets (Brevo/SendGrid/Mailgun/SES/Gmail)
  que rellenan host/puerto; el usuario solo pega usuario/clave (contraseña → nunca en argv,
  cifrada en BD).

### F3 — Registros DNS copiar/pegar
- `GET /api/mail/dns-records` (ya existe algo parecido: `buildDnsRecords`/`mailRecordsToRrsets`
  en `lib/mail/dns.js`) → ampliar para incluir A del hostname, `autoconfig`/`autodiscover`
  y DMARC por defecto. Frontend: tabla con "copiar todo".

### F5 — Prueba + puntuación
- `POST /api/mail/test-send` → envía un correo de prueba a una dirección dada (vía el propio
  contenedor, `swaks`/`sendmail`), reporta éxito/fallo.
- Integración mail-tester opcional: el usuario pega la dirección `test-xxxx@mail-tester.com`,
  el panel envía y le da el enlace al informe (no scrapeamos la puntuación en v1).

## Fuera de alcance (v1)
- Integración con APIs de registradores para crear DNS automáticamente (salvo el módulo DNS
  propio del panel, hoy desactivado).
- Antispam/antivirus avanzado, cuotas, listas de distribución.
- Scraping de la puntuación de mail-tester (solo enlace).

## Tareas (TDD, bite-sized) — se detallan en el plan
1. `lib/mail/diagnose.js` (helpers puros + tests) — clasificación de cada sonda.
2. Sondas + `GET /diagnose` en `routes/mail.js`.
3. Checklist de estado en el frontend (consume `/diagnose`).
4. Asistente por pasos (reorganiza `loadMail`).
5. Relay: tabla + endpoint + envs + UI con presets.
6. Registros DNS copiar/pegar (amplía `lib/mail/dns.js`).
7. Prueba de envío + enlace mail-tester.
8. Docs (README + CLAUDE.md) y revisión de rama.
