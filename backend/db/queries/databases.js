'use strict';

// queries/databases.js — bases de datos MySQL/PostgreSQL (credenciales AES-256-GCM).
const { db } = require('../client');

module.exports = {
  listDatabases:            db.prepare('SELECT * FROM databases ORDER BY created_at DESC'),
  getDatabase:              db.prepare('SELECT * FROM databases WHERE id = ?'),
  getDatabaseByName:        db.prepare('SELECT * FROM databases WHERE name = ?'),
  insertDatabase:           db.prepare('INSERT INTO databases (name, type, db_user, db_password, status) VALUES (@name, @type, @db_user, @db_password, @status)'),
  updateDatabasePassword:   db.prepare('UPDATE databases SET db_password = ? WHERE id = ?'),
  deleteDatabase:           db.prepare('DELETE FROM databases WHERE id = ?'),
};
