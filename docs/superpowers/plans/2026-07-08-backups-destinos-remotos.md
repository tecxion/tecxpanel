# Backups — Destinos remotos (S3/SFTP) — Plan de Implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Añadir destinos remotos (S3-compatible y SFTP) a los backups del panel, con cifrado opcional por passphrase del usuario, subida automática tras cada backup, listado/restore desde remoto y retención remota — todo vía `rclone` (un binario) invocado con `execFile` y credenciales pasadas por variables de entorno del proceso hijo.

**Architecture:** Dos capas nuevas siguiendo el patrón n8n/mail/dns: helpers puros y testeables (`lib/rclone.js`) y un ejecutor de efectos (`lib/backupRemote.js`) que corre `rclone` con la config inyectada por env-vars. La fila única `backup_remote` (patrón n8n_config) guarda credenciales y passphrase cifradas con AES-256-GCM; el motor de backup (Fase 1) se reutiliza intacto para crear y restaurar.

**Tech Stack:** Node.js, Express, better-sqlite3, `rclone` (binario del sistema), `execFile`/`spawn`, `encryptSecret`/`decryptSecret` (AES-256-GCM), `node:test`, frontend vanilla JS.

## Global Constraints

- **Idioma ESPAÑOL** en UI, comentarios, mensajes de error de API y commits.
- **Motor único `rclone`** (S3-compatible + SFTP); NO SDKs npm ni aws-cli.
- **Config de rclone por env-vars del proceso hijo** (`RCLONE_CONFIG_TXPL_*`, `RCLONE_CONFIG_TXPLCRYPT_*`), NUNCA por `rclone.conf` en disco ni por argv. Nombres de remoto internos fijos: `txpl` (storage) y `txplcrypt` (cifrado sobre `txpl:`).
- **Zero shell interpolation**: rclone se invoca con `execFile`/arrays; nunca cadenas para shell.
- **Credenciales y passphrase CIFRADAS en reposo** (AES-256-GCM, `encryptSecret`/`decryptSecret`); solo se descifran para inyectarlas en el env del proceso rclone.
- **Clave SSH** de SFTP (si se usa `keyContent`) se materializa en un fichero temporal con permisos `0600` y se borra en `finally`.
- **Fila única** de configuración: `CHECK (id = 1)` (patrón `n8n_config`/`dns_config`).
- **Retención remota independiente** de la local: solo caducan los `scheduled`.
- **Auditoría** (`audit`) en configurar/probar/subir/restaurar-desde-remoto/borrar-remoto.
- **Aviso honesto**: sin la passphrase, un backup remoto cifrado no se puede descifrar tras pérdida total del VPS.
- **Tests** con `node:test` + `assert`, sin dependencias externas.

---

## File Structure

- `backend/lib/rclone.js` — **Crear.** Helpers puros: constantes de nombres de remoto, construcción del env por tipo (S3/SFTP/crypt), `effectiveRemote`, constructores de args de `copy`/`lsjson`/`deletefile`/`lsd`, y parseo de `lsjson`.
- `backend/test/rclone.test.js` — **Crear.** Tests unitarios de `lib/rclone.js`.
- `backend/lib/backupRemote.js` — **Crear.** Ejecutor: `obscurePassword`, `uploadArchive`, `listRemote`, `downloadArchive`, `deleteRemote`, `testConnection`. Lee `backup_remote`, descifra secretos, monta el env, ejecuta `rclone` con `execFile`, gestiona fichero temporal de la clave SSH.
- `backend/routes/backups.js` — **Modificar.** Añadir 7 endpoints (`/remote`, `/remote/test`, `/:id/upload`, `/remote/list`, `/remote/:filename/restore`, `DELETE /remote/:filename`, `DELETE /remote`) e invocación de auto-subida tras `createBackup` cuando aplica.
- `backend/database.js` — **Modificar.** Tabla `backup_remote` + 3 queries.
- `backend/backup-runner.js` — **Modificar.** Tras la retención local, aplicar retención remota (best-effort).
- `backend/routes/plugins.js` — **Modificar.** Añadir `rclone` como plugin instalable (apt).
- `frontend/views/pages/backups.html` — **Modificar.** Añadir tarjeta "Destino remoto" y sub-tarjeta "Backups remotos".
- `frontend/js/app.js` — **Modificar.** Añadir `loadBackupRemote`, `backupRemoteSave`, `backupRemoteTest`, `backupUpload`, `loadRemoteBackups`, `backupRemoteRestore`, `backupRemoteDelete`.
- `README.md` y `CLAUDE.md` — **Modificar.** Documentar el módulo.

---

## Task 1: `lib/rclone.js` — constantes, env S3/SFTP y `effectiveRemote`

**Files:**
- Create: `backend/lib/rclone.js`
- Test: `backend/test/rclone.test.js`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `RCLONE_REMOTE = 'txpl'`, `RCLONE_CRYPT = 'txplcrypt'` (strings).
  - `buildS3Env({ endpoint, region, accessKey, secretKey }) → object` — env con las variables `RCLONE_CONFIG_TXPL_*` para un remoto S3-compatible.
  - `buildSftpEnv({ host, port, user, password, keyFile }) → object` — env con `RCLONE_CONFIG_TXPL_*` para SFTP (usa `_PASS` si hay `password`, o `_KEY_FILE` si hay `keyFile`).
  - `effectiveRemote(encryptEnabled, remotePath) → string` — devuelve `'txplcrypt:'` si el cifrado está activo, o `'txpl:<remotePath>'` si no.

- [ ] **Step 1: Escribir los tests que fallan**

```javascript
// backend/test/rclone.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const r = require('../lib/rclone');

test('constantes de nombres de remoto', () => {
  assert.strictEqual(r.RCLONE_REMOTE, 'txpl');
  assert.strictEqual(r.RCLONE_CRYPT, 'txplcrypt');
});

test('buildS3Env produce las variables RCLONE_CONFIG_TXPL_*', () => {
  const env = r.buildS3Env({ endpoint: 'https://s3.eu-west-1.amazonaws.com', region: 'eu-west-1', accessKey: 'AK', secretKey: 'SK' });
  assert.strictEqual(env.RCLONE_CONFIG_TXPL_TYPE, 's3');
  assert.strictEqual(env.RCLONE_CONFIG_TXPL_PROVIDER, 'Other');
  assert.strictEqual(env.RCLONE_CONFIG_TXPL_ENDPOINT, 'https://s3.eu-west-1.amazonaws.com');
  assert.strictEqual(env.RCLONE_CONFIG_TXPL_REGION, 'eu-west-1');
  assert.strictEqual(env.RCLONE_CONFIG_TXPL_ACCESS_KEY_ID, 'AK');
  assert.strictEqual(env.RCLONE_CONFIG_TXPL_SECRET_ACCESS_KEY, 'SK');
  assert.strictEqual(env.RCLONE_CONFIG_TXPL_ENV_AUTH, 'false');
});

test('buildSftpEnv con password', () => {
  const env = r.buildSftpEnv({ host: 'a.b.com', port: 22, user: 'u', password: 'p' });
  assert.strictEqual(env.RCLONE_CONFIG_TXPL_TYPE, 'sftp');
  assert.strictEqual(env.RCLONE_CONFIG_TXPL_HOST, 'a.b.com');
  assert.strictEqual(env.RCLONE_CONFIG_TXPL_PORT, '22');
  assert.strictEqual(env.RCLONE_CONFIG_TXPL_USER, 'u');
  assert.strictEqual(env.RCLONE_CONFIG_TXPL_PASS, 'p');
  assert.strictEqual(env.RCLONE_CONFIG_TXPL_KEY_FILE, undefined);
});

test('buildSftpEnv con keyFile (prioriza clave sobre password)', () => {
  const env = r.buildSftpEnv({ host: 'a.b.com', port: 2222, user: 'u', keyFile: '/tmp/k' });
  assert.strictEqual(env.RCLONE_CONFIG_TXPL_KEY_FILE, '/tmp/k');
  assert.strictEqual(env.RCLONE_CONFIG_TXPL_PASS, undefined);
  assert.strictEqual(env.RCLONE_CONFIG_TXPL_PORT, '2222');
});

test('effectiveRemote', () => {
  assert.strictEqual(r.effectiveRemote(true, 'ruta/x'), 'txplcrypt:');
  assert.strictEqual(r.effectiveRemote(false, 'ruta/x'), 'txpl:ruta/x');
  assert.strictEqual(r.effectiveRemote(false, ''), 'txpl:');
});
```

