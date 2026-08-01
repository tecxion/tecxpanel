'use strict';
// ============================================================
//  TecXPaneL — lib/backups/cron.js — línea de cron + expiración
// ============================================================

function buildCronLine({ frequency, time, runnerPath, logPath, nodeBin }) {
  const [hh, mm] = String(time).split(':');
  const minute = String(Number(mm));
  const hour = String(Number(hh));
  const dow = frequency === 'weekly' ? '0' : '*';
  return `${minute} ${hour} * * ${dow} ${nodeBin} ${runnerPath} >> ${logPath} 2>&1`;
}

function selectExpiredBackups(rows, retentionDays, now) {
  const cutoff = new Date(now).getTime() - retentionDays * 24 * 60 * 60 * 1000;
  return rows
    .filter((r) => r.origin === 'scheduled' && new Date(r.created_at).getTime() < cutoff)
    .map((r) => r.filename);
}

module.exports = { buildCronLine, selectExpiredBackups };