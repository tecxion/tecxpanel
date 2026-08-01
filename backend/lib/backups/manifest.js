'use strict';
// ============================================================
//  TecXPaneL — lib/backups/manifest.js — helpers puros de manifest + validación
// ============================================================

const BACKUP_DIR = '/opt/txpl/backups';
const RESOURCE_CLASSES = ['db-mysql', 'db-pg', 'site', 'app', 'panel'];

function isValidResourceClass(cls) { return RESOURCE_CLASSES.includes(cls); }

function buildManifest({ kind, items, createdAt }) {
  return { version: 1, created_at: createdAt, kind, items };
}

function parseManifest(text) {
  let m;
  try { m = JSON.parse(text); } catch (_) { throw new Error('manifest inválido'); }
  const okKind = m && (m.kind === 'full' || m.kind === 'resource');
  const okVersion = m && typeof m.version === 'number';
  const okItems = m && Array.isArray(m.items) && m.items.every((it) => isValidResourceClass(it.class));
  if (!okKind || !okVersion || !okItems) throw new Error('manifest inválido');
  return m;
}

function isValidBackupFilename(name) {
  if (typeof name !== 'string') return false;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return false;
  return /^backup-[A-Za-z0-9_.-]+\.tar\.gz$/.test(name);
}

module.exports = { BACKUP_DIR, RESOURCE_CLASSES, isValidResourceClass, buildManifest, parseManifest, isValidBackupFilename };