- [ ] **Step 2: Ejecutar los tests para verificar que fallan**

Run: `node --test backend/test/rclone.test.js`
Expected: FAIL con "Cannot find module '../lib/rclone'".

- [ ] **Step 3: Implementar la primera parte de `backend/lib/rclone.js`**

```javascript
'use strict';

// ============================================================
//  TecXPaneL — Helpers puros de rclone (destinos remotos)
//
//  Sin estado ni dependencias del servidor: nombres de remoto,
//  construcción del entorno por tipo (S3/SFTP), y (Task 2) montaje
//  del remoto crypt y args de rclone. Los secretos viajan por env
//  vars del proceso hijo, nunca por argv ni por rclone.conf.
// ============================================================

// Nombres de remoto INTERNOS que rclone lee de las env vars
// RCLONE_CONFIG_<NOMBRE>_*. El operador NUNCA los ve.
const RCLONE_REMOTE = 'txpl';
const RCLONE_CRYPT = 'txplcrypt';

// Env para un remoto S3-compatible (Amazon, Backblaze B2, Wasabi, MinIO, DO Spaces…).
// PROVIDER='Other' + ENV_AUTH='false' evita que rclone intente resolver credenciales
// del entorno del sistema.
function buildS3Env({ endpoint, region, accessKey, secretKey } = {}) {
  return {
    RCLONE_CONFIG_TXPL_TYPE: 's3',
    RCLONE_CONFIG_TXPL_PROVIDER: 'Other',
    RCLONE_CONFIG_TXPL_ENV_AUTH: 'false',
    RCLONE_CONFIG_TXPL_ENDPOINT: endpoint,
    RCLONE_CONFIG_TXPL_REGION: region,
    RCLONE_CONFIG_TXPL_ACCESS_KEY_ID: accessKey,
    RCLONE_CONFIG_TXPL_SECRET_ACCESS_KEY: secretKey,
  };
}

// Env para un remoto SFTP. Prefiere `keyFile` (ruta a la clave privada) sobre
// `password`; si ambos vienen, la clave gana.
function buildSftpEnv({ host, port, user, password, keyFile } = {}) {
  const env = {
    RCLONE_CONFIG_TXPL_TYPE: 'sftp',
    RCLONE_CONFIG_TXPL_HOST: host,
    RCLONE_CONFIG_TXPL_PORT: String(port),
    RCLONE_CONFIG_TXPL_USER: user,
  };
  if (keyFile) env.RCLONE_CONFIG_TXPL_KEY_FILE = keyFile;
  else if (password) env.RCLONE_CONFIG_TXPL_PASS = password;
  return env;
}

// Ruta destino que se pasa a rclone. Con cifrado activo, el remoto crypt
// ya apunta al remote_path por debajo (ver buildCryptEnv en Task 2), así que
// aquí simplemente devolvemos su raíz.
function effectiveRemote(encryptEnabled, remotePath) {
  if (encryptEnabled) return `${RCLONE_CRYPT}:`;
  return `${RCLONE_REMOTE}:${remotePath || ''}`;
}

module.exports = {
  RCLONE_REMOTE, RCLONE_CRYPT,
  buildS3Env, buildSftpEnv, effectiveRemote,
};
```

- [ ] **Step 4: Ejecutar los tests para verificar que pasan**

Run: `node --test backend/test/rclone.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/lib/rclone.js backend/test/rclone.test.js
git commit -m "feat(backups-remoto): helpers puros de rclone (env S3/SFTP, effectiveRemote) + tests"
```

---

## Task 2: `lib/rclone.js` — env `crypt`, args de rclone y `parseLsjson`

**Files:**
- Modify: `backend/lib/rclone.js` (añadir funciones + exports)
- Test: `backend/test/rclone.test.js` (añadir tests)

**Interfaces:**
- Consumes: `RCLONE_REMOTE`, `RCLONE_CRYPT` (Task 1).
- Produces:
  - `buildCryptEnv({ passphraseObscured, remotePath }) → object` — env que define `txplcrypt` de tipo `crypt` apuntando a `txpl:<remotePath>`. Espera la passphrase YA obscurecida (el ejecutor la obtiene de `rclone obscure` en Task 3).
  - `copyArgs(local, remote) → string[]` → `['copy', local, remote, '--s3-no-check-bucket']`.
  - `lsjsonArgs(remote) → string[]` → `['lsjson', remote]`.
  - `deleteArgs(remote) → string[]` → `['deletefile', remote]`.
  - `checkRemoteArgs(remote) → string[]` → `['lsd', remote]`.
  - `obscureArgs(pass) → string[]` → `['obscure', pass]`.
  - `parseLsjson(text) → [{ name, size, modTime }]` — parsea la salida de `rclone lsjson` (JSON array). Tolera vacío/malformado devolviendo `[]`.

- [ ] **Step 1: Añadir los tests que fallan al final de `backend/test/rclone.test.js`**

