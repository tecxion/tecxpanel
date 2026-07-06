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
