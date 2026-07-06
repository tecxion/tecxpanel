# Backups Gestionados — Plan de Implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Añadir un módulo de copias de seguridad gestionadas al panel: crear backups completos o por recurso, restaurarlos de forma granular con snapshot de seguridad previo, programarlos por cron del sistema y gestionarlos desde una UI dedicada.

**Architecture:** Motor orquestado desde Node en tres capas: helpers puros y testeables (`lib/backups.js`), ejecutor de efectos en el sistema (`lib/backupEngine.js`) y router HTTP con streaming (`routes/backups.js`). El catálogo y la programación viven en SQLite. El cron del sistema invoca un runner Node (`backup-runner.js`) que reutiliza el mismo motor.

**Tech Stack:** Node.js, Express, better-sqlite3, `execFile` (vía `run`/`runSafe` de `helpers.js`), `tar`/`gzip`/`mysqldump`/`pg_dump`/`sqlite3` del sistema, `node:test`, frontend vanilla JS.

## Global Constraints

- **Idioma español** en UI, comentarios, mensajes de error de API y mensajes de commit (copiado verbatim de CLAUDE.md).
- **Zero shell interpolation**: toda ejecución externa con `execFile`/`run`/`runSafe` pasando **arrays** de argumentos, nunca cadenas interpoladas.
- **Path jail**: descarga/restore/borrado solo dentro de `/opt/txpl/backups`; resolver la ruta y verificar el prefijo antes de tocar el filesystem.
- **Auditoría**: `audit(user, ip, action, detail)` en cada creación, restore, descarga y borrado.
- **Sin secretos hardcodeados**: credenciales (root MySQL) desde `.env` como el resto del código; nada nuevo baked-in.
- **Streaming**: procesos largos usan el centinela `__TXPL_DONE__<code>` y cabeceras `X-Accel-Buffering: no` (patrón de `plugins.js`/`n8n.js`).
- **Tests sin dependencias externas**: `node:test` + `assert`, ejecutables con `node --test`.

---

## File Structure

- `backend/lib/backups.js` — **Crear.** Helpers puros: constantes, manifest, validación de nombres, retención, línea de cron, y constructores de argumentos de comandos (`{cmd, args}`). Sin estado, sin DB, sin `require` del servidor.
- `backend/test/backups.test.js` — **Crear.** Tests unitarios de `lib/backups.js`.
- `backend/lib/backupEngine.js` — **Crear.** Ejecutor: `createBackup`, `restoreItem`, lectura de manifest desde un `.tar.gz`. Usa los helpers puros + `run`/`runSafe` + `queries`.
- `backend/routes/backups.js` — **Crear.** Router `/api/backups`: listar, crear (streaming), restaurar (streaming), descargar, borrar, programar.
- `backend/backup-runner.js` — **Crear.** Script CLI que el cron invoca; lee `backup_schedule` y ejecuta `createBackup` + retención.
- `backend/database.js` — **Modificar.** Tablas `backups` y `backup_schedule` + queries.
- `backend/server.js` — **Modificar.** Montar `app.use('/api/backups', require('./routes/backups'))`.
- `frontend/views/sidebar.html` — **Modificar.** Item de navegación "Copias de seguridad".
- `frontend/views/pages/backups.html` — **Crear.** Plantilla de la página.
- `frontend/index.html` — **Modificar.** `<div class="page" id="page-backups"></div>`.
- `frontend/js/app.js` — **Modificar.** `loadBackups()` y funciones asociadas; registrar la página en `pages` y `navigate()`.
- `README.md` y `CLAUDE.md` — **Modificar.** Documentar el módulo.

---

## Task 1: Helpers puros — manifest, validación, retención, cron

**Files:**
- Create: `backend/lib/backups.js`
- Test: `backend/test/backups.test.js`

**Interfaces:**
- Consumes: nada (módulo base).
- Produces:
  - `BACKUP_DIR = '/opt/txpl/backups'` (string)
  - `RESOURCE_CLASSES = ['db-mysql','db-pg','site','app','panel']` (string[])
  - `isValidResourceClass(cls) → boolean`
  - `buildManifest({ kind, items, createdAt }) → { version:1, created_at, kind, items }` — `kind` ∈ `'full'|'resource'`; `items` es array de `{ class, name, path, size }`.
  - `parseManifest(text) → manifestObject` — lanza `Error('manifest inválido')` si el JSON no tiene `version` numérico, `kind` válido e `items` array con clases válidas.
  - `isValidBackupFilename(name) → boolean` — true solo si casa `/^backup-[A-Za-z0-9_.-]+\.tar\.gz$/` y NO contiene `/`, `\` ni `..`.
  - `buildCronLine({ frequency, time, runnerPath, logPath, nodeBin }) → string` — `frequency` ∈ `'daily'|'weekly'`; `time` `'HH:MM'`.
  - `selectExpiredBackups(rows, retentionDays, now) → string[]` — devuelve `filename` de las filas con `origin === 'scheduled'` cuya `created_at` es anterior a `now - retentionDays` días. Nunca incluye `manual` ni `pre-restore`.

- [ ] **Step 1: Escribir los tests que fallan**

```javascript
// backend/test/backups.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const b = require('../lib/backups');

test('constantes y clases de recurso', () => {
  assert.strictEqual(b.BACKUP_DIR, '/opt/txpl/backups');
  assert.deepStrictEqual(b.RESOURCE_CLASSES, ['db-mysql', 'db-pg', 'site', 'app', 'panel']);
  assert.strictEqual(b.isValidResourceClass('site'), true);
  assert.strictEqual(b.isValidResourceClass('otra'), false);
});

test('buildManifest arma la estructura versionada', () => {
  const m = b.buildManifest({
    kind: 'full',
    createdAt: '2026-07-06T03:00:00Z',
    items: [{ class: 'panel', name: 'panel', path: 'panel/txpl.db', size: 10 }],
  });
  assert.strictEqual(m.version, 1);
  assert.strictEqual(m.kind, 'full');
  assert.strictEqual(m.created_at, '2026-07-06T03:00:00Z');
  assert.strictEqual(m.items.length, 1);
});

test('parseManifest ida y vuelta', () => {
  const original = b.buildManifest({ kind: 'resource', createdAt: 'x', items: [{ class: 'db-mysql', name: 'd', path: 'p', size: 1 }] });
  const parsed = b.parseManifest(JSON.stringify(original));
  assert.deepStrictEqual(parsed, original);
});

test('parseManifest rechaza JSON inválido o clases desconocidas', () => {
  assert.throws(() => b.parseManifest('{}'), /manifest inválido/);
  assert.throws(() => b.parseManifest(JSON.stringify({ version: 1, kind: 'full', items: [{ class: 'malo', name: 'n', path: 'p', size: 1 }] })), /manifest inválido/);
});

test('isValidBackupFilename bloquea traversal', () => {
  assert.strictEqual(b.isValidBackupFilename('backup-2026-07-06_03-00-00.tar.gz'), true);
  assert.strictEqual(b.isValidBackupFilename('../etc/passwd'), false);
  assert.strictEqual(b.isValidBackupFilename('backup-x/../y.tar.gz'), false);
  assert.strictEqual(b.isValidBackupFilename('cosa.txt'), false);
});