```javascript
test('buildCryptEnv monta txplcrypt sobre txpl:<remotePath>', () => {
  const env = r.buildCryptEnv({ passphraseObscured: 'OBSC', remotePath: 'mi-bucket/dir' });
  assert.strictEqual(env.RCLONE_CONFIG_TXPLCRYPT_TYPE, 'crypt');
  assert.strictEqual(env.RCLONE_CONFIG_TXPLCRYPT_REMOTE, 'txpl:mi-bucket/dir');
  assert.strictEqual(env.RCLONE_CONFIG_TXPLCRYPT_FILENAME_ENCRYPTION, 'standard');
  assert.strictEqual(env.RCLONE_CONFIG_TXPLCRYPT_PASSWORD, 'OBSC');
});

test('copyArgs / lsjsonArgs / deleteArgs / checkRemoteArgs / obscureArgs', () => {
  assert.deepStrictEqual(r.copyArgs('/tmp/a.tar.gz', 'txpl:x'), ['copy', '/tmp/a.tar.gz', 'txpl:x', '--s3-no-check-bucket']);
  assert.deepStrictEqual(r.lsjsonArgs('txpl:x'), ['lsjson', 'txpl:x']);
  assert.deepStrictEqual(r.deleteArgs('txpl:x/a.tar.gz'), ['deletefile', 'txpl:x/a.tar.gz']);
  assert.deepStrictEqual(r.checkRemoteArgs('txpl:x'), ['lsd', 'txpl:x']);
  assert.deepStrictEqual(r.obscureArgs('secreta'), ['obscure', 'secreta']);
});

test('parseLsjson extrae name/size/modTime', () => {
  const j = JSON.stringify([
    { Name: 'backup-a.tar.gz', Size: 1024, ModTime: '2026-07-01T00:00:00Z', IsDir: false },
    { Name: 'sub', Size: -1, ModTime: '2026-07-02T00:00:00Z', IsDir: true },
  ]);
  const out = r.parseLsjson(j);
  assert.deepStrictEqual(out, [{ name: 'backup-a.tar.gz', size: 1024, modTime: '2026-07-01T00:00:00Z' }]);
});

test('parseLsjson tolera basura y vacío', () => {
  assert.deepStrictEqual(r.parseLsjson(''), []);
  assert.deepStrictEqual(r.parseLsjson('no-json'), []);
  assert.deepStrictEqual(r.parseLsjson('[]'), []);
});
```

- [ ] **Step 2: Ejecutar los tests para verificar que fallan**

Run: `node --test backend/test/rclone.test.js`
Expected: FAIL con "r.buildCryptEnv is not a function".

- [ ] **Step 3: Añadir las funciones a `backend/lib/rclone.js`** (antes de `module.exports`)

```javascript
// Env para un remoto `crypt` que envuelve al remoto de almacenamiento.
// La passphrase debe venir YA obscurecida por `rclone obscure` (el ejecutor
// lo hace en tiempo real, ver lib/backupRemote.js). El nombre de fichero
// también se cifra ('standard'), así el remoto no revela los backups por su nombre.
function buildCryptEnv({ passphraseObscured, remotePath } = {}) {
  return {
    RCLONE_CONFIG_TXPLCRYPT_TYPE: 'crypt',
    RCLONE_CONFIG_TXPLCRYPT_REMOTE: `${RCLONE_REMOTE}:${remotePath || ''}`,
    RCLONE_CONFIG_TXPLCRYPT_FILENAME_ENCRYPTION: 'standard',
    RCLONE_CONFIG_TXPLCRYPT_PASSWORD: passphraseObscured,
  };
}

function copyArgs(local, remote) { return ['copy', local, remote, '--s3-no-check-bucket']; }
function lsjsonArgs(remote) { return ['lsjson', remote]; }
function deleteArgs(remote) { return ['deletefile', remote]; }
function checkRemoteArgs(remote) { return ['lsd', remote]; }
function obscureArgs(pass) { return ['obscure', pass]; }

// Parsea la salida de `rclone lsjson`. Ignora directorios y entradas malformadas.
function parseLsjson(text) {
  let arr;
  try { arr = JSON.parse(String(text || '')); } catch (_) { return []; }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((it) => it && it.IsDir === false && typeof it.Name === 'string')
    .map((it) => ({ name: it.Name, size: typeof it.Size === 'number' ? it.Size : 0, modTime: it.ModTime || null }));
}
```

Y añade estos nombres al `module.exports`:

```javascript
  buildCryptEnv, copyArgs, lsjsonArgs, deleteArgs, checkRemoteArgs, obscureArgs,
  parseLsjson,
```

- [ ] **Step 4: Ejecutar los tests para verificar que pasan**

Run: `node --test backend/test/rclone.test.js`
Expected: PASS (9 tests en total).

- [ ] **Step 5: Commit**

```bash
git add backend/lib/rclone.js backend/test/rclone.test.js
git commit -m "feat(backups-remoto): env crypt, args de rclone y parseLsjson + tests"
```

---

## Task 3: Esquema SQLite y queries

**Files:**
- Modify: `backend/database.js` (tabla `backup_remote` + queries)

**Interfaces:**
- Consumes: nada.
- Produces (en `queries`):
  - `getBackupRemote` → `SELECT * FROM backup_remote WHERE id = 1`
  - `saveBackupRemote` → upsert `ON CONFLICT(id)` sobre `backup_remote`
  - `clearBackupRemote` → `DELETE FROM backup_remote WHERE id = 1`

- [ ] **Step 1: Añadir la tabla al bloque `CREATE TABLE` de `database.js`** (tras `dns_config`)

```sql
  CREATE TABLE IF NOT EXISTS backup_remote (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    type            TEXT NOT NULL,
    config_enc      TEXT NOT NULL,
    remote_path     TEXT NOT NULL DEFAULT '',
    encrypt_enabled INTEGER NOT NULL DEFAULT 0,
    crypt_pass_enc  TEXT,
    auto_upload     INTEGER NOT NULL DEFAULT 0,
    retention_days  INTEGER NOT NULL DEFAULT 30,
    status          TEXT NOT NULL DEFAULT 'unconfigured',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
```

- [ ] **Step 2: Añadir las queries al objeto `queries`** (junto a las de dns/mail)

