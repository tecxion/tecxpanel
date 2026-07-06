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