test('buildCronLine diario y semanal', () => {
  const daily = b.buildCronLine({ frequency: 'daily', time: '03:30', runnerPath: '/opt/txpl/backend/backup-runner.js', logPath: '/var/log/txpl/backup.log', nodeBin: 'node' });
  assert.strictEqual(daily, '30 3 * * * node /opt/txpl/backend/backup-runner.js >> /var/log/txpl/backup.log 2>&1');
  const weekly = b.buildCronLine({ frequency: 'weekly', time: '05:00', runnerPath: '/r.js', logPath: '/l.log', nodeBin: '/usr/bin/node' });
  assert.strictEqual(weekly, '0 5 * * 0 /usr/bin/node /r.js >> /l.log 2>&1');
});

test('selectExpiredBackups solo caduca los scheduled antiguos', () => {
  const now = new Date('2026-07-10T00:00:00Z');
  const rows = [
    { filename: 'backup-a.tar.gz', origin: 'scheduled', created_at: '2026-07-01T00:00:00Z' }, // 9 días → caduca
    { filename: 'backup-b.tar.gz', origin: 'scheduled', created_at: '2026-07-09T00:00:00Z' }, // 1 día → se queda
    { filename: 'backup-c.tar.gz', origin: 'manual',    created_at: '2026-01-01T00:00:00Z' }, // viejo pero manual → se queda
    { filename: 'backup-d.tar.gz', origin: 'pre-restore', created_at: '2026-01-01T00:00:00Z' }, // pre-restore → se queda
  ];
  assert.deepStrictEqual(b.selectExpiredBackups(rows, 7, now), ['backup-a.tar.gz']);
});
```

- [ ] **Step 2: Ejecutar los tests para verificar que fallan**

Run: `node --test backend/test/backups.test.js`
Expected: FAIL con "Cannot find module '../lib/backups'".

- [ ] **Step 3: Implementar `backend/lib/backups.js`**

```javascript
'use strict';

// ============================================================
//  TecXPaneL — Helpers puros de Backups (Copias de seguridad)
//
//  Funciones sin estado ni dependencias del servidor: manifest,
//  validación de nombres, cálculo de retención, línea de cron y
//  constructores de argumentos de comandos. Testeables en aislado.
// ============================================================

const BACKUP_DIR = '/opt/txpl/backups';
const RESOURCE_CLASSES = ['db-mysql', 'db-pg', 'site', 'app', 'panel'];

function isValidResourceClass(cls) {
  return RESOURCE_CLASSES.includes(cls);
}

// Construye el objeto manifest que va dentro del .tar.gz describiendo su contenido.
function buildManifest({ kind, items, createdAt }) {
  return { version: 1, created_at: createdAt, kind, items };
}

// Parsea y VALIDA un manifest. Lanza si la estructura no es la esperada.
function parseManifest(text) {
  let m;
  try { m = JSON.parse(text); } catch (_) { throw new Error('manifest inválido'); }
  const okKind = m && (m.kind === 'full' || m.kind === 'resource');
  const okVersion = m && typeof m.version === 'number';
  const okItems = m && Array.isArray(m.items) && m.items.every((it) => isValidResourceClass(it.class));
  if (!okKind || !okVersion || !okItems) throw new Error('manifest inválido');
  return m;
}

// Solo permite nombres backup-*.tar.gz sin separadores de ruta ni "..".
function isValidBackupFilename(name) {
  if (typeof name !== 'string') return false;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return false;
  return /^backup-[A-Za-z0-9_.-]+\.tar\.gz$/.test(name);
}

// Devuelve la línea de crontab que ejecuta el runner de backups.
function buildCronLine({ frequency, time, runnerPath, logPath, nodeBin }) {
  const [hh, mm] = String(time).split(':');
  const minute = String(Number(mm));
  const hour = String(Number(hh));
  const dow = frequency === 'weekly' ? '0' : '*';
  return `${minute} ${hour} * * ${dow} ${nodeBin} ${runnerPath} >> ${logPath} 2>&1`;
}

// De un conjunto de filas de backups, decide cuáles caducan por retención.
// Solo caducan los de origen 'scheduled'; nunca manual ni pre-restore.
function selectExpiredBackups(rows, retentionDays, now) {
  const cutoff = new Date(now).getTime() - retentionDays * 24 * 60 * 60 * 1000;
  return rows
    .filter((r) => r.origin === 'scheduled' && new Date(r.created_at).getTime() < cutoff)
    .map((r) => r.filename);
}

module.exports = {
  BACKUP_DIR, RESOURCE_CLASSES, isValidResourceClass,
  buildManifest, parseManifest, isValidBackupFilename,
  buildCronLine, selectExpiredBackups,
};
```

- [ ] **Step 4: Ejecutar los tests para verificar que pasan**

Run: `node --test backend/test/backups.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/lib/backups.js backend/test/backups.test.js
git commit -m "feat(backups): helpers puros (manifest, retención, cron) + tests"
```

---

## Task 2: Constructores de argumentos de comandos (dumps y tar)

**Files:**
- Modify: `backend/lib/backups.js` (añadir funciones + exports)
- Test: `backend/test/backups.test.js` (añadir tests)

**Interfaces:**
- Consumes: nada nuevo.
- Produces (todas devuelven `{ cmd: string, args: string[] }`, listo para `run(cmd, args)`):
  - `mysqldumpArgs(dbName) → { cmd:'mysqldump', args:[...] }` — incluye `--single-transaction`, `--routines`, `--triggers`, `-u root`, `-p<MYSQL_ROOT_PASSWORD>` leído del entorno pasado, y el nombre de BD como último argumento.
  - `pgDumpArgs(dbName) → { cmd:'sudo', args:['-u','postgres','pg_dump', dbName] }`
  - `siteTarArgs(domain, outPath, sitesDir) → { cmd:'tar', args:['-czf', outPath, '-C', sitesDir, domain] }`
  - `appTarArgs(appPath, outPath) → { cmd:'tar', args:['-czf', outPath, '-C', <dirname>, <basename>] }`
  - `packageTarArgs(workDir, outPath) → { cmd:'tar', args:['-czf', outPath, '-C', workDir, '.'] }`
  - `readManifestArgs(archivePath) → { cmd:'tar', args:['-xzOf', archivePath, './manifest.json'] }` (extrae a stdout)
  - `extractMemberArgs(archivePath, memberPath, destDir) → { cmd:'tar', args:['-xzf', archivePath, '-C', destDir, memberPath] }`

- [ ] **Step 1: Añadir los tests que fallan al final de `backend/test/backups.test.js`**

```javascript
test('mysqldumpArgs monta un dump seguro con la BD al final', () => {
  const { cmd, args } = b.mysqldumpArgs('clientea', 'ROOTPW');
  assert.strictEqual(cmd, 'mysqldump');
  assert.ok(args.includes('--single-transaction'));
  assert.ok(args.includes('-u') && args.includes('root'));
  assert.ok(args.includes('-pROOTPW'));
  assert.strictEqual(args[args.length - 1], 'clientea');
});

test('pgDumpArgs usa sudo -u postgres', () => {
  assert.deepStrictEqual(b.pgDumpArgs('clienteb'), { cmd: 'sudo', args: ['-u', 'postgres', 'pg_dump', 'clienteb'] });
});

test('siteTarArgs comprime el directorio del sitio', () => {
  assert.deepStrictEqual(
    b.siteTarArgs('ejemplo.com', '/work/sites/ejemplo.com.tar.gz', '/var/www'),
    { cmd: 'tar', args: ['-czf', '/work/sites/ejemplo.com.tar.gz', '-C', '/var/www', 'ejemplo.com'] }
  );
});

