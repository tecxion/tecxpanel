'use strict';

// queries/devices.js — prepared statements de trusted_devices (dispositivos recordados).
const { db } = require('../client');

module.exports = {
  insertDevice:     db.prepare('INSERT INTO trusted_devices (user_id, secret_hash, label, ip, last_used_at, expires_at) VALUES (?, ?, ?, ?, datetime(\'now\'), ?)'),
  getDevice:        db.prepare('SELECT d.*, u.username, u.role FROM trusted_devices d JOIN users u ON u.id = d.user_id WHERE d.id = ?'),
  // Rotación: el hash vigente pasa a prev_hash; la caducidad se renueva (sesión deslizante).
  rotateDevice:     db.prepare("UPDATE trusted_devices SET prev_hash = secret_hash, secret_hash = ?, rotated_at = datetime('now'), last_used_at = datetime('now'), ip = ?, expires_at = ? WHERE id = ?"),
  touchDevice:      db.prepare("UPDATE trusted_devices SET last_used_at = datetime('now') WHERE id = ?"),
  listDevices:      db.prepare('SELECT id, label, ip, created_at, last_used_at, expires_at FROM trusted_devices WHERE user_id = ? ORDER BY id DESC'),
  deleteDevice:     db.prepare('DELETE FROM trusted_devices WHERE id = ? AND user_id = ?'),
  deleteUserDevices: db.prepare('DELETE FROM trusted_devices WHERE user_id = ?'),
  purgeExpiredDevices: db.prepare("DELETE FROM trusted_devices WHERE expires_at < datetime('now')"),
};
