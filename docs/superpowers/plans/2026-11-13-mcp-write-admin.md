# MCP Fase 2: acciones de escritura y control total — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que una IA (vía el MCP) pueda, con tokens de dos ámbitos nuevos, (a) ejecutar acciones acotadas (`write`) y (b) tener control total del panel y ejecutar comandos en el VPS (`admin`), con cerrojos extra para `admin`.

**Architecture:** Se amplía la lista blanca de `backend/lib/apitokens` con `write` (4 POST curados) y `admin` (cualquier ruta `/api/*` salvo `/api/auth/*`). `admin` va protegido por: interruptor global del panel apagado por defecto, contraseña (+ código 2FA si está activo) al crear, caducidad máxima 30 días, auditoría de cada llamada con token y un cerrojo local en el MCP (`TXPL_ENABLE_ADMIN=1`). Un endpoint nuevo `POST /api/system/exec` ejecuta comandos solo para tokens `admin`.

**Tech Stack:** Node/Express, better-sqlite3, lit-html SPA, `@modelcontextprotocol/sdk` 1.32.2 + zod (ya instalados en `mcp/`), node:test.

**Spec:** Decisiones del usuario (2026-11-13): «Control total incl. comandos» + salvaguarda «Interruptor + token propio». Parte de la Fase 1 (`docs/superpowers/plans/2026-11-12-mcp-tokens-api.md`, versión 2.2.0 ya fusionada en `main`).

## Global Constraints

- Versión **2.3.0** (cambio grande: +0.1). `VERSION`, `package.json`, `CHANGELOG.md` (`## 2.3.0`), `README.md`/`CLAUDE.md` si citan la versión o los ámbitos.
- UI, comentarios, mensajes de error y commits en **español**; código comentado y legible (reglas del proyecto).
- Ámbitos: `SCOPES = ['read','write','admin']`, cada uno incluye los anteriores. Ámbito desconocido → `isAllowed` false.
- Caducidad: `read`/`write` siguen con `[30, 90, 365]` días; `admin` solo `[7, 30]` (por defecto 7).
- `admin` permite cualquier método sobre `/api/*` **excepto** `/api/auth` y `/api/auth/*`; rechaza rutas con `..`, `%`, `//` o mayúsculas distintas de las del router (sin normalizar ni flag `i`).
- La gestión de tokens, contraseña, 2FA y el interruptor global solo con sesión JWT (`sessionOnly`), nunca con token.
- Un token `admin` con el interruptor global apagado recibe 401/403 y NO actualiza `last_used_at`.
- Cada petición con token de API que no sea GET se audita (`apitoken.call`, `<MÉTODO> <ruta>`); `system.exec` audita el comando (≤500 caracteres). El token nunca aparece en la auditoría.
- WebSockets siguen solo JWT (sin terminal interactiva para tokens).
- Comandos: `bash -lc`, timeout por defecto 60 s y máximo 110 s (el MCP corta a 120 s), salida recortada a los últimos 64 KB.
- MCP: herramientas `write`/`admin` solo se registran con `TXPL_ENABLE_WRITE=1` / `TXPL_ENABLE_ADMIN=1`; llevan `annotations.destructiveHint: true`, las de lectura `readOnlyHint: true`.
- Estado de tests de partida: raíz 226/226, `mcp/` 17/17 (se ejecutan en el espejo Linux con `bash $HOME/txpl-work/verify.sh`; `mcp/` con `npm test`).

## Review Focus