test('appTarArgs separa dirname/basename del path de la app', () => {
  assert.deepStrictEqual(
    b.appTarArgs('/opt/txpl/apps/bot', '/work/apps/bot.tar.gz'),
    { cmd: 'tar', args: ['-czf', '/work/apps/bot.tar.gz', '-C', '/opt/txpl/apps', 'bot'] }
  );
});

test('packageTarArgs empaqueta el directorio de trabajo completo', () => {
  assert.deepStrictEqual(
    b.packageTarArgs('/work', '/out/backup-x.tar.gz'),
    { cmd: 'tar', args: ['-czf', '/out/backup-x.tar.gz', '-C', '/work', '.'] }
  );
});

test('readManifestArgs extrae manifest.json a stdout', () => {
  assert.deepStrictEqual(
    b.readManifestArgs('/out/backup-x.tar.gz'),
    { cmd: 'tar', args: ['-xzOf', '/out/backup-x.tar.gz', './manifest.json'] }
  );
});

test('extractMemberArgs saca un miembro concreto a un destino', () => {
  assert.deepStrictEqual(
    b.extractMemberArgs('/out/backup-x.tar.gz', 'db/mysql/clientea.sql.gz', '/tmp/rest'),
    { cmd: 'tar', args: ['-xzf', '/out/backup-x.tar.gz', '-C', '/tmp/rest', 'db/mysql/clientea.sql.gz'] }
  );
});
```

- [ ] **Step 2: Ejecutar los tests para verificar que fallan**

Run: `node --test backend/test/backups.test.js`
Expected: FAIL con "b.mysqldumpArgs is not a function".

- [ ] **Step 3: Añadir las funciones a `backend/lib/backups.js`** (antes de `module.exports`)

```javascript
const path = require('path');

// Todos devuelven { cmd, args } listos para run(cmd, args). La contraseña de
// MySQL se pasa como argumento explícito (no se interpola en una shell).
function mysqldumpArgs(dbName, rootPassword) {
  return {
    cmd: 'mysqldump',
    args: ['-u', 'root', `-p${rootPassword}`, '--single-transaction', '--routines', '--triggers', dbName],
  };
}

function pgDumpArgs(dbName) {
  return { cmd: 'sudo', args: ['-u', 'postgres', 'pg_dump', dbName] };
}

function siteTarArgs(domain, outPath, sitesDir) {
  return { cmd: 'tar', args: ['-czf', outPath, '-C', sitesDir, domain] };
}

function appTarArgs(appPath, outPath) {
  return { cmd: 'tar', args: ['-czf', outPath, '-C', path.dirname(appPath), path.basename(appPath)] };
}

function packageTarArgs(workDir, outPath) {
  return { cmd: 'tar', args: ['-czf', outPath, '-C', workDir, '.'] };
}

function readManifestArgs(archivePath) {
  return { cmd: 'tar', args: ['-xzOf', archivePath, './manifest.json'] };
}

function extractMemberArgs(archivePath, memberPath, destDir) {
  return { cmd: 'tar', args: ['-xzf', archivePath, '-C', destDir, memberPath] };
}
```

Y añade estos nombres al objeto `module.exports`:

```javascript
  mysqldumpArgs, pgDumpArgs, siteTarArgs, appTarArgs,
  packageTarArgs, readManifestArgs, extractMemberArgs,
```

- [ ] **Step 4: Ejecutar los tests para verificar que pasan**

Run: `node --test backend/test/backups.test.js`
Expected: PASS (14 tests en total).

- [ ] **Step 5: Commit**

```bash
git add backend/lib/backups.js backend/test/backups.test.js
git commit -m "feat(backups): constructores de argumentos de dump/tar + tests"
```

---

## Task 3: Esquema SQLite y queries

**Files:**
- Modify: `backend/database.js` (tablas `backups` y `backup_schedule` + queries)

**Interfaces:**
- Consumes: nada.
- Produces (en el objeto `queries` exportado):
  - `listBackups` → `SELECT * FROM backups ORDER BY created_at DESC`
  - `getBackup` → `SELECT * FROM backups WHERE id = ?`
  - `getBackupByFilename` → `SELECT * FROM backups WHERE filename = ?`
  - `insertBackup` → INSERT con `@filename,@created_at,@size_bytes,@kind,@scope,@origin,@status,@notes`
  - `updateBackupStatus` → `UPDATE backups SET status=@status, size_bytes=@size_bytes, notes=@notes WHERE id=@id`
  - `deleteBackup` → `DELETE FROM backups WHERE id = ?`
  - `getSchedule` → `SELECT * FROM backup_schedule WHERE id = 1`
  - `saveSchedule` → upsert `ON CONFLICT(id)` sobre `backup_schedule`

- [ ] **Step 1: Añadir las tablas al bloque `CREATE TABLE` de `database.js`** (junto a las demás, ej. tras `n8n_config`)

```sql
  CREATE TABLE IF NOT EXISTS backups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    filename    TEXT NOT NULL UNIQUE,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    size_bytes  INTEGER NOT NULL DEFAULT 0,
    kind        TEXT NOT NULL DEFAULT 'full',
    scope       TEXT NOT NULL DEFAULT '[]',
    origin      TEXT NOT NULL DEFAULT 'manual',
    status      TEXT NOT NULL DEFAULT 'running',
    notes       TEXT
  );

  CREATE TABLE IF NOT EXISTS backup_schedule (
    id             INTEGER PRIMARY KEY CHECK (id = 1),
    enabled        INTEGER NOT NULL DEFAULT 0,
    frequency      TEXT NOT NULL DEFAULT 'daily',
    time           TEXT NOT NULL DEFAULT '03:00',
    retention_days INTEGER NOT NULL DEFAULT 7,
    resources      TEXT NOT NULL DEFAULT '[]'
  );
```

- [ ] **Step 2: Añadir las queries al objeto `queries`** (junto a las de `n8n_config`)

```javascript
  // ── Backups ──────────────────────────────────────────────
  listBackups: db.prepare('SELECT * FROM backups ORDER BY created_at DESC'),
  getBackup: db.prepare('SELECT * FROM backups WHERE id = ?'),
  getBackupByFilename: db.prepare('SELECT * FROM backups WHERE filename = ?'),
  insertBackup: db.prepare(`
    INSERT INTO backups (filename, created_at, size_bytes, kind, scope, origin, status, notes)
    VALUES (@filename, @created_at, @size_bytes, @kind, @scope, @origin, @status, @notes)`),
  updateBackupStatus: db.prepare('UPDATE backups SET status = @status, size_bytes = @size_bytes, notes = @notes WHERE id = @id'),
  deleteBackup: db.prepare('DELETE FROM backups WHERE id = ?'),
  getSchedule: db.prepare('SELECT * FROM backup_schedule WHERE id = 1'),
  saveSchedule: db.prepare(`
    INSERT INTO backup_schedule (id, enabled, frequency, time, retention_days, resources)
    VALUES (1, @enabled, @frequency, @time, @retention_days, @resources)
    ON CONFLICT(id) DO UPDATE SET
      enabled = @enabled, frequency = @frequency, time = @time,
      retention_days = @retention_days, resources = @resources`),