```javascript
  // ── Backups: destino remoto ──────────────────────────────
  getBackupRemote: db.prepare('SELECT * FROM backup_remote WHERE id = 1'),
  saveBackupRemote: db.prepare(`
    INSERT INTO backup_remote (id, type, config_enc, remote_path, encrypt_enabled, crypt_pass_enc, auto_upload, retention_days, status, created_at)
    VALUES (1, @type, @config_enc, @remote_path, @encrypt_enabled, @crypt_pass_enc, @auto_upload, @retention_days, @status, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      type = @type, config_enc = @config_enc, remote_path = @remote_path,
      encrypt_enabled = @encrypt_enabled, crypt_pass_enc = @crypt_pass_enc,
      auto_upload = @auto_upload, retention_days = @retention_days, status = @status`),
  clearBackupRemote: db.prepare('DELETE FROM backup_remote WHERE id = 1'),
```

- [ ] **Step 3: Verificar que el esquema carga y las queries existen**

Run: `TXPL_DIR=./ JWT_SECRET=$(printf 'x%.0s' {1..40}) node -e "const {queries}=require('./backend/database'); ['getBackupRemote','saveBackupRemote','clearBackupRemote'].forEach(k=>{if(!queries[k])throw new Error('falta '+k)}); console.log('OK queries backup_remote')"; rm -rf data`
Expected: imprime `OK queries backup_remote`.

- [ ] **Step 4: Commit**

```bash
git add backend/database.js
git commit -m "feat(backups-remoto): tabla backup_remote + queries"
```

---

## Task 4: `lib/backupRemote.js` — ejecutor de rclone

**Files:**
- Create: `backend/lib/backupRemote.js`

**Interfaces:**
- Consumes: helpers de Tasks 1-2 (`R.*`); `queries` (Task 3); `encryptSecret`/`decryptSecret` (`lib/crypto.js`); `BACKUP_DIR`/`isValidBackupFilename` (`lib/backups.js`).
- Produces:
  - `async obscurePassword(pass) → string` — llama a `rclone obscure` y devuelve el hash.
  - `async buildEnv() → { env, cleanup }` — lee `backup_remote`, descifra secretos, construye el env combinado (storage + crypt si aplica), materializa el `keyFile` temporal si es SFTP con `keyContent`; `cleanup()` borra el fichero temporal.
  - `async uploadArchive({ filename }) → { ok, message }` — sube `BACKUP_DIR/<filename>` al remoto.
  - `async listRemote() → { ok, items, message }` — devuelve `parseLsjson`.
  - `async downloadArchive({ filename }) → { ok, message }` — descarga a `BACKUP_DIR/<filename>`.
  - `async deleteRemote({ filename }) → { ok, message }`.
  - `async testConnection() → { ok, message }`.

- [ ] **Step 1: Implementar `backend/lib/backupRemote.js`**

```javascript
'use strict';

// ============================================================
//  TecXPaneL — Ejecutor de rclone para backups remotos
//
//  Lee backup_remote, descifra las credenciales y las pasa al
//  proceso rclone por VARIABLES DE ENTORNO (no argv, no rclone.conf).
//  Si el SFTP usa clave, se materializa en un fichero temporal 0600
//  y se borra en cleanup(). Todo comando via execFile con arrays.
// ============================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const R = require('./rclone');
const B = require('./backups');
const { decryptSecret } = require('./crypto');
const { queries } = require('../database');

const execFileP = promisify(execFile);

function runRclone(args, extraEnv = {}) {
  return execFileP('rclone', args, {
    env: { ...process.env, ...extraEnv },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 0,
  });
}

async function obscurePassword(pass) {
  const { stdout } = await runRclone(R.obscureArgs(pass));
  return String(stdout || '').trim();
}

// Construye el env para el proceso rclone a partir de la config guardada.
// Devuelve además cleanup() para borrar el fichero temporal de la clave SSH.
async function buildEnv() {
  const cfg = queries.getBackupRemote.get();
  if (!cfg) { const e = new Error('Destino remoto no configurado.'); e.http = 400; throw e; }
  const creds = JSON.parse(decryptSecret(cfg.config_enc));

  let env = {};
  let cleanup = async () => {};
  if (cfg.type === 's3') {
    env = R.buildS3Env(creds);
  } else if (cfg.type === 'sftp') {
    let keyFile = null;
    if (creds.keyContent) {
      keyFile = path.join(os.tmpdir(), `txpl-sshkey-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      fs.writeFileSync(keyFile, creds.keyContent, { mode: 0o600 });
      cleanup = async () => { try { fs.unlinkSync(keyFile); } catch (_) {} };
    }
    env = R.buildSftpEnv({ host: creds.host, port: creds.port, user: creds.user, password: creds.password, keyFile });
  } else {
    const e = new Error('Tipo de remoto no soportado.'); e.http = 400; throw e;
  }

  if (cfg.encrypt_enabled) {
    if (!cfg.crypt_pass_enc) { await cleanup(); const e = new Error('Cifrado activado sin passphrase.'); e.http = 400; throw e; }
    const pass = decryptSecret(cfg.crypt_pass_enc);
    const obsc = await obscurePassword(pass);
    Object.assign(env, R.buildCryptEnv({ passphraseObscured: obsc, remotePath: cfg.remote_path }));
  }
  const remote = R.effectiveRemote(!!cfg.encrypt_enabled, cfg.remote_path);
  return { env, cleanup, remote, cfg };
}

async function uploadArchive({ filename }) {
  if (!B.isValidBackupFilename(filename)) return { ok: false, message: 'Nombre de backup inválido' };
  const local = path.join(B.BACKUP_DIR, filename);
  if (!fs.existsSync(local)) return { ok: false, message: 'El archivo local no existe' };
  const { env, cleanup, remote } = await buildEnv();
  try {
    await runRclone(R.copyArgs(local, remote), env);
    return { ok: true, message: 'Subido' };
  } catch (e) {
    return { ok: false, message: (e.stderr || e.message || '').toString().slice(0, 300) };
  } finally { await cleanup(); }
}

async function listRemote() {
  const { env, cleanup, remote } = await buildEnv();
  try {
    const { stdout } = await runRclone(R.lsjsonArgs(remote), env);
    return { ok: true, items: R.parseLsjson(stdout) };
  } catch (e) {
    return { ok: false, items: [], message: (e.stderr || e.message || '').toString().slice(0, 300) };
  } finally { await cleanup(); }
}

async function downloadArchive({ filename }) {
  if (!B.isValidBackupFilename(filename)) return { ok: false, message: 'Nombre de backup inválido' };
  const { env, cleanup, remote } = await buildEnv();
  try {
    // rclone copy `<remote>/<filename>` `<BACKUP_DIR>` deposita el archivo dentro.
    await runRclone(R.copyArgs(`${remote.replace(/\/$/, '')}/${filename}`, B.BACKUP_DIR), env);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: (e.stderr || e.message || '').toString().slice(0, 300) };
  } finally { await cleanup(); }
}

async function deleteRemote({ filename }) {
  if (!B.isValidBackupFilename(filename)) return { ok: false, message: 'Nombre de backup inválido' };
  const { env, cleanup, remote } = await buildEnv();
  try {
    await runRclone(R.deleteArgs(`${remote.replace(/\/$/, '')}/${filename}`), env);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: (e.stderr || e.message || '').toString().slice(0, 300) };
  } finally { await cleanup(); }
}

async function testConnection() {
  const { env, cleanup, remote } = await buildEnv();
  try {
    await runRclone(R.checkRemoteArgs(remote), env);
    return { ok: true, message: 'Conexión correcta' };
  } catch (e) {
    return { ok: false, message: (e.stderr || e.message || '').toString().slice(0, 300) };
  } finally { await cleanup(); }
}

