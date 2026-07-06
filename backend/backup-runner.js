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
