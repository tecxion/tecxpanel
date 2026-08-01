'use strict';

// queries/backups.js — catálogo de backups + programación + destino remoto.
const { db } = require('../client');

module.exports = {
  // Backups gestionados
  listBackups:          db.prepare('SELECT * FROM backups ORDER BY created_at DESC'),
  getBackup:            db.prepare('SELECT * FROM backups WHERE id = ?'),
  getBackupByFilename:  db.prepare('SELECT * FROM backups WHERE filename = ?'),
  insertBackup:         db.prepare(`
    INSERT INTO backups (filename, created_at, size_bytes, kind, scope, origin, status, notes)
    VALUES (@filename, @created_at, @size_bytes, @kind, @scope, @origin, @status, @notes)`),
  updateBackupStatus:   db.prepare('UPDATE backups SET status = @status, size_bytes = @size_bytes, notes = @notes WHERE id = @id'),
  deleteBackup:         db.prepare('DELETE FROM backups WHERE id = ?'),
  // Programación (fila única id=1)
  getSchedule:          db.prepare('SELECT * FROM backup_schedule WHERE id = 1'),
  saveSchedule:         db.prepare(`
    INSERT INTO backup_schedule (id, enabled, frequency, time, retention_days, resources)
    VALUES (1, @enabled, @frequency, @time, @retention_days, @resources)
    ON CONFLICT(id) DO UPDATE SET
      enabled = @enabled, frequency = @frequency, time = @time,
      retention_days = @retention_days, resources = @resources`),
  // Destino remoto S3/SFTP (fila única id=1)
  getBackupRemote:      db.prepare('SELECT * FROM backup_remote WHERE id = 1'),
  saveBackupRemote:     db.prepare(`
    INSERT INTO backup_remote (id, type, config_enc, remote_path, encrypt_enabled, crypt_pass_enc, auto_upload, retention_days, status, created_at)
    VALUES (1, @type, @config_enc, @remote_path, @encrypt_enabled, @crypt_pass_enc, @auto_upload, @retention_days, @status, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      type = @type, config_enc = @config_enc, remote_path = @remote_path,
      encrypt_enabled = @encrypt_enabled, crypt_pass_enc = @crypt_pass_enc,
      auto_upload = @auto_upload, retention_days = @retention_days, status = @status`),
  clearBackupRemote:    db.prepare('DELETE FROM backup_remote WHERE id = 1'),
};