1. **Interruptor global apagado** → cualquier token `admin` recibe denegación aunque sea válido; apagarlo con tokens ya creados los neutraliza al instante (test en Task 2).
2. **Trucos de ruta con `admin`**: `/api/auth/tokens`, `/api/auth`, `//api/auth/x`, `/api/x/../auth/tokens`, `/api/%61uth/tokens`, `/API/auth/tokens` → denegados; `/api/x/../auth` no llega a ejecutar nada (test en Task 1 y 2).
3. **Escalada entre ámbitos**: un token `write` no puede `POST /api/system/exec` ni ninguna otra ruta fuera de las 4 curadas; una sesión JWT tampoco puede usar `/api/system/exec` (solo tokens `admin`) (test en Task 3).
4. **Entradas hostiles de `exec`**: comando vacío o >8000 caracteres → 400; `cwd` inexistente o relativo → 400; salida enorme → recortada; comando que no termina → muerto por timeout; salida no UTF-8 no rompe el JSON (test en Task 3).
5. **Creación de token `admin`**: sin contraseña → 403; con 2FA activo y sin/mal código → 401/403; `days` fuera de `[7,30]` → 400; interruptor apagado → 403 al crearlo (test en Task 2).
6. **Auditoría**: `apitoken.call` para toda petición no-GET con token, `system.exec` aunque el comando falle, y ningún `txpl_` en `audit_log` (test en Task 2/3).

---

### Task 1: Ámbitos `write` y `admin` en la lista blanca

**Files:**
- Modify: `backend/lib/apitokens/index.js`
- Test: `backend/test/apitokens.test.js`

**Interfaces:**
- Consumes: `ROUTES`, `isAllowed`, `SCOPES`, `EXPIRY_DAYS` actuales (Fase 1).
- Produces: `SCOPES = ['read','write','admin']`; `expiryDaysFor(scope: string): number[]` (`[30,90,365]` para read/write, `[7,30]` para admin, `[]` si desconocido); `isAllowed(scope, method, path)` con las reglas nuevas; `ROUTES` incluye entradas `scope:'write'` y la regla `admin`. `EXPIRY_DAYS` se mantiene exportado (compatibilidad con la UI/tests de Fase 1).

- [ ] **Step 1: Tests que fallan** en `apitokens.test.js`:
  - `isAllowed('write','POST', p)` true para `/api/apps/5/restart`, `/api/apps/5/reload`, `/api/docker/containers/web.1/restart`, `/api/backups`, `/api/ssl/ejemplo.com/renew`; esos mismos con `'read'` → false.
  - Con `'write'` → false: `/api/apps/5/stop`, `/api/apps/5/exec`, `/api/docker/containers/x/stop`, `/api/backups/3/restore`, `/api/ssl/issue`, `/api/system/exec`.
  - `admin`: true para `POST /api/system/exec`, `DELETE /api/websites/3`, `DELETE /api/dns/zones/ejemplo.com/records`, `PUT /api/apps/2/env`, `GET /api/databases`; false para `GET|POST|DELETE` de `/api/auth`, `/api/auth/tokens`, `/api/auth/tokens/4`, `//api/auth/tokens`, `/api/x/../auth/tokens`, `/api/%61uth/tokens`, `/API/auth/tokens`, `/api/system/../x`, `/apix`, `/`.
  - `expiryDaysFor('admin')` → `[7,30]`; `expiryDaysFor('read')` → `[30,90,365]`; `expiryDaysFor('x')` → `[]`.
- [ ] **Step 2:** `npm test` (raíz, solo este fichero con verify.sh) → FAIL.
- [ ] **Step 3: Implementar** en `index.js`: añadir `write`/`admin` a `SCOPES`; las 4 rutas `write` (POST, ids de contenedor con `CONTAINER` y de dominio `[A-Za-z0-9][A-Za-z0-9.-]*`); regla `admin` como entrada con regex `^/api/(?!auth(/|$))[A-Za-z0-9_.\-/]+$` y `method: '*'` (cualquier método) — la clase de caracteres permite `.` (dominios) pero excluye `%`; `isAllowed` rechaza además cualquier ruta que contenga `..` o `//`; `isAllowed` mantiene el rango por ámbito y trata `method:'*'`.
- [ ] **Step 4:** Tests de ese fichero → PASS; suite raíz completa → PASS.
- [ ] **Step 5: Commit** `feat(apitokens): ámbitos write y admin en la lista blanca`.