module.exports = { obscurePassword, buildEnv, uploadArchive, listRemote, downloadArchive, deleteRemote, testConnection };
```

- [ ] **Step 2: Verificar que el módulo carga (require sin errores)**

Run: `TXPL_DIR=./ JWT_SECRET=$(printf 'x%.0s' {1..40}) node -e "require('./backend/lib/backupRemote'); console.log('backupRemote OK')"; rm -rf data`
Expected: imprime `backupRemote OK`.

- [ ] **Step 3: Commit**

```bash
git add backend/lib/backupRemote.js
git commit -m "feat(backups-remoto): ejecutor rclone (subir/listar/descargar/borrar/probar)"
```

---

## Task 5: Endpoints en `routes/backups.js` + auto-subida

**Files:**
- Modify: `backend/routes/backups.js`

**Interfaces:**
- Consumes: `queries` + `encryptSecret`/`decryptSecret` + `backupRemote` (Task 4); `ok`/`fail`/`clientIp`/`wrap` (`helpers.js`); `engine` ya importado en la Fase 1.
- Produces (endpoints bajo `/api/backups`):
  - `GET /remote` — devuelve la config SIN secretos.
  - `POST /remote` — valida, prueba conexión, cifra y guarda.
  - `POST /remote/test` — prueba con la config actual.
  - `POST /:id/upload` — sube un backup local.
  - `GET /remote/list` — lista los backups del remoto.
  - `POST /remote/:filename/restore` — descarga y ejecuta el restore granular existente.
  - `DELETE /remote/:filename` — borra del remoto.
  - `DELETE /remote` — limpia la config.
  - Y en `POST /` (crear backup): tras `createBackup`, si hay remoto con `auto_upload`, subir best-effort.

- [ ] **Step 1: Añadir los imports necesarios al principio del archivo**

En `backend/routes/backups.js`, junto a los imports existentes, añade:

```javascript
const { encryptSecret, decryptSecret } = require('../lib/crypto');
const remote = require('../lib/backupRemote');
```

- [ ] **Step 2: Añadir estos endpoints al final del archivo, ANTES de `module.exports = router;`**

```javascript
// ── Destino remoto (config) ──────────────────────────────────
function stripSecrets(cfg) {
  if (!cfg) return null;
  return {
    type: cfg.type, remote_path: cfg.remote_path,
    encrypt_enabled: !!cfg.encrypt_enabled, auto_upload: !!cfg.auto_upload,
    retention_days: cfg.retention_days, status: cfg.status,
  };
}

router.get('/remote', (req, res) => {
  ok(res, { remote: stripSecrets(queries.getBackupRemote.get()) });
});

router.post('/remote', wrap(async (req, res) => {
  const b = req.body || {};
  const type = String(b.type || '').toLowerCase();
  if (!['s3', 'sftp'].includes(type)) return fail(res, 400, 'Tipo de remoto inválido (s3 | sftp).');
  const remote_path = String(b.remote_path || '').trim();
  const auto_upload = b.auto_upload ? 1 : 0;
  const retention_days = Number.isInteger(+b.retention_days) && +b.retention_days > 0 ? +b.retention_days : 30;
  const encrypt_enabled = b.encrypt_enabled ? 1 : 0;

  let creds;
  if (type === 's3') {
    const { endpoint, region, accessKey, secretKey } = b;
    if (!endpoint || !region || !accessKey || !secretKey) return fail(res, 400, 'Credenciales S3 incompletas.');
    creds = { endpoint, region, accessKey, secretKey };
  } else {
    const { host, port, user, password, keyContent } = b;
    if (!host || !port || !user || (!password && !keyContent)) return fail(res, 400, 'Credenciales SFTP incompletas.');
    creds = { host, port: +port, user, password: password || null, keyContent: keyContent || null };
  }

  let crypt_pass_enc = null;
  if (encrypt_enabled) {
    const pass = String(b.crypt_pass || '');
    if (pass.length < 8) return fail(res, 400, 'La passphrase de cifrado debe tener al menos 8 caracteres.');
    crypt_pass_enc = encryptSecret(pass);
  }

  // Guardar temporalmente para poder probar con la config nueva.
  queries.saveBackupRemote.run({
    type, config_enc: encryptSecret(JSON.stringify(creds)),
    remote_path, encrypt_enabled, crypt_pass_enc,
    auto_upload, retention_days, status: 'unconfigured',
  });
  const t = await remote.testConnection();
  queries.saveBackupRemote.run({
    type, config_enc: encryptSecret(JSON.stringify(creds)),
    remote_path, encrypt_enabled, crypt_pass_enc,
    auto_upload, retention_days, status: t.ok ? 'ok' : 'error',
  });
  audit(req.user?.username || 'system', clientIp(req), 'backup.remote.config', `${type} ${t.ok ? 'ok' : 'error'}`);
  if (!t.ok) return fail(res, 502, 'La conexión con el remoto falló: ' + t.message);
  ok(res, { status: 'ok' });
}));

router.post('/remote/test', wrap(async (req, res) => {
  const t = await remote.testConnection();
  audit(req.user?.username || 'system', clientIp(req), 'backup.remote.test', t.ok ? 'ok' : 'error');
  ok(res, t);
}));

router.delete('/remote', wrap(async (req, res) => {
  queries.clearBackupRemote.run();
  audit(req.user?.username || 'system', clientIp(req), 'backup.remote.clear', '');
  ok(res);
}));

// ── Subir un backup local al remoto ──────────────────────────
router.post('/:id/upload', wrap(async (req, res) => {
  const row = queries.getBackup.get(+req.params.id);
  if (!row) return fail(res, 404, 'Backup no encontrado');
  const r = await remote.uploadArchive({ filename: row.filename });
  audit(req.user?.username || 'system', clientIp(req), 'backup.remote.upload', `${row.filename} ${r.ok ? 'ok' : 'error'}`);
  if (!r.ok) return fail(res, 502, r.message || 'Subida fallida');
  ok(res);
}));

// ── Listar backups del remoto ────────────────────────────────
router.get('/remote/list', wrap(async (req, res) => {
  const r = await remote.listRemote();
  if (!r.ok) return fail(res, 502, r.message || 'No se pudo listar el remoto');
  ok(res, { items: r.items });
}));

// ── Restaurar un backup del remoto ───────────────────────────
router.post('/remote/:filename/restore', wrap(async (req, res) => {
  const filename = String(req.params.filename || '');
  if (!B.isValidBackupFilename(filename)) return fail(res, 400, 'Nombre de backup inválido');
  audit(req.user?.username || 'system', clientIp(req), 'backup.remote.restore', filename);
  startStream(res);
  try {
    res.write('☁️  Descargando desde el remoto...\n');
    const d = await remote.downloadArchive({ filename });
    if (!d.ok) { res.write('[error] ' + (d.message || 'descarga fallida') + '\n'); return res.end('\n__TXPL_DONE__1'); }
    // Cataloga (si aún no está) para que la UI lo vea local.
    if (!queries.getBackupByFilename.get(filename)) {
      const size = require('fs').statSync(require('path').join(B.BACKUP_DIR, filename)).size;
      queries.insertBackup.run({ filename, created_at: new Date().toISOString(), size_bytes: size, kind: 'full', scope: '[]', origin: 'remote-restore', status: 'ok', notes: null });
    }
    // Snapshot pre-restore + restaurar TODAS las piezas del manifest.
    const manifest = await engine.readManifest(filename);
    res.write('🛟 Creando snapshot de seguridad antes de restaurar...\n');
    await engine.createBackup({ items: manifest.items.map((i) => ({ class: i.class, name: i.name })), kind: 'resource', origin: 'pre-restore', write: (t) => res.write(t) });
    for (const it of manifest.items) await engine.restoreItem({ filename, item: it, write: (t) => res.write(t) });
    res.end('\n__TXPL_DONE__0');
  } catch (e) {
    res.write('[error] ' + e.message + '\n');
    res.end('\n__TXPL_DONE__1');
  }
}));