```

- [ ] **Step 3: Verificar que el esquema carga y las queries existen**

Run: `node -e "const {queries}=require('./backend/database'); ['listBackups','insertBackup','updateBackupStatus','deleteBackup','getSchedule','saveSchedule'].forEach(k=>{if(!queries[k])throw new Error('falta '+k)}); console.log('OK queries backups')"`
Expected: imprime `OK queries backups` sin errores.

- [ ] **Step 4: Commit**

```bash
git add backend/database.js
git commit -m "feat(backups): tablas backups y backup_schedule + queries"
```

---

## Task 4: Motor de backup y restore (`lib/backupEngine.js`)

**Files:**
- Create: `backend/lib/backupEngine.js`
- Test: `backend/test/backupEngine.test.js`

**Interfaces:**
- Consumes: helpers de Task 1/2 (`buildManifest`, `packageTarArgs`, `readManifestArgs`, `extractMemberArgs`, `siteTarArgs`, `mysqldumpArgs`, etc.); `run`/`runSafe` de `helpers.js`; `queries` de `database.js`.
- Produces:
  - `async createBackup({ items, kind, origin, write }) → { filename, size, id }` — `items` es array de `{ class, name }` a respaldar; `write(text)` es un callback opcional para emitir progreso (streaming). Crea el `.tar.gz` en `BACKUP_DIR`, escribe `manifest.json`, registra en DB (`insertBackup` → `updateBackupStatus`).
  - `async readManifest(filename) → manifestObject` — extrae y parsea `manifest.json` del archivo (usa `isValidBackupFilename` + `parseManifest`).
  - `async restoreItem({ filename, item, write }) → void` — restaura una pieza (`item = { class, name, path }`) desde el archivo; recarga servicios según la clase.
  - `resolveResourceItems(selection) → [{ class, name, path, size }]` — mapea la selección de la UI a items concretos consultando `queries` (sitios, apps, bases de datos, panel).

- [ ] **Step 1: Escribir el test de roundtrip (solo panel, en directorio temporal)**

> Nota: este test crea un backup real de un fichero SQLite de prueba y verifica que el `.tar.gz` contiene el manifest y el fichero. Requiere `tar`/`gzip` (Linux/macOS). Se salta en Windows.

```javascript
// backend/test/backupEngine.test.js
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const isWin = process.platform === 'win32';

