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

  console.log('[backup-runner] completado');
}

main().catch((e) => { console.error('[backup-runner] error:', e.message); process.exit(1); });