// ── Borrar un backup del remoto ──────────────────────────────
router.delete('/remote/:filename', wrap(async (req, res) => {
  const filename = String(req.params.filename || '');
  if (!B.isValidBackupFilename(filename)) return fail(res, 400, 'Nombre de backup inválido');
  const r = await remote.deleteRemote({ filename });
  audit(req.user?.username || 'system', clientIp(req), 'backup.remote.delete', `${filename} ${r.ok ? 'ok' : 'error'}`);
  if (!r.ok) return fail(res, 502, r.message || 'Borrado fallido');
  ok(res);
}));
```

- [ ] **Step 3: Añadir la auto-subida al final del `then()` de `POST /`** (creación de backup)

Localiza en `backend/routes/backups.js` el handler `router.post('/', ...)`. La línea actual es:

```javascript
  engine.createBackup({ items, kind, origin: 'manual', write: (t) => res.write(t) })
    .then(() => res.end('\n__TXPL_DONE__0'))
    .catch(() => res.end('\n__TXPL_DONE__1'));
```

Reemplázala por:

```javascript
  engine.createBackup({ items, kind, origin: 'manual', write: (t) => res.write(t) })
    .then(async (created) => {
      // Auto-subida best-effort: si hay remoto configurado con auto_upload,
      // sube el archivo recién creado sin bloquear el resultado del backup local.
      try {
        const rcfg = queries.getBackupRemote.get();
        if (rcfg && rcfg.auto_upload && created && created.filename) {
          res.write('☁️  Subiendo al destino remoto...\n');
          const up = await remote.uploadArchive({ filename: created.filename });
          res.write(up.ok ? '   ↳ subido\n' : `   ↳ [aviso] no se pudo subir: ${up.message}\n`);
          audit(req.user?.username || 'system', clientIp(req), 'backup.remote.autoupload', `${created.filename} ${up.ok ? 'ok' : 'error'}`);
        }
      } catch (_) { /* la subida no debe tumbar el backup local */ }
      res.end('\n__TXPL_DONE__0');
    })
    .catch(() => res.end('\n__TXPL_DONE__1'));
```

> **Nota:** `engine.createBackup` (Fase 1) devuelve `{ filename, size, id }`. Aquí se llama con `created.filename` sin destruir esa forma.

- [ ] **Step 4: Verificar que el router carga sin errores**

Run: `TXPL_DIR=./ JWT_SECRET=$(printf 'x%.0s' {1..40}) node -e "require('./backend/routes/backups'); console.log('router backups OK')"; rm -rf data`
Expected: imprime `router backups OK`.

- [ ] **Step 5: Ejecutar la batería de tests**

Run: `node --test "backend/test/**/*.test.js"`
Expected: PASS (incluye los 9 de rclone.test.js).

- [ ] **Step 6: Commit**

```bash
git add backend/routes/backups.js
git commit -m "feat(backups-remoto): endpoints /remote + auto-subida tras crear un backup"
```

---

## Task 6: Retención remota en el runner

**Files:**
- Modify: `backend/backup-runner.js`

**Interfaces:**
- Consumes: `queries` + `lib/backupRemote` (Task 4); `selectExpiredBackups` (`lib/backups.js`).

- [ ] **Step 1: Añadir el import y la retención remota al final del `main()` del runner**

En `backend/backup-runner.js`, tras la retención local (después del bucle `for (const filename of expired)`), añade:

```javascript
  // Retención REMOTA (best-effort, independiente de la local): borra los
  // `scheduled` del remoto que sean más antiguos que retention_days del remoto.
  try {
    const rcfg = queries.getBackupRemote.get();
    if (rcfg && rcfg.retention_days > 0) {
      const remote = require('./lib/backupRemote');
      const list = await remote.listRemote();
      if (list.ok && list.items.length) {
        const rows = list.items
          .filter((it) => B.isValidBackupFilename(it.name))
          .map((it) => ({ filename: it.name, origin: 'scheduled', created_at: it.modTime }));
        const expiredR = B.selectExpiredBackups(rows, rcfg.retention_days, new Date());
        for (const filename of expiredR) {
          const r = await remote.deleteRemote({ filename });
          console.log(`[backup-runner] retención remota: ${filename} ${r.ok ? 'borrado' : 'error: ' + r.message}`);
        }
      }
    }
  } catch (e) {
    console.error('[backup-runner] retención remota:', e.message);
  }
```

Sitúalo justo antes del `console.log('[backup-runner] completado');`.

> **Nota:** `selectExpiredBackups` recibe filas con `origin` y `created_at`; aquí tratamos todo lo listado en el remoto como `scheduled` para forzar caducidad. Los backups `manual`/`pre-restore` locales que se hayan subido a mano quedan sujetos a la misma regla en el remoto — es una decisión pragmática v1 y se documenta.

- [ ] **Step 2: Verificar sintaxis**

Run: `node --check backend/backup-runner.js && echo "sintaxis OK"`
Expected: imprime `sintaxis OK`.

- [ ] **Step 3: Commit**

```bash
git add backend/backup-runner.js
git commit -m "feat(backups-remoto): retención remota en el runner de cron"
```

---

## Task 7: `rclone` como plugin instalable

**Files:**
- Modify: `backend/routes/plugins.js`

**Interfaces:**
- Consumes: patrón existente `{ name, check, install, uninstall }` del catálogo de plugins.

- [ ] **Step 1: Añadir `rclone` al catálogo de plugins**

En `backend/routes/plugins.js`, en el objeto de plugins (junto a docker/phpmyadmin/adminer/etc.), añade:

```javascript
  rclone: {
    name: 'rclone', category: 'Backups', icon: 'cloud-upload', desc: 'Cliente para copiar backups a S3/SFTP/etc.',
    check: ['rclone', ['version']],
    install: ['bash', ['-c', 'DEBIAN_FRONTEND=noninteractive apt-get install -y rclone']],
    uninstall: ['apt-get', ['remove', '-y', 'rclone']],
  },
