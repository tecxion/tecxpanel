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
const { encryptSecret } = require('../lib/crypto');
const remote = require('../lib/backupRemote');

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
    const { host, user, password, keyContent } = b;
    const port = +b.port;
    if (!host || !user || (!password && !keyContent)) return fail(res, 400, 'Credenciales SFTP incompletas.');
    if (!Number.isInteger(port) || port < 1 || port > 65535) return fail(res, 400, 'Puerto SFTP inválido (1-65535).');
    creds = { host, port, user, password: password || null, keyContent: keyContent || null };
  }

  let crypt_pass_enc = null;
  if (encrypt_enabled) {
    const pass = String(b.crypt_pass || '');
    if (pass.length < 8) return fail(res, 400, 'La passphrase de cifrado debe tener al menos 8 caracteres.');
    crypt_pass_enc = encryptSecret(pass);
  }

  // Snapshot de la config actual para poder restaurarla si el test falla.
  const prev = queries.getBackupRemote.get();
  const cfgRow = {
    type, config_enc: encryptSecret(JSON.stringify(creds)),
    remote_path, encrypt_enabled, crypt_pass_enc,
    auto_upload, retention_days, status: 'unconfigured',
  };
  // Guardar temporalmente para que testConnection pueda leerla.
  queries.saveBackupRemote.run(cfgRow);
  const t = await remote.testConnection();
  if (!t.ok) {
    // Restaurar la config anterior; si no había, limpiar.
    if (prev) {
      queries.saveBackupRemote.run({
        type: prev.type, config_enc: prev.config_enc, remote_path: prev.remote_path,
        encrypt_enabled: prev.encrypt_enabled, crypt_pass_enc: prev.crypt_pass_enc,
        auto_upload: prev.auto_upload, retention_days: prev.retention_days, status: prev.status,
      });
    } else {
      queries.clearBackupRemote.run();
    }
    audit(req.user?.username || 'system', clientIp(req), 'backup.remote.config', `${type} error`);
    return fail(res, 502, 'La conexión con el remoto falló: ' + t.message);
  }
  // Éxito: persistir con status 'ok'.
  queries.saveBackupRemote.run({ ...cfgRow, status: 'ok' });
  audit(req.user?.username || 'system', clientIp(req), 'backup.remote.config', `${type} ok`);
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

module.exports = router;
