'use strict';

// ============================================================
//  TecXPaneL — Restablecer contraseña desde la terminal
//  Uso (vía CLI):  txpl reset-password
//  Uso directo:    RESET_NEW_PASSWORD="nueva" node reset-password.js <usuario>
//
//  Escribe directamente en la BD (mismo fichero que usa el panel).
//  Con SQLite en modo WAL el panel ve el cambio al instante: no
//  hace falta reiniciar PM2.
// ============================================================

const bcrypt = require('bcryptjs');
const { queries, audit } = require('../database');

const username = (process.argv[2] || 'admin').trim();
const plain = process.env.RESET_NEW_PASSWORD || '';

if (plain.length < 8) {
  console.error('Error: la contraseña debe tener al menos 8 caracteres.');
  process.exit(1);
}

const user = queries.getUserByName.get(username);
if (!user) {
  console.error(`Error: el usuario "${username}" no existe en la base de datos.`);
  process.exit(1);
}

queries.setPassword.run(bcrypt.hashSync(plain, 12), user.id);
audit(username, 'cli', 'password.reset.cli', null);
console.log(`Contraseña del usuario "${username}" restablecida con éxito.`);
process.exit(0);