```

Colócalo al final del objeto, respetando la coma final del anterior.

- [ ] **Step 2: Verificar que el router de plugins sigue cargando**

Run: `TXPL_DIR=./ JWT_SECRET=$(printf 'x%.0s' {1..40}) node -e "require('./backend/routes/plugins'); console.log('plugins OK')"; rm -rf data`
Expected: imprime `plugins OK`.

- [ ] **Step 3: Commit**

```bash
git add backend/routes/plugins.js
git commit -m "feat(backups-remoto): rclone en el catálogo de plugins instalables"
```

---

## Task 8: Frontend — tarjetas de destino remoto y backups remotos

**Files:**
- Modify: `frontend/views/pages/backups.html` (añadir tarjetas)
- Modify: `frontend/js/app.js` (funciones nuevas y wiring)

**Interfaces:**
- Consumes: endpoints de Tasks 5-6; helpers `req()`, `esc()`, `API`, `TOKEN`, `doLogout()`; funciones existentes de la Fase 1 (`loadBackups`, `streamConsole`).
- Produces: `loadBackupRemote`, `backupRemoteTypeChange`, `backupRemoteEncryptToggle`, `backupRemoteSave`, `backupRemoteTest`, `backupRemoteClear`, `backupUpload(id)`, `loadRemoteBackups`, `backupRemoteRestore(filename)`, `backupRemoteDelete(filename)`.

- [ ] **Step 1: Añadir las tarjetas al final de `frontend/views/pages/backups.html`** (antes del `<div class="console">` si lo hubiera, o al final)

```html
<div class="card">
  <h3><i class="ti ti-cloud-upload"></i> Destino remoto</h3>
  <div id="remote-summary" class="muted">Cargando…</div>
  <div class="form-row">
    <label>Tipo:
      <select id="rm-type" onchange="backupRemoteTypeChange()">
        <option value="s3">S3-compatible</option>
        <option value="sftp">SFTP</option>
      </select>
    </label>
    <label>Ruta remota: <input type="text" id="rm-path" placeholder="mi-bucket/prefijo o /ruta/absoluta" style="width:240px"></label>
  </div>
  <div id="rm-s3" class="form-row">
    <input type="text" id="rm-endpoint" placeholder="Endpoint (ej. https://s3.eu-west-1.amazonaws.com)" style="width:280px">
    <input type="text" id="rm-region" placeholder="Región (ej. eu-west-1)" style="width:140px">
    <input type="text" id="rm-akey" placeholder="Access Key" style="width:160px">
    <input type="password" id="rm-skey" placeholder="Secret Key" style="width:160px">
  </div>
  <div id="rm-sftp" class="form-row" style="display:none">
    <input type="text" id="rm-host" placeholder="host" style="width:180px">
    <input type="number" id="rm-port" placeholder="22" value="22" style="width:70px">
    <input type="text" id="rm-user" placeholder="usuario" style="width:140px">
    <input type="password" id="rm-pass" placeholder="contraseña (o clave abajo)" style="width:180px">
    <textarea id="rm-key" placeholder="Clave privada SSH (opcional, prevalece sobre contraseña)" style="width:100%;height:60px"></textarea>
  </div>
  <div class="form-row">
    <label><input type="checkbox" id="rm-encrypt" onchange="backupRemoteEncryptToggle()"> Cifrar los backups en el remoto</label>
    <input type="password" id="rm-cryptpass" placeholder="Passphrase de cifrado (mínimo 8)" style="width:280px;display:none">
  </div>
  <div class="form-row">
    <label><input type="checkbox" id="rm-auto"> Subir automáticamente tras cada backup</label>
    <label>Retención remota (días): <input type="number" id="rm-retention" value="30" min="1" style="width:80px"></label>
  </div>
  <div class="form-row">
    <button class="btn btn-primary" onclick="backupRemoteSave()"><i class="ti ti-device-floppy"></i> Guardar</button>
    <button class="btn" onclick="backupRemoteTest()"><i class="ti ti-plug"></i> Probar conexión</button>
    <button class="btn btn-danger" onclick="backupRemoteClear()"><i class="ti ti-trash"></i> Desconectar</button>
  </div>
  <p class="muted"><b>Aviso:</b> si activas el cifrado, guarda tu passphrase fuera del VPS. Sin ella no podrás descifrar los backups remotos si pierdes el servidor.</p>
</div>

<div class="card">
  <h3><i class="ti ti-cloud"></i> Backups remotos</h3>
  <div class="form-row"><button class="btn" onclick="loadRemoteBackups()"><i class="ti ti-refresh"></i> Actualizar</button></div>
  <div id="remote-list">—</div>
</div>
```

- [ ] **Step 2: Añadir las funciones a `frontend/js/app.js`** (junto a las de backups)

```javascript
async function loadBackupRemote() {
  const r = await req('GET', '/backups/remote');
  const s = (r && r.remote) || null;
  document.getElementById('remote-summary').textContent = s
    ? `Configurado: ${s.type.toUpperCase()} → ${s.remote_path || '(raíz)'} · cifrado: ${s.encrypt_enabled ? 'sí' : 'no'} · auto-subida: ${s.auto_upload ? 'sí' : 'no'} · estado: ${s.status}`
    : 'Aún no hay destino remoto configurado.';
  if (s) {
    document.getElementById('rm-type').value = s.type;
    document.getElementById('rm-path').value = s.remote_path || '';
    document.getElementById('rm-encrypt').checked = !!s.encrypt_enabled;
    document.getElementById('rm-auto').checked = !!s.auto_upload;
    document.getElementById('rm-retention').value = s.retention_days || 30;
  }
  backupRemoteTypeChange();
  backupRemoteEncryptToggle();
}

function backupRemoteTypeChange() {
  const t = document.getElementById('rm-type').value;
  document.getElementById('rm-s3').style.display = (t === 's3') ? '' : 'none';
  document.getElementById('rm-sftp').style.display = (t === 'sftp') ? '' : 'none';
}

function backupRemoteEncryptToggle() {
  document.getElementById('rm-cryptpass').style.display = document.getElementById('rm-encrypt').checked ? '' : 'none';
}

async function backupRemoteSave() {
  const t = document.getElementById('rm-type').value;
  const body = {
    type: t,
    remote_path: document.getElementById('rm-path').value.trim(),
    encrypt_enabled: document.getElementById('rm-encrypt').checked,
    crypt_pass: document.getElementById('rm-cryptpass').value,
    auto_upload: document.getElementById('rm-auto').checked,
    retention_days: +document.getElementById('rm-retention').value || 30,
  };
  if (t === 's3') Object.assign(body, {
    endpoint: document.getElementById('rm-endpoint').value.trim(),
    region: document.getElementById('rm-region').value.trim(),
    accessKey: document.getElementById('rm-akey').value.trim(),
    secretKey: document.getElementById('rm-skey').value,
  });
  else Object.assign(body, {
    host: document.getElementById('rm-host').value.trim(),
    port: +document.getElementById('rm-port').value || 22,
    user: document.getElementById('rm-user').value.trim(),
    password: document.getElementById('rm-pass').value,
    keyContent: document.getElementById('rm-key').value,
  });
  const r = await req('POST', '/backups/remote', body);
  if (r && r.error) { alert(r.error); return; }
  alert('Guardado.');
  loadBackupRemote();
}

async function backupRemoteTest() {
  const r = await req('POST', '/backups/remote/test');
  alert(r && r.ok ? '✅ Conexión correcta' : '❌ ' + ((r && (r.message || r.error)) || 'Fallo desconocido'));
}

async function backupRemoteClear() {
  if (!confirm('¿Desconectar el destino remoto? La config remota se borra (los archivos en el remoto NO se tocan).')) return;
  await req('DELETE', '/backups/remote');
  loadBackupRemote();
}

async function backupUpload(id) {
  const r = await req('POST', `/backups/${id}/upload`);
  if (r && r.error) alert(r.error); else alert('Subido al remoto.');
}