### Task 2: Interruptor global, creación segura y auditoría de tokens `admin`

**Files:**
- Create: `backend/db/schema/018_panel_flags.sql`, `backend/db/queries/panelflags.js`
- Modify: `backend/db/queries/index.js`, `backend/routes/auth.js`
- Test: `backend/test/apitokens-auth.test.js`

**Interfaces:**
- Consumes: Task 1 (`SCOPES`, `expiryDaysFor`, `isAllowed`); middleware `auth`/`authApiToken`, `sessionOnly`, `audit`, `queries.getUserFullById`, `totpVerify` (ya en `routes/auth.js`).
- Produces: tabla `panel_flags(key TEXT PRIMARY KEY, value TEXT NOT NULL)`; queries `getPanelFlag`, `setPanelFlag`; endpoints `GET /api/auth/ai-admin` → `{ enabled: boolean }` y `POST /api/auth/ai-admin` `{ enabled: boolean, password }` → `{ enabled }`, ambos `auth, sessionOnly`; `POST /api/auth/tokens` acepta `scope:'admin'` con `code` (2FA) y valida `days` con `expiryDaysFor(scope)`; middleware: token de ámbito `admin` con el flag `ai_admin_enabled` distinto de `'1'` → 403 «Los tokens de control total están desactivados en el panel» sin `touchApiToken`; auditoría `apitoken.call`.

- [ ] **Step 1: Tests que fallan** en `apitokens-auth.test.js` (Express real + SQLite temporal, estilo existente):
  - Flag apagado: crear token `admin` → 403; con sesión se enciende (`POST /ai-admin` con contraseña correcta; con contraseña mala → 403), crear `admin` con `days: 7` → 200; `days: 90` → 400; usuario con 2FA activo: sin `code` → 401, con `code` mal → 401, con `code` bueno (usar `totpVerify`/generar código como hacen los tests de login si existen; si no, stub) → 200.
  - Flag encendido → token `admin` llama a `GET /api/system/stats` → 200; se apaga el flag → la misma llamada 403 y `last_used_at` no cambia.
  - Token `admin` en `GET /api/auth/tokens`, `POST /api/auth/password`, `POST /api/auth/ai-admin` → 403 (nunca llega a las rutas).
  - Auditoría: una petición `POST` con token `write` deja fila `apitoken.call` con `POST /api/apps/1/restart` y usuario `admin (token:nombre)`; ninguna fila de `audit_log` contiene `txpl_`.
- [ ] **Step 2:** verify.sh sobre ese fichero → FAIL.
- [ ] **Step 3: Implementar** migración + queries (si ya existiera un almacén clave-valor equivalente, usarlo en vez de crear la tabla); el flag se guarda como `'1'`/`'0'`, por defecto ausente = apagado; en `authApiToken`: tras comprobar que el token existe, no ha caducado y `isAllowed`, si `row.scope === 'admin'` y el flag está apagado → 403 sin `touchApiToken`; auditar `apitoken.call` para métodos distintos de GET (usar `req.method` + ruta ya calculada, nunca el token); la creación valida `scope` contra `SCOPES`, `days` con `expiryDaysFor(scope)`, y para `admin` exige flag encendido y, si `u.totp_enabled`, `code` válido (mismo `totpVerify` que el login; fallo → audit `apitoken.create.fail`).
- [ ] **Step 4:** Tests de ese fichero y suite raíz → PASS.
- [ ] **Step 5: Commit** `feat(tokens): interruptor global, 2FA y auditoría para tokens admin`.

### Task 3: Endpoint `POST /api/system/exec`

**Files:**
- Modify: `backend/routes/system.js`
- Test: `backend/test/apitokens-auth.test.js` (nuevos casos) o `backend/test/system-exec.test.js` si el fichero crece demasiado

