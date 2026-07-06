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