test('createBackup(panel) genera un tar.gz con manifest + fichero', { skip: isWin }, async () => {
  const b = require('../lib/backups');
  const { run } = require('../lib/helpers');

  // Directorio temporal que hace de BACKUP_DIR y de fuente del panel.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'txpl-bk-'));
  const workBase = fs.mkdtempSync(path.join(os.tmpdir(), 'txpl-work-'));
  const fakeDb = path.join(workBase, 'txpl.db');
  fs.writeFileSync(fakeDb, 'SQLITE-FAKE');

  // Armamos manualmente el flujo mínimo del motor para el caso 'panel'.
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'txpl-stage-'));
  fs.mkdirSync(path.join(outDir, 'panel'), { recursive: true });
  fs.copyFileSync(fakeDb, path.join(outDir, 'panel', 'txpl.db'));
  const manifest = b.buildManifest({
    kind: 'resource', createdAt: new Date().toISOString(),
    items: [{ class: 'panel', name: 'panel', path: 'panel/txpl.db', size: fs.statSync(fakeDb).size }],
  });
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest));

  const archive = path.join(tmp, 'backup-test.tar.gz');
  const pkg = b.packageTarArgs(outDir, archive);
  await run(pkg.cmd, pkg.args);
  assert.ok(fs.existsSync(archive), 'el archivo se creó');

  // Leemos el manifest de vuelta desde el tar.
  const rm = b.readManifestArgs(archive);
  const out = await run(rm.cmd, rm.args);
  const parsed = b.parseManifest(out);
  assert.strictEqual(parsed.items[0].class, 'panel');

  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(workBase, { recursive: true, force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Ejecutar el test para verificar que falla (o se salta en Windows)**

Run: `node --test backend/test/backupEngine.test.js`
Expected en Linux/macOS: FAIL si `packageTarArgs`/`readManifestArgs` no existieran; como ya existen (Task 2), este test valida el flujo tar real y debe **PASAR** una vez `run` esté disponible. Si falla por `tar`, revisar que esté instalado.

> Este test no depende de `backupEngine.js` todavía (valida los helpers + tar reales). Sirve de red antes de escribir el motor. Confirma que pasa antes de seguir.

- [ ] **Step 3: Implementar `backend/lib/backupEngine.js`**

```javascript
'use strict';

// ============================================================
//  TecXPaneL — Motor de Backups (efectos en el sistema)
//
//  Orquesta la creación y restauración de copias apoyándose en
//  los helpers puros de lib/backups.js y en run()/runSafe().
//  Registra cada backup en la tabla `backups`.
// ============================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { run, runSafe } = require('./helpers');
const { queries } = require('../database');
const nginx = require('./nginx');
const B = require('./backups');

// Ejecuta un comando pasándole datos por STDIN. Necesario porque execFile (y por
// tanto run()) no admite la opción `input`; aquí usamos spawn y escribimos a stdin.
function runInput(cmd, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args);
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr || `${cmd} salió con código ${code}`))));
    child.stdin.write(input);
    child.stdin.end();
  });
}

const SITES_DIR = path.resolve(process.env.SITES_DIR || '/var/www');
const PANEL_DB = path.resolve(process.env.TXPL_DIR || '/opt/txpl', 'data', 'txpl.db');
const PANEL_ENV = path.resolve(process.env.TXPL_DIR || '/opt/txpl', '.env');

function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}
const emit = (write, msg) => { if (write) write(msg + '\n'); };

// Mapea la selección de la UI a items concretos con su ruta interna en el tar.
function resolveResourceItems(selection) {
  const items = [];
  for (const sel of selection) {
    if (sel.class === 'db-mysql') items.push({ class: 'db-mysql', name: sel.name, path: `db/mysql/${sel.name}.sql.gz`, size: 0 });
    else if (sel.class === 'db-pg') items.push({ class: 'db-pg', name: sel.name, path: `db/pg/${sel.name}.sql.gz`, size: 0 });
    else if (sel.class === 'site') items.push({ class: 'site', name: sel.name, path: `sites/${sel.name}.tar.gz`, size: 0 });
    else if (sel.class === 'app') {
      const app = queries.listApps.all().find((a) => a.name === sel.name);
      items.push({ class: 'app', name: sel.name, path: `apps/${sel.name}.tar.gz`, size: 0, _appPath: app && app.path });
    } else if (sel.class === 'panel') items.push({ class: 'panel', name: 'panel', path: 'panel/txpl.db', size: 0 });
  }
  return items;
}

// Vuelca una pieza al directorio de staging. Devuelve el tamaño en bytes.
async function dumpItem(item, stageDir, write) {
  const dest = path.join(stageDir, item.path);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (item.class === 'db-mysql') {
    emit(write, `🐬 MySQL: ${item.name}`);
    const { cmd, args } = B.mysqldumpArgs(item.name, process.env.MYSQL_ROOT_PASSWORD || '');
    const out = await run(cmd, args, { maxBuffer: 512 * 1024 * 1024 });
    fs.writeFileSync(dest, require('zlib').gzipSync(Buffer.from(out)));
  } else if (item.class === 'db-pg') {
    emit(write, `🐘 PostgreSQL: ${item.name}`);
    const { cmd, args } = B.pgDumpArgs(item.name);
    const out = await run(cmd, args, { maxBuffer: 512 * 1024 * 1024 });
    fs.writeFileSync(dest, require('zlib').gzipSync(Buffer.from(out)));
  } else if (item.class === 'site') {
    emit(write, `🌐 Sitio: ${item.name}`);
    const { cmd, args } = B.siteTarArgs(item.name, dest, SITES_DIR);
    await run(cmd, args, { maxBuffer: 64 * 1024 * 1024 });
  } else if (item.class === 'app') {
    emit(write, `📦 App: ${item.name}`);
    if (!item._appPath || !fs.existsSync(item._appPath)) throw new Error(`No se encontró el directorio de la app ${item.name}`);
    const { cmd, args } = B.appTarArgs(item._appPath, dest);
    await run(cmd, args, { maxBuffer: 64 * 1024 * 1024 });
  } else if (item.class === 'panel') {
    emit(write, '📋 Config del panel');
    await runSafe('sqlite3', [PANEL_DB, `.backup ${dest}`]);
    if (!fs.existsSync(dest)) fs.copyFileSync(PANEL_DB, dest);
    if (fs.existsSync(PANEL_ENV)) fs.copyFileSync(PANEL_ENV, path.join(path.dirname(dest), 'txpl.env'));
  }
  return fs.existsSync(dest) ? fs.statSync(dest).size : 0;
}

// Crea un backup con las piezas indicadas. Registra la fila en `backups`.
async function createBackup({ items, kind, origin = 'manual', write }) {
  fs.mkdirSync(B.BACKUP_DIR, { recursive: true });
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'txpl-bk-'));
  const filename = `backup-${ts()}.tar.gz`;
  const archive = path.join(B.BACKUP_DIR, filename);
  const createdAt = new Date().toISOString();

  const row = { filename, created_at: createdAt, size_bytes: 0, kind, scope: JSON.stringify(items.map((i) => ({ class: i.class, name: i.name }))), origin, status: 'running', notes: null };
  const info = queries.insertBackup.run(row);
  const id = info.lastInsertRowid;

  try {
    const resolved = resolveResourceItems(items);
    for (const it of resolved) it.size = await dumpItem(it, stageDir, write);
    const manifest = B.buildManifest({ kind, createdAt, items: resolved.map(({ _appPath, ...rest }) => rest) });
    fs.writeFileSync(path.join(stageDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    const pkg = B.packageTarArgs(stageDir, archive);
    await run(pkg.cmd, pkg.args, { maxBuffer: 64 * 1024 * 1024 });
    const size = fs.statSync(archive).size;
    queries.updateBackupStatus.run({ id, status: 'ok', size_bytes: size, notes: null });
    emit(write, `✅ Backup completado: ${filename}`);
    return { filename, size, id };
  } catch (e) {
    queries.updateBackupStatus.run({ id, status: 'failed', size_bytes: 0, notes: e.message });
    emit(write, `❌ Error: ${e.message}`);
    throw e;
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

// Lee y valida el manifest de un backup existente.
async function readManifest(filename) {
  if (!B.isValidBackupFilename(filename)) throw new Error('Nombre de backup inválido');
  const archive = path.join(B.BACKUP_DIR, filename);
  if (!fs.existsSync(archive)) throw new Error('Backup no encontrado');
  const { cmd, args } = B.readManifestArgs(archive);
  const out = await run(cmd, args);
  return B.parseManifest(out);
}

// Restaura una pieza concreta desde un backup. Recarga servicios según la clase.
async function restoreItem({ filename, item, write }) {
  if (!B.isValidBackupFilename(filename)) throw new Error('Nombre de backup inválido');
  const archive = path.join(B.BACKUP_DIR, filename);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'txpl-restore-'));
  try {
    const ex = B.extractMemberArgs(archive, item.path, tmp);
    await run(ex.cmd, ex.args, { maxBuffer: 64 * 1024 * 1024 });
    const extracted = path.join(tmp, item.path);

    if (item.class === 'db-mysql') {
      emit(write, `🐬 Restaurando MySQL: ${item.name}`);
      const sql = require('zlib').gunzipSync(fs.readFileSync(extracted)).toString();
      await runInput('mysql', ['-u', 'root', `-p${process.env.MYSQL_ROOT_PASSWORD || ''}`, item.name], sql);
    } else if (item.class === 'db-pg') {
      emit(write, `🐘 Restaurando PostgreSQL: ${item.name}`);
      const sql = require('zlib').gunzipSync(fs.readFileSync(extracted)).toString();
      await runInput('sudo', ['-u', 'postgres', 'psql', '-d', item.name], sql);
    } else if (item.class === 'site') {
      emit(write, `🌐 Restaurando sitio: ${item.name}`);
      await run('tar', ['-xzf', extracted, '-C', SITES_DIR], { maxBuffer: 64 * 1024 * 1024 });
      await nginx.reload();
    } else if (item.class === 'app') {
      emit(write, `📦 Restaurando app: ${item.name}`);
      const app = queries.listApps.all().find((a) => a.name === item.name);
      if (!app || !app.path) throw new Error(`La app ${item.name} no existe en el panel`);
      await run('tar', ['-xzf', extracted, '-C', path.dirname(app.path)], { maxBuffer: 64 * 1024 * 1024 });
      await runSafe('pm2', ['restart', app.pm2_name]);
    } else if (item.class === 'panel') {
      emit(write, '📋 Restaurando config del panel');
      fs.copyFileSync(extracted, PANEL_DB);
    }
    emit(write, '✅ Restauración completada');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { createBackup, readManifest, restoreItem, resolveResourceItems };
```

- [ ] **Step 4: Verificar que `require` carga el motor sin errores**

Run: `node -e "require('./backend/lib/backupEngine'); console.log('engine OK')"`
Expected: imprime `engine OK`.

- [ ] **Step 5: Ejecutar toda la batería de tests**

Run: `node --test backend/test/`
Expected: PASS (los 14 de `backups.test.js` + el roundtrip de `backupEngine.test.js` en Linux/macOS).

- [ ] **Step 6: Commit**

```bash
git add backend/lib/backupEngine.js backend/test/backupEngine.test.js
git commit -m "feat(backups): motor de creación y restore granular con manifest"
```

---

## Task 5: Router `/api/backups` + montaje

**Files:**
- Create: `backend/routes/backups.js`
- Modify: `backend/server.js` (montar el router tras `/api/n8n`)

**Interfaces:**
- Consumes: `createBackup`, `readManifest`, `restoreItem` (Task 4); `queries`, `audit` (Task 3); `run`/`runSafe`/`ok`/`fail`/`clientIp`/`wrap` (`helpers.js`); `buildCronLine`/`selectExpiredBackups`/`isValidBackupFilename`/`BACKUP_DIR` (Task 1).
- Produces (endpoints REST, todos bajo `/api/backups`, JWT ya aplicado en `server.js`):
  - `GET /` → `{ backups: [...], schedule: {...} }`
  - `GET /resources` → recursos disponibles para respaldar `{ databases, sites, apps }`
  - `POST /` (streaming) → crea backup. Body `{ kind, resources:[{class,name}] }`.
  - `GET /:id/manifest` → manifest de un backup.
  - `POST /:id/restore` (streaming) → body `{ items:[{class,name,path}], safety:true }`.
  - `GET /:id/download` → descarga el `.tar.gz`.
  - `DELETE /:id` → borra archivo + fila.
  - `POST /schedule` → guarda `backup_schedule` y reescribe la línea de cron.

- [ ] **Step 1: Implementar `backend/routes/backups.js`**

```javascript
'use strict';

// ============================================================
//  TecXPaneL — Backups (Copias de seguridad)
//  Crea/restaura/programa copias apoyándose en lib/backupEngine.
// ============================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { ok, fail, clientIp, run, runSafe, wrap } = require('../lib/helpers');
const { queries, audit } = require('../database');
const B = require('../lib/backups');
const engine = require('../lib/backupEngine');

const router = express.Router();
const RUNNER_PATH = path.resolve(process.env.TXPL_DIR || '/opt/txpl', 'backend', 'backup-runner.js');
const LOG_PATH = '/var/log/txpl/backup.log';

// Cabeceras de streaming (mismo patrón que plugins.js/n8n.js).
function startStream(res) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
}

// ── Listado + programación ───────────────────────────────────
router.get('/', (req, res) => {
  const backups = queries.listBackups.all();
  const schedule = queries.getSchedule.get() || { enabled: 0, frequency: 'daily', time: '03:00', retention_days: 7, resources: '[]' };
  ok(res, { backups, schedule });
});

// ── Recursos disponibles para respaldar ──────────────────────
router.get('/resources', (req, res) => {
  const dbs = queries.listDatabases.all().map((d) => ({ class: d.type === 'postgresql' ? 'db-pg' : 'db-mysql', name: d.name }));
  const sites = queries.listWebsites.all().map((w) => ({ class: 'site', name: w.domain }));
  const apps = queries.listApps.all().map((a) => ({ class: 'app', name: a.name }));
  ok(res, { databases: dbs, sites, apps, panel: [{ class: 'panel', name: 'panel' }] });
});

// ── Crear backup (streaming) ─────────────────────────────────
router.post('/', (req, res) => {
  const { kind = 'full', resources = [] } = req.body || {};
  const items = Array.isArray(resources) ? resources.filter((r) => B.isValidResourceClass(r.class)) : [];
  if (!items.length) return fail(res, 400, 'No hay recursos válidos que respaldar');
  audit(req.user?.username || 'system', clientIp(req), 'backup.create', `${kind} (${items.length} piezas)`);
  startStream(res);
  engine.createBackup({ items, kind, origin: 'manual', write: (t) => res.write(t) })
    .then(() => res.end('\n__TXPL_DONE__0'))
    .catch(() => res.end('\n__TXPL_DONE__1'));
});

// ── Manifest de un backup ────────────────────────────────────
router.get('/:id/manifest', wrap(async (req, res) => {
  const row = queries.getBackup.get(+req.params.id);
  if (!row) return fail(res, 404, 'Backup no encontrado');
  const manifest = await engine.readManifest(row.filename);
  ok(res, { manifest });
}));

// ── Restaurar (streaming), con snapshot de seguridad ─────────
router.post('/:id/restore', wrap(async (req, res) => {
  const row = queries.getBackup.get(+req.params.id);
  if (!row) return fail(res, 404, 'Backup no encontrado');
  const { items = [] } = req.body || {};
  const valid = Array.isArray(items) ? items.filter((i) => B.isValidResourceClass(i.class) && i.path) : [];
  if (!valid.length) return fail(res, 400, 'No hay piezas válidas que restaurar');
  audit(req.user?.username || 'system', clientIp(req), 'backup.restore', `${row.filename} (${valid.length} piezas)`);
  startStream(res);
  try {
    res.write('🛟 Creando snapshot de seguridad antes de restaurar...\n');
    await engine.createBackup({ items: valid.map((i) => ({ class: i.class, name: i.name })), kind: 'resource', origin: 'pre-restore', write: (t) => res.write(t) });
    for (const it of valid) await engine.restoreItem({ filename: row.filename, item: it, write: (t) => res.write(t) });
    res.end('\n__TXPL_DONE__0');
  } catch (e) {
    res.write(`\n❌ ${e.message}\n`);
    res.end('\n__TXPL_DONE__1');
  }
}));

// ── Descargar ────────────────────────────────────────────────
router.get('/:id/download', (req, res) => {
  const row = queries.getBackup.get(+req.params.id);
  if (!row || !B.isValidBackupFilename(row.filename)) return fail(res, 404, 'Backup no encontrado');
  const file = path.join(B.BACKUP_DIR, row.filename);
  if (!file.startsWith(B.BACKUP_DIR + path.sep) || !fs.existsSync(file)) return fail(res, 404, 'Archivo no encontrado');
  res.download(file, row.filename);
});

// ── Borrar ───────────────────────────────────────────────────
router.delete('/:id', wrap(async (req, res) => {
  const row = queries.getBackup.get(+req.params.id);
  if (!row) return fail(res, 404, 'Backup no encontrado');
  if (B.isValidBackupFilename(row.filename)) {
    const file = path.join(B.BACKUP_DIR, row.filename);
    if (file.startsWith(B.BACKUP_DIR + path.sep) && fs.existsSync(file)) fs.unlinkSync(file);
  }
  queries.deleteBackup.run(row.id);
  audit(req.user?.username || 'system', clientIp(req), 'backup.delete', row.filename);
  ok(res);
}));

// ── Programación (escribe crontab) ───────────────────────────
router.post('/schedule', wrap(async (req, res) => {
  const { enabled = 0, frequency = 'daily', time = '03:00', retention_days = 7, resources = [] } = req.body || {};
  if (!['daily', 'weekly'].includes(frequency)) return fail(res, 400, 'Frecuencia inválida');
  if (!/^\d{2}:\d{2}$/.test(time)) return fail(res, 400, 'Hora inválida (HH:MM)');
  queries.saveSchedule.run({ enabled: enabled ? 1 : 0, frequency, time, retention_days: +retention_days || 7, resources: JSON.stringify(resources) });

  // Reescribe la línea de cron: elimina la anterior y añade la nueva si está activa.
  // Instalamos vía fichero temporal (`crontab <file>`) para no depender de stdin.
  const current = await runSafe('crontab', ['-l']);
  const lines = (current.stdout || '').split('\n').filter((l) => l && !l.includes('backup-runner.js'));
  if (enabled) lines.push(B.buildCronLine({ frequency, time, runnerPath: RUNNER_PATH, logPath: LOG_PATH, nodeBin: process.execPath }));
  const tmpCron = path.join(os.tmpdir(), `txpl-cron-${Date.now()}`);
  fs.writeFileSync(tmpCron, lines.join('\n') + '\n');
  try { await run('crontab', [tmpCron]); } finally { fs.rmSync(tmpCron, { force: true }); }
  audit(req.user?.username || 'system', clientIp(req), 'backup.schedule', enabled ? `${frequency} ${time}` : 'desactivado');
  ok(res, { enabled: !!enabled });
}));

module.exports = router;
```

- [ ] **Step 2: Montar el router en `backend/server.js`** (tras la línea de `/api/n8n`)

```javascript
app.use('/api/backups', require('./routes/backups'));
```

- [ ] **Step 3: Verificar que el servidor carga el router sin errores**

Run: `node -e "process.env.JWT_SECRET='x'.repeat(40); require('./backend/routes/backups'); console.log('router backups OK')"`
Expected: imprime `router backups OK`.

- [ ] **Step 4: Commit**

```bash
git add backend/routes/backups.js backend/server.js
git commit -m "feat(backups): router /api/backups (crear/restaurar/descargar/programar)"
```

---

## Task 6: Runner de cron (`backup-runner.js`)

**Files:**
- Create: `backend/backup-runner.js`

**Interfaces:**
- Consumes: `queries` (Task 3), `createBackup` (Task 4), `selectExpiredBackups`/`BACKUP_DIR`/`isValidBackupFilename` (Task 1).
- Produces: script ejecutable `node backend/backup-runner.js` que lee `backup_schedule`, hace el backup programado y aplica retención.

- [ ] **Step 1: Implementar `backend/backup-runner.js`**

```javascript
'use strict';

// ============================================================
//  TecXPaneL — Runner de backups programados (lo invoca cron)
//  Lee backup_schedule, crea el backup con origin='scheduled' y
//  borra los backups programados que superan la retención.
// ============================================================

const fs = require('fs');
const path = require('path');
const { queries } = require('./database');
const { createBackup } = require('./lib/backupEngine');
const B = require('./lib/backups');

async function main() {
  const sched = queries.getSchedule.get();
  if (!sched || !sched.enabled) { console.log('[backup-runner] programación desactivada'); return; }

  const resources = JSON.parse(sched.resources || '[]').filter((r) => B.isValidResourceClass(r.class));
  if (!resources.length) { console.log('[backup-runner] sin recursos configurados'); return; }

  console.log(`[backup-runner] iniciando backup programado (${resources.length} piezas)`);
  await createBackup({ items: resources, kind: 'full', origin: 'scheduled', write: (t) => process.stdout.write(t) });

  // Retención: borra los backups scheduled más antiguos que retention_days.
  const rows = queries.listBackups.all();
  const expired = B.selectExpiredBackups(rows, sched.retention_days, new Date());
  for (const filename of expired) {
    if (!B.isValidBackupFilename(filename)) continue;
    const file = path.join(B.BACKUP_DIR, filename);
    if (file.startsWith(B.BACKUP_DIR + path.sep) && fs.existsSync(file)) fs.unlinkSync(file);
    const row = queries.getBackupByFilename.get(filename);
    if (row) queries.deleteBackup.run(row.id);
    console.log(`[backup-runner] retención: borrado ${filename}`);
  }
  console.log('[backup-runner] completado');
}

main().catch((e) => { console.error('[backup-runner] error:', e.message); process.exit(1); });
```

- [ ] **Step 2: Verificar que carga sin errores de sintaxis**

Run: `node --check backend/backup-runner.js && echo "sintaxis OK"`
Expected: imprime `sintaxis OK`.

- [ ] **Step 3: Commit**

```bash
git add backend/backup-runner.js
git commit -m "feat(backups): runner de cron para backups programados + retención"
```

---

## Task 7: Frontend — sección "Copias de seguridad"

**Files:**
- Modify: `frontend/views/sidebar.html` (item de navegación)
- Create: `frontend/views/pages/backups.html`
- Modify: `frontend/index.html` (contenedor de página)
- Modify: `frontend/js/app.js` (`pages`, `navigate`, `loadBackups` y acciones)

**Interfaces:**
- Consumes: endpoints de Task 5; helpers frontend existentes `req()`, `esc()`, patrón de consola de streaming.
- Produces: `loadBackups()`, `backupNow(kind)`, `backupRestore(id)`, `backupDownload(id)`, `backupDelete(id)`, `saveBackupSchedule()`.

- [ ] **Step 1: Añadir el item al sidebar** (`frontend/views/sidebar.html`, tras el de Workflows)

```html
<div class="nav-item" data-page="backups" onclick="navigate(this)"><i class="ti ti-database-export"></i> Copias de seguridad</div>
```

- [ ] **Step 2: Añadir el contenedor de página** (`frontend/index.html`, junto a los demás `page-*`)

```html
<div class="page" id="page-backups"></div>
```

- [ ] **Step 3: Crear la plantilla** `frontend/views/pages/backups.html`

```html
<div class="page-header">
  <h1><i class="ti ti-database-export"></i> Copias de seguridad</h1>
  <div class="page-actions">
    <button class="btn btn-primary" onclick="backupNow('full')"><i class="ti ti-player-record"></i> Backup ahora</button>
  </div>
</div>

<div class="card" id="backups-schedule">
  <h3><i class="ti ti-clock"></i> Programación</h3>
  <div class="form-row">
    <label><input type="checkbox" id="bk-enabled"> Activar backups automáticos</label>
  </div>
  <div class="form-row">
    <select id="bk-frequency"><option value="daily">Diario</option><option value="weekly">Semanal</option></select>
    <input type="time" id="bk-time" value="03:00">
    <label>Retención (días): <input type="number" id="bk-retention" value="7" min="1" style="width:70px"></label>
  </div>
  <button class="btn" onclick="saveBackupSchedule()"><i class="ti ti-device-floppy"></i> Guardar programación</button>
</div>

<div class="card">
  <h3><i class="ti ti-archive"></i> Backups disponibles</h3>
  <div id="backups-list">Cargando…</div>
</div>

<div class="console" id="backups-console" style="display:none"></div>
```

- [ ] **Step 4: Registrar la página en `loadTemplates` y `navigate`** (`frontend/js/app.js`)

En el array `pages` de `loadTemplates()` añade `'backups'`. En `navigate()` añade:

```javascript
  if (page === 'backups') loadBackups();
```

- [ ] **Step 5: Implementar las funciones** (`frontend/js/app.js`, junto a las de otras secciones)

```javascript
async function loadBackups() {
  const data = await req('GET', '/backups');
  if (!data) return;
  const s = data.schedule || {};
  document.getElementById('bk-enabled').checked = !!s.enabled;
  document.getElementById('bk-frequency').value = s.frequency || 'daily';
  document.getElementById('bk-time').value = s.time || '03:00';
  document.getElementById('bk-retention').value = s.retention_days || 7;

  const list = document.getElementById('backups-list');
  if (!data.backups.length) { list.innerHTML = '<p class="muted">Aún no hay copias de seguridad.</p>'; return; }
  list.innerHTML = '<table class="table"><thead><tr><th>Fecha</th><th>Tipo</th><th>Origen</th><th>Tamaño</th><th>Estado</th><th></th></tr></thead><tbody>' +
    data.backups.map((b) => `<tr>
      <td>${esc(b.created_at)}</td>
      <td>${esc(b.kind)}</td>
      <td>${esc(b.origin)}</td>
      <td>${fmtBytes(b.size_bytes)}</td>
      <td>${esc(b.status)}</td>
      <td>
        <button class="btn btn-sm" onclick="backupRestore(${b.id})"><i class="ti ti-restore"></i></button>
        <button class="btn btn-sm" onclick="backupDownload(${b.id})"><i class="ti ti-download"></i></button>
        <button class="btn btn-sm btn-danger" onclick="backupDelete(${b.id})"><i class="ti ti-trash"></i></button>
      </td></tr>`).join('') + '</tbody></table>';
}

// Helper de streaming reutilizable (mismo patrón que n8nInstall): hace POST,
// lee el cuerpo por chunks y vuelca a la consola hasta el centinela __TXPL_DONE__.
async function streamConsole(path, body, el) {
  const DONE = '__TXPL_DONE__';
  const r = await fetch(API + '/api' + path, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.status === 401) { doLogout(); return 1; }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buffer = '', exitCode = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });
    let display = buffer;
    const idx = buffer.indexOf(DONE);
    if (idx >= 0) { exitCode = parseInt(buffer.slice(idx + DONE.length).trim(), 10) || 0; display = buffer.slice(0, idx); }
    el.textContent = display; el.scrollTop = el.scrollHeight;
  }
  return exitCode;
}

async function backupNow(kind) {
  const r = await req('GET', '/backups/resources');
  if (!r) return;
  const all = [...r.databases, ...r.sites, ...r.apps, ...r.panel];
  const con = document.getElementById('backups-console');
  con.style.display = 'block'; con.textContent = '';
  await streamConsole('/backups', { kind, resources: all }, con);
  loadBackups();
}

async function backupRestore(id) {
  const m = await req('GET', `/backups/${id}/manifest`);
  if (!m) return;
  if (!confirm('Se creará un snapshot de seguridad y luego se restaurará el backup completo. ¿Continuar?')) return;
  const con = document.getElementById('backups-console');
  con.style.display = 'block'; con.textContent = '';
  await streamConsole(`/backups/${id}/restore`, { items: m.manifest.items }, con);
  loadBackups();
}

async function backupDownload(id) {
  // El middleware de auth solo acepta el header Authorization: Bearer, así que
  // descargamos con fetch (enviando el token) y forzamos la descarga vía blob.
  const res = await fetch(`${API}/api/backups/${id}/download`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) { alert('No se pudo descargar el backup'); return; }
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') || '';
  const name = (cd.match(/filename="?([^"]+)"?/) || [])[1] || 'backup.tar.gz';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click();
  a.remove(); URL.revokeObjectURL(url);
}

async function backupDelete(id) {
  if (!confirm('¿Borrar esta copia de seguridad?')) return;
  await req('DELETE', `/backups/${id}`);
  loadBackups();
}

async function saveBackupSchedule() {
  const body = {
    enabled: document.getElementById('bk-enabled').checked ? 1 : 0,
    frequency: document.getElementById('bk-frequency').value,
    time: document.getElementById('bk-time').value,
    retention_days: +document.getElementById('bk-retention').value,
    resources: [{ class: 'panel', name: 'panel' }],
  };
  const r = await req('POST', '/backups/schedule', body);
  if (r) alert('Programación guardada');
}
```

> **Nota:** `req()`, `esc()`, `fmtBytes()`, `doLogout()`, la constante `API` (= `window.location.origin`) y la global `TOKEN` ya existen en `app.js`. `req` antepone `/api` a la ruta; para los `fetch` directos (streaming y descarga) hay que escribir `API + '/api' + path` explícitamente, como en `n8nInstall()`. El helper `streamConsole()` se añade en este mismo paso (no existía antes) y encapsula el patrón de lectura por chunks con el centinela `__TXPL_DONE__`.

- [ ] **Step 6: Verificación manual en el navegador**

Arranca `npm run dev`, entra en la sección "Copias de seguridad": debe cargar la programación, listar (vacío al principio) y el botón "Backup ahora" debe abrir la consola de streaming. En local (no-Linux) los dumps de MySQL/PG fallarán de forma controlada, pero el backup del panel (`panel`) debe generarse.

- [ ] **Step 7: Commit**

```bash
git add frontend/views/sidebar.html frontend/views/pages/backups.html frontend/index.html frontend/js/app.js
git commit -m "feat(backups): sección Copias de seguridad en el frontend"
```

---

## Task 8: Documentación (README + CLAUDE.md)

**Files:**
- Modify: `README.md` (bullet de característica + sección dedicada)
- Modify: `CLAUDE.md` (router `backups.js`, `lib/backups.js`, `lib/backupEngine.js`, `backup-runner.js`)

- [ ] **Step 1: Añadir el bullet de característica en README** (en "🚀 Características Principales", tras Monitorización)

```markdown
- 💾 **Copias de Seguridad Gestionadas**: Crea backups completos o por recurso (bases de datos, sitios, apps, config del panel) desde la UI, con **restauración granular** y **snapshot de seguridad automático** antes de sobrescribir. Programación por cron (diario/semanal + retención) y descarga directa del `.tar.gz`.
```

- [ ] **Step 2: Añadir la sección dedicada en README** (tras la sección de n8n)

```markdown
---

## 💾 Copias de Seguridad

TecXPaneL gestiona las copias desde el panel, con restauración granular estilo Plesk.

**Qué puedes respaldar (junto o por separado):**

- **Bases de datos** MySQL/PostgreSQL (dump individual por BD).
- **Sitios web** de `/var/www` con su configuración.
- **Aplicaciones** (código + `.env` + PM2).
- **Config del panel** (base de datos SQLite + `.env`).

**Flujo de uso:**

1.  Pulsa **Backup ahora** para un snapshot completo, o respalda un recurso concreto.
2.  Cada backup se guarda como `.tar.gz` con un `manifest.json` que describe su contenido.
3.  Para **restaurar**, elige todo el backup o una pieza suelta: el panel crea primero un **snapshot de seguridad** de lo que va a sobrescribir y luego aplica la restauración.
4.  Configura la **programación** (diario/semanal, hora y retención): el panel instala una tarea de cron que ejecuta el backup automáticamente.

> [!NOTE]
> En la v1 los destinos son **local** (`/opt/txpl/backups`) y **descarga manual**. Los destinos remotos (S3/SFTP) llegarán en una versión posterior.
```

- [ ] **Step 3: Actualizar CLAUDE.md** (en la lista de `backend/routes/` y `backend/lib/`)

Añade a la lista de routers:

```markdown
  - `backups.js` — Copias de seguridad gestionadas. Crea backups completos o por recurso (bases de datos, sitios, apps, config del panel), los cataloga en la tabla `backups`, restaura piezas sueltas desde el `manifest.json` con snapshot de seguridad previo (`origin='pre-restore'`), y programa backups por cron (`backup_schedule` + `backup-runner.js`). Streaming con el centinela `__TXPL_DONE__`. Helpers puros en `lib/backups.js`, motor en `lib/backupEngine.js`.
```

Añade a la lista de `lib/`:

```markdown
- `backend/lib/backups.js` — Helpers puros de backups (manifest, validación de nombres, retención, línea de cron, constructores de argumentos de dump/tar), unit-tested en `backend/test/backups.test.js`.
- `backend/lib/backupEngine.js` — Motor de backups: `createBackup`, `restoreItem`, `readManifest`. Usa los helpers puros + `run`/`runSafe` + `queries`.
```

- [ ] **Step 4: Commit**

```bash
git add README.md CLAUDE.md
git commit -m "docs(backups): documentar copias de seguridad gestionadas en README y CLAUDE"
```

---

## Notas de verificación en VPS (post-implementación)

Tras desplegar en el VPS (fuera del alcance del código, para QA manual):

1. `npm run dev` local: la sección carga, el backup de `panel` se genera, y programar escribe la config.
2. En VPS: backup completo real (MySQL/PG/sitios/apps), verificar el `.tar.gz` y su `manifest.json`.
3. Restaurar una BD de prueba y confirmar el snapshot `pre-restore` en el catálogo.
4. Activar la programación y comprobar `crontab -l` (línea con `backup-runner.js`) y `/var/log/txpl/backup.log` tras el corte.
5. Confirmar que la retención borra solo los `scheduled` antiguos.