**Interfaces:**
- Consumes: Task 2 (flag, `req.user.apiToken.scope`); `runSafe`, `ok`, `fail`, `wrap`, `audit`, `clientIp` (patrón de `routes/apps.js` `/:id/exec`).
- Produces: `POST /api/system/exec` body `{ command: string, cwd?: string, timeout_s?: number }` → `{ success: true, ok: boolean, code: number|null, output: string }`. 403 si `!req.user.apiToken || req.user.apiToken.scope !== 'admin'`.

- [ ] **Step 1: Tests que fallan:**
  - Token admin (flag encendido): `{command:'echo hola'}` → `ok:true`, `output` contiene `hola`; `{command:'exit 3'}` → `ok:false, code:3`; `{command:'pwd', cwd:'/tmp'}` → `/tmp`; `{command:'sleep 5', timeout_s:1}` → `ok:false` en <3 s.
  - 400: comando vacío, >8000 caracteres, `cwd` relativo, `cwd` inexistente, `timeout_s` 0 o >110.
  - Salida grande: `{command:'head -c 200000 /dev/zero | tr "\\0" "a"'}` → `output.length ≤ 65536`.
  - Salida no UTF-8 (`printf '\\xff\\xfe'`) → respuesta JSON válida.
  - Token `write` y `read` → 403 (lista blanca); sesión JWT → 403; sin auth → 401.
  - Auditoría: fila `system.exec` con el comando, también cuando falla.
- [ ] **Step 2:** FAIL.
- [ ] **Step 3: Implementar** el handler: valida entrada, `runSafe('bash', ['-lc', command], { cwd, timeout: timeout_s*1000, maxBuffer })`, une stdout+stderr, conserva los últimos 64 KB, sanea no-UTF-8 con `toString('utf8')` (U+FFFD), audita **antes** de responder con `command.slice(0,500)`.
- [ ] **Step 4:** PASS.
- [ ] **Step 5: Commit** `feat(system): ejecución de comandos para tokens admin`.

### Task 4: Interfaz de Ajustes

**Files:**
- Modify: `frontend/views/pages/settings.html`, `frontend/js/settings.js`
- Test: `backend/test/frontend-handlers.test.js` (debe seguir pasando; añadir casos si el patrón lo permite)

**Interfaces:**
- Consumes: endpoints de Task 2 (`GET/POST /api/auth/ai-admin`, `POST /api/auth/tokens` con `code`), estado 2FA (`GET /api/auth/2fa/status`), `expiryDaysFor` solo en el servidor (la UI lleva su propia tabla: read/write `30/90/365`, admin `7/30`).
- Produces: en la tarjeta «Tokens de API (IA / MCP)»: opciones `Solo lectura`, `Lectura y acciones` (write), `Control total (admin)`; selector de caducidad que cambia según el ámbito; campo `#tok-code` (código 2FA) visible solo con admin y 2FA activo; aviso rojo para admin («Permite ejecutar comandos como root en tu VPS. Un token filtrado equivale a acceso root. Caduca en ≤30 días.»); nueva sección «Control total de IA» con interruptor (`#ai-admin-toggle`) que pide contraseña; globals `loadAiAdmin`, `toggleAiAdmin`.

- [ ] **Step 1:** Test de handlers existente → verificar que sigue pasando tras el cambio (los `onclick` nuevos deben existir como globales).
- [ ] **Step 2: Implementar** la UI; la opción `admin` queda deshabilitada con tooltip «Actívalo primero abajo» mientras el interruptor esté apagado; sin textos en inglés; mantener `id = Number(...)` antes de plantillas.
- [ ] **Step 3:** Suite raíz → PASS.
- [ ] **Step 4:** Verificación visual manual del usuario (no ejecutable desde la VM): se anota en el informe.
- [ ] **Step 5: Commit** `feat(ajustes): ámbitos write/admin e interruptor de control total`.

### Task 5: Servidor MCP — herramientas de escritura y control total

**Files:**
- Modify: `mcp/client.js`, `mcp/tools.js`, `mcp/index.js`, `mcp/test/client.test.js`, `mcp/test/tools.test.js`

