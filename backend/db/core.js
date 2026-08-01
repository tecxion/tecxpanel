'use strict';

// ============================================================
//  TecXPaneL — Rutinas core de BD: seed del admin + audit log.
//  Lógica trasladada literal desde database.js v1 (no se cambió
//  comportamiento, solo su ubicación).
// ============================================================

const bcrypt = require('bcryptjs');
const { db } = require('./client');
const queries = require('./queries');

// ── Seed del usuario admin desde el .env ──────────────────────
// La contraseña NUNCA se guarda en claro: se almacena el hash bcrypt.
function seedAdmin() {
  const username = process.env.ADMIN_USER || 'admin';
  const plain = process.env.ADMIN_PASS;
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);

  const email = process.env.ADMIN_EMAIL || 'admin@localhost.local';
  const securityQuestion = process.env.SECURITY_QUESTION || '¿Nombre de tu primera mascota?';
  const securityAnswer = process.env.SECURITY_ANSWER || 'admin';
  const securityAnswerHash = bcrypt.hashSync(securityAnswer.toLowerCase().trim(), 12);

  if (!existing) {
    if (!plain) {
      throw new Error(
        'ADMIN_PASS no está definido en el .env y no hay usuario admin en la BD. ' +
        'Define ADMIN_PASS antes del primer arranque.'
      );
    }
    const hash = bcrypt.hashSync(plain, 12);
    db.prepare('INSERT INTO users (username, password_hash, role, email, security_question, security_answer_hash) VALUES (?, ?, ?, ?, ?, ?)')
      .run(username, hash, 'admin', email, securityQuestion, securityAnswerHash);
    console.log(`[db] Usuario admin "${username}" creado con datos de recuperación.`);
  } else {
    // Si ya existe pero no tiene datos de recuperación (ej: tras actualización), rellenarlos
    const user = db.prepare('SELECT email, security_question, security_answer_hash FROM users WHERE username = ?').get(username);
    if (user && (!user.email || !user.security_question || !user.security_answer_hash)) {
      db.prepare('UPDATE users SET email = COALESCE(email, ?), security_question = COALESCE(security_question, ?), security_answer_hash = COALESCE(security_answer_hash, ?) WHERE username = ?')
        .run(email, securityQuestion, securityAnswerHash, username);
      console.log(`[db] Datos de recuperación asignados al admin "${username}" existente.`);
    }

    if (plain && process.env.TXPL_RESET_ADMIN_PASS === '1') {
      const hash = bcrypt.hashSync(plain, 12);
      db.prepare('UPDATE users SET password_hash = ? WHERE username = ?').run(hash, username);
      console.log(`[db] Contraseña del admin "${username}" actualizada.`);

      if (process.env.ADMIN_EMAIL || process.env.SECURITY_QUESTION || process.env.SECURITY_ANSWER) {
        db.prepare('UPDATE users SET email = ?, security_question = ?, security_answer_hash = ? WHERE username = ?')
          .run(email, securityQuestion, securityAnswerHash, username);
        console.log(`[db] Datos de recuperación del admin "${username}" actualizados (reset).`);
      }
    }
  }
}

// ── Audit log ─────────────────────────────────────────────────
// Traza cada acción mutante. Nunca pasa el error a la petición que la llame:
// un fallo de log no debe tirar el flujo del panel.
// Objeto queries viene del módulo queries/ (ver index.js).
function audit(user, ip, action, detail) {
  try {
    queries.audit.insertAudit.run(user || null, ip || null, action, detail || null);
  } catch (_) { /* el log de auditoría nunca debe tumbar una petición */ }
}

module.exports = { seedAdmin, audit };