async function loadRemoteBackups() {
  const r = await req('GET', '/backups/remote/list');
  const el = document.getElementById('remote-list'); if (!el) return;
  if (!r || r.error) { el.innerHTML = `<p class="muted">${esc((r && r.error) || 'No se pudo listar')}</p>`; return; }
  if (!r.items.length) { el.innerHTML = '<p class="muted">Sin backups en el remoto.</p>'; return; }
  el.innerHTML = '<table class="table"><thead><tr><th>Nombre</th><th>Tamaño</th><th>Modificado</th><th></th></tr></thead><tbody>' +
    r.items.map((it) => `<tr>
      <td><code>${esc(it.name)}</code></td>
      <td>${fmtBytes(it.size)}</td>
      <td>${esc(it.modTime || '')}</td>
      <td style="text-align:right">
        <button class="btn btn-sm" onclick="backupRemoteRestore('${esc(it.name)}')"><i class="ti ti-restore"></i></button>
        <button class="btn btn-sm btn-danger" onclick="backupRemoteDelete('${esc(it.name)}')"><i class="ti ti-trash"></i></button>
      </td></tr>`).join('') + '</tbody></table>';
}

async function backupRemoteRestore(filename) {
  if (!confirm(`Se descargará ${filename}, se creará un snapshot de seguridad y luego se restaurará el backup completo. ¿Continuar?`)) return;
  const con = document.getElementById('backups-console');
  con.style.display = 'block'; con.textContent = '';
  await streamConsole(`/backups/remote/${encodeURIComponent(filename)}/restore`, {}, con);
  loadBackups();
}

async function backupRemoteDelete(filename) {
  if (!confirm(`¿Borrar ${filename} del remoto?`)) return;
  await req('DELETE', `/backups/remote/${encodeURIComponent(filename)}`);
  loadRemoteBackups();
}
```

- [ ] **Step 3: Añadir la carga del remoto y un botón de "Subir" en la tabla de backups locales**

En la función `loadBackups()` de `app.js`, al final del `await req(...)` y tras pintar la lista, añade una llamada a `loadBackupRemote();`. Y en la fila de cada backup local, añade un botón entre "Restaurar todo" y "Descargar" (o después del "Descargar"):

```javascript
        <button class="btn btn-sm" onclick="backupUpload(${b.id})" title="Subir al remoto"><i class="ti ti-cloud-upload"></i></button>
```

> Localiza el `map((b) => ... )` dentro de `loadBackups()` y añade el botón junto a los demás por-fila. Mantén el orden Restaurar → Subir → Descargar → Borrar.

- [ ] **Step 4: Verificar que `app.js` sigue parseando**

Run: `node --check frontend/js/app.js && echo "app.js OK"`
Expected: `app.js OK`.

- [ ] **Step 5: Commit**

```bash
git add frontend/views/pages/backups.html frontend/js/app.js
git commit -m "feat(backups-remoto): tarjetas de destino remoto y backups remotos en el frontend"
```

---

## Task 9: Documentación (README + CLAUDE.md)

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Ampliar el bullet de "Copias de Seguridad Gestionadas" en README** con una frase sobre destinos remotos

Localiza el bullet actual y añade al final:

```markdown
 Con destinos remotos opcionales (**S3-compatible o SFTP** vía `rclone`) y **cifrado** opcional con passphrase del usuario.
```

- [ ] **Step 2: Ampliar la sección "💾 Copias de Seguridad" del README con un bloque de destinos remotos**

Al final de la sección de Copias de Seguridad (antes del `---` que la separa de la siguiente), añade:

```markdown
### Destinos remotos (S3-compatible / SFTP)

Con **rclone** puedes replicar los backups fuera del VPS (S3, Backblaze B2, Wasabi,
MinIO, DigitalOcean Spaces, SFTP…). Configúralo en la tarjeta **Destino remoto**:

- Elige tipo (**S3-compatible** o **SFTP**) y rellena las credenciales.
- Activa **cifrado** para que los archivos viajen y se guarden cifrados con tu
  passphrase (modo `crypt` de rclone).
- Activa **subida automática** para replicar cada backup nuevo.

> [!WARNING]
> Si activas el cifrado, guarda la passphrase **fuera del VPS**. Sin ella no podrás
> descifrar los backups remotos si pierdes el servidor por completo (es un caso
> típico de "huevo y gallina" en la recuperación ante desastres).

> [!NOTE]
> `rclone` se instala desde **Plugins**. Las credenciales se guardan **cifradas** y
> se pasan al proceso de rclone por variables de entorno (nunca por `rclone.conf`
> en disco ni en la línea de comandos).
```

- [ ] **Step 3: Actualizar CLAUDE.md** (lista de `backend/lib/` y `backend/routes/`)

En la lista de `backend/lib/` añade:

```markdown
- `backend/lib/rclone.js` — Helpers puros de rclone (env por tipo S3/SFTP, montaje del remoto crypt, args de copy/lsjson/deletefile/lsd/obscure, parseo de lsjson), unit-tested en `backend/test/rclone.test.js`.
- `backend/lib/backupRemote.js` — Ejecutor de rclone: sube/lista/descarga/borra archivos de backup en un remoto (S3/SFTP) leyendo `backup_remote`. Descifra credenciales y las inyecta por env vars del proceso hijo; materializa temporalmente la clave SSH en 0600 si aplica.
```

En la entrada de `routes/backups.js` amplía la descripción (busca la línea de `backups.js`) para reflejar los nuevos endpoints:

```markdown
  - `backups.js` — … (Fase 2) integra destinos remotos vía `lib/backupRemote`: `/remote` (config), `/remote/test`, `/:id/upload`, `/remote/list`, `/remote/:filename/restore`, `DELETE /remote/:filename`. Tras crear un backup con `auto_upload` activo, sube al remoto best-effort. Config remota en la tabla `backup_remote` (credenciales y passphrase cifradas).
```

Si la línea de `backups.js` en CLAUDE.md ya existe con otra redacción, añade una segunda línea con "Fase 2 (destinos remotos)" y el detalle anterior, sin borrar la Fase 1.

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs(backups-remoto): documentar destinos remotos (S3/SFTP) y cifrado en README y CLAUDE"
```

---

## Notas de verificación en VPS (post-implementación)

1. **Instalar `rclone`** desde Plugins.
2. Crear un **bucket** (o un usuario SFTP) de prueba y configurarlo en el panel; pulsar **Probar conexión** — debe salir OK.
3. **Crear un backup manual**: debe aparecer un tramo `☁️ Subiendo al destino remoto...` y el archivo debe estar en el remoto.
4. Activar el **cifrado** y repetir: los nombres del remoto deben quedar cifrados (visibles como aleatorios en `rclone lsjson` sin la passphrase).
5. **Listar** backups remotos y **restaurar** uno: comprobar snapshot pre-restore + restore correcto.
6. Programar backups y esperar a que el cron ejecute: verificar que la **retención remota** borra los `scheduled` antiguos.
7. **Borrar la config** remota: los archivos en el remoto NO se tocan (solo se olvida la config local).
