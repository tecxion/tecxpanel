'use strict';

// queries/users.js — prepared statements de la tabla users.
const { db } = require('../client');

module.exports = {
  getUserByName:        db.prepare('SELECT * FROM users WHERE username = ?'),
  getUserById:          db.prepare('SELECT id, username, role, totp_secret, totp_enabled FROM users WHERE id = ?'),
  getUserFullById:      db.prepare('SELECT * FROM users WHERE id = ?'),
  setPassword:          db.prepare('UPDATE users SET password_hash = ? WHERE id = ?'),
  setTotpSecret:        db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?'),
  enableTotp:           db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?'),
  disableTotp:          db.prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?'),
  getRecovery:          db.prepare('SELECT email, security_question FROM users WHERE id = ?'),
  setRecovery:          db.prepare('UPDATE users SET email = ?, security_question = ?, security_answer_hash = ? WHERE id = ?'),
  setRecoveryNoAnswer:  db.prepare('UPDATE users SET email = ?, security_question = ? WHERE id = ?'),
};
