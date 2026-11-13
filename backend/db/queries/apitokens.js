'use strict';

// queries/apitokens.js — prepared statements de la tabla api_tokens.
// Solo se almacena el hash SHA-256 del token (ver lib/apitokens): el listado
// nunca devuelve token_hash, y la búsqueda por hash trae el usuario y su rol
// para poder autenticar la petición sin una segunda consulta.
const { db } = require('../client');

module.exports = {
  insertApiToken:    db.prepare('INSERT INTO api_tokens (user_id, name, token_hash, scope, expires_at) VALUES (?, ?, ?, ?, ?)'),
  listApiTokens:     db.prepare('SELECT id, name, scope, created_at, expires_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY id DESC'),
  getApiTokenByHash: db.prepare('SELECT t.*, u.username, u.role FROM api_tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?'),
  touchApiToken:     db.prepare("UPDATE api_tokens SET last_used_at = datetime('now') WHERE id = ?"),
  // Filtra también por user_id: un usuario solo puede revocar sus propios tokens.
  deleteApiToken:    db.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?'),
};