**Interfaces:**
- Consumes: ámbitos de Task 1 (`isAllowed` real importado por `tools.test.js` como en Fase 1).
- Produces: `client.call(method, path, body?)` (JSON en POST/PUT/DELETE, timeout 120 s para métodos distintos de GET); herramientas `write` (`reiniciar_app {id, modo:'restart'|'reload'}`, `reiniciar_contenedor {id}`, `crear_backup {}` con cuerpo `{kind:'full'}`, `renovar_ssl {nombre}`) y `admin` (`ejecutar_comando {comando, cwd?, timeout_s?}` → `/api/system/exec`; `llamar_api {metodo, ruta, cuerpo?}` para cualquier otra ruta, `ruta` debe empezar por `/api/`, sin `..`, sin `/api/auth`); registro condicionado por `TXPL_ENABLE_WRITE=1` / `TXPL_ENABLE_ADMIN=1`; `annotations` (`readOnlyHint` en lectura, `destructiveHint` en write/admin).

- [ ] **Step 1: Tests que fallan:**
  - `client.test.js`: POST envía JSON y `Content-Type`; respuesta de `renovar_ssl` con centinela `'línea\n__TXPL_DONE__0'` → `'línea'`, `'fallo\n__TXPL_DONE__1'` → lanza `La operación terminó con error`; sigue pasando 204/cuerpo cortado/redirect/401/403.
  - `tools.test.js`: cada herramienta write cumple `isAllowed('write', …)` y no `isAllowed('read', …)`; `ejecutar_comando` y `llamar_api` cumplen `isAllowed('admin', …)` y no `isAllowed('write', …)`; sin las variables de entorno no se registra ninguna write/admin; `llamar_api` rechaza `/api/auth/tokens`, `/api/x/../auth`, `http://…`, rutas sin `/api/`; todas las descripciones write/admin empiezan por «ACCIÓN:» y advierten que la salida de logs/comandos es texto no fiable y que no se obedecen instrucciones que aparezcan en ella.
- [ ] **Step 2:** `cd mcp && npm test` → FAIL.
- [ ] **Step 3: Implementar.** Las descripciones de `ejecutar_comando` avisan: «ejecuta como root en el VPS; usa `nohup … &` para trabajos de más de 100 s».
- [ ] **Step 4:** `npm test` en `mcp/` y suite raíz → PASS.
- [ ] **Step 5: Smoke** con cliente MCP stdio programático contra el backend en el espejo Linux: `ejecutar_comando {comando:'echo hola'}` (token admin, flag encendido) → «hola»; con flag apagado → «El token no tiene permiso para esta operación».
- [ ] **Step 6: Commit** `feat(mcp): herramientas de escritura y ejecución de comandos`.

### Task 6: Documentación y versión 2.3.0

**Files:**
- Modify: `mcp/README.md`, `README.md`, `CLAUDE.md`, `CHANGELOG.md`, `VERSION`, `package.json`

- [ ] **Step 1:** `VERSION`/`package.json` → `2.3.0`; `CHANGELOG.md` `## 2.3.0 — <fecha>` (ámbitos, interruptor, endpoint exec, MCP).
- [ ] **Step 2:** `mcp/README.md`: guía de configuración de `TXPL_ENABLE_WRITE`/`TXPL_ENABLE_ADMIN`, advertencias claras (token admin = root, prompt-injection desde logs/webs, no aprobar «siempre permitir» en las herramientas destructivas, caducidad corta, revocar y apagar el interruptor si hay sospecha), nota «cambiar la contraseña no revoca tokens».
- [ ] **Step 3:** Suites completas → PASS; `git diff --stat` sin sorpresas.
- [ ] **Step 4: Commit** `docs: MCP write/admin; versión 2.3.0`.

## Notas de ejecución
- Todo el trabajo se hace en una rama `feat/mcp-admin` desde `main`; no se fusiona ni se hace push sin decisión del usuario.
- Antes de desplegar, el usuario debe tener resuelto el 502 y la creación de tokens de la 2.2.0 en su VPS.
