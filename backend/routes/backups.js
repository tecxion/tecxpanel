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
