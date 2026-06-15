'use strict';

const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { queries, audit } = require('../database');
const { ok, fail, clientIp, wrap } = require('../lib/helpers');
const { base32Encode, totpVerify } = require('../lib/crypto');

module.exports = function createAuthRouter(JWT_SECRET, TOKEN_TTL, loginLimiter) {
  const router = express.Router();

  // Login lockout
  const LOGIN_MAX_FAILS = 5;
  const LOGIN_LOCK_MS = 15 * 60_000;
  const loginFails = new Map();
  function loginLocked(ip) { const e = loginFails.get(ip); return e && e.until && e.until > Date.now(); }
  function recordLoginFail(ip) {
    const e = loginFails.get(ip) || { count: 0, until: 0 };
    e.count++;
    if (e.count >= LOGIN_MAX_FAILS) e.until = Date.now() + LOGIN_LOCK_MS;
    loginFails.set(ip, e);
  }
  function clearLoginFails(ip) { loginFails.delete(ip); }

  // JWT helpers
  function verifyToken(token) {
    try { return jwt.verify(token, JWT_SECRET); }
    catch (_) { return null; }
  }

  function auth(req, res, next) {
    const hdr = req.headers.authorization || '';
    const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
    const payload = token && verifyToken(token);
    if (!payload) return fail(res, 401, 'No autorizado');
    req.user = payload;
    next();
  }

  // Login
  router.post('/login', loginLimiter, wrap(async (req, res) => {
    const ip = clientIp(req);
    if (loginLocked(ip)) {
      audit(req.body?.username, ip, 'login.locked', null);
      return fail(res, 429, 'Demasiados intentos fallidos. Cuenta bloqueada temporalmente.');
    }
    const { username, password, code } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') return fail(res, 400, 'Credenciales requeridas');
    const user = queries.getUserByName.get(username);
    const hash = user ? user.password_hash : '$2a$12$0000000000000000000000000000000000000000000000000000';
    const valid = await bcrypt.compare(password, hash);
    if (!user || !valid) { recordLoginFail(ip); audit(username, ip, 'login.fail', null); return fail(res, 401, 'Credenciales incorrectas'); }
    if (user.totp_enabled) {
      if (!code) return res.status(401).json({ error: 'Código 2FA requerido', twofa: true });
      if (!totpVerify(user.totp_secret, code)) { recordLoginFail(ip); audit(user.username, ip, 'login.2fa.fail', null); return res.status(401).json({ error: 'Código 2FA incorrecto', twofa: true }); }
    }
    clearLoginFails(ip);
    const token = jwt.sign({ uid: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: TOKEN_TTL });
    audit(user.username, ip, 'login.ok', null);
    ok(res, { token, user: { username: user.username, role: user.role } });
  }));

  router.get('/me', auth, (req, res) => {
    const u = queries.getUserById.get(req.user.uid);
    if (!u) return fail(res, 401, 'No autorizado');
    ok(res, { username: u.username, role: u.role });
  });

  router.post('/password', auth, wrap(async (req, res) => {
    const { oldPassword, newPassword } = req.body || {};
    if (typeof newPassword !== 'string' || newPassword.length < 8) return fail(res, 400, 'La nueva contraseña debe tener al menos 8 caracteres');
    const u = queries.getUserFullById.get(req.user.uid);
    if (!u) return fail(res, 401, 'No autorizado');
    const valid = await bcrypt.compare(oldPassword || '', u.password_hash);
    if (!valid) { audit(u.username, clientIp(req), 'password.change.fail', null); return fail(res, 403, 'La contraseña actual no es correcta'); }
    queries.setPassword.run(bcrypt.hashSync(newPassword, 12), u.id);
    audit(u.username, clientIp(req), 'password.change.ok', null);
    ok(res);
  }));

  // 2FA
  router.get('/2fa/status', auth, (req, res) => {
    const u = queries.getUserById.get(req.user.uid);
    ok(res, { enabled: !!(u && u.totp_enabled) });
  });

  router.post('/2fa/setup', auth, wrap(async (req, res) => {
    const u = queries.getUserFullById.get(req.user.uid);
    if (!u) return fail(res, 401, 'No autorizado');
    const secret = base32Encode(crypto.randomBytes(20));
    queries.setTotpSecret.run(secret, u.id);
    const label = encodeURIComponent(`TecXPaneL:${u.username}`);
    const otpauth = `otpauth://totp/${label}?secret=${secret}&issuer=TecXPaneL&algorithm=SHA1&digits=6&period=30`;
    ok(res, { secret, otpauth });
  }));

  router.post('/2fa/enable', auth, wrap(async (req, res) => {
    const u = queries.getUserFullById.get(req.user.uid);
    if (!u || !u.totp_secret) return fail(res, 400, 'Primero genera un secreto (setup)');
    if (!totpVerify(u.totp_secret, req.body?.code)) return fail(res, 400, 'Código incorrecto');
    queries.enableTotp.run(u.id);
    audit(u.username, clientIp(req), '2fa.enable', null);
    ok(res);
  }));

  router.post('/2fa/disable', auth, wrap(async (req, res) => {
    const u = queries.getUserFullById.get(req.user.uid);
    if (!u) return fail(res, 401, 'No autorizado');
    const valid = await bcrypt.compare(req.body?.password || '', u.password_hash);
    if (!valid) return fail(res, 403, 'Contraseña incorrecta');
    queries.disableTotp.run(u.id);
    audit(u.username, clientIp(req), '2fa.disable', null);
  }));

  // Obtener pregunta de seguridad
  router.get('/reset-question', wrap(async (req, res) => {
    const { username } = req.query || {};
    if (typeof username !== 'string' || !username.trim()) {
      return fail(res, 400, 'Usuario requerido');
    }
    const user = queries.getUserByName.get(username.trim());
    if (!user || !user.security_question) {
      return fail(res, 404, 'Usuario no encontrado o pregunta no configurada');
    }
    ok(res, { question: user.security_question });
  }));

  // ── Datos de recuperación (email + pregunta de seguridad) ────
  const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  router.get('/recovery', auth, (req, res) => {
    const r = queries.getRecovery.get(req.user.uid);
    if (!r) return fail(res, 401, 'No autorizado');
    ok(res, { email: r.email || '', question: r.security_question || '' });
  });

  // Cambia email / pregunta / (opcional) respuesta. Exige la contraseña actual
  // porque estos datos son la vía para restablecer la contraseña.
  router.post('/recovery', auth, wrap(async (req, res) => {
    const { password, email, question, answer } = req.body || {};
    if (typeof email !== 'string' || !RE_EMAIL.test(email.trim())) return fail(res, 400, 'Email inválido');
    if (typeof question !== 'string' || !question.trim()) return fail(res, 400, 'La pregunta de seguridad es obligatoria');

    const u = queries.getUserFullById.get(req.user.uid);
    if (!u) return fail(res, 401, 'No autorizado');
    const valid = await bcrypt.compare(typeof password === 'string' ? password : '', u.password_hash);
    if (!valid) { audit(u.username, clientIp(req), 'recovery.update.fail', null); return fail(res, 403, 'La contraseña actual no es correcta'); }

    if (typeof answer === 'string' && answer.trim()) {
      const answerHash = bcrypt.hashSync(answer.toLowerCase().trim(), 12);
      queries.setRecovery.run(email.trim(), question.trim(), answerHash, u.id);
    } else {
      queries.setRecoveryNoAnswer.run(email.trim(), question.trim(), u.id);
    }
    audit(u.username, clientIp(req), 'recovery.update.ok', null);
    ok(res);
  }));

  // Restablecer contraseña verificando respuesta + email
  router.post('/reset-password', loginLimiter, wrap(async (req, res) => {
    const ip = clientIp(req);
    const { username, email, answer, newPassword } = req.body || {};

    if (
      typeof username !== 'string' || !username.trim() ||
      typeof email !== 'string' || !email.trim() ||
      typeof answer !== 'string' || !answer.trim() ||
      typeof newPassword !== 'string' || newPassword.length < 8
    ) {
      return fail(res, 400, 'Todos los campos son requeridos y la nueva contraseña debe tener al menos 8 caracteres');
    }

    if (loginLocked(ip)) {
      audit(username, ip, 'reset.locked', null);
      return fail(res, 429, 'Demasiados intentos fallidos. Cuenta bloqueada temporalmente.');
    }

    const user = queries.getUserByName.get(username.trim());
    if (!user || !user.email || !user.security_answer_hash) {
      recordLoginFail(ip);
      audit(username, ip, 'reset.fail.no_user', null);
      return fail(res, 403, 'Datos de recuperación incorrectos');
    }

    // Verificar email (insensible a mayúsculas/minúsculas y espacios)
    const emailMatch = user.email.toLowerCase().trim() === email.toLowerCase().trim();
    if (!emailMatch) {
      recordLoginFail(ip);
      audit(username, ip, 'reset.fail.email', null);
      return fail(res, 403, 'Datos de recuperación incorrectos');
    }

    // Verificar respuesta de seguridad (insensible a mayúsculas/minúsculas y espacios)
    const answerMatch = await bcrypt.compare(answer.toLowerCase().trim(), user.security_answer_hash);
    if (!answerMatch) {
      recordLoginFail(ip);
      audit(username, ip, 'reset.fail.answer', null);
      return fail(res, 403, 'Datos de recuperación incorrectos');
    }

    // Si todo es correcto, actualizar contraseña y limpiar bloqueos
    const newHash = bcrypt.hashSync(newPassword, 12);
    queries.setPassword.run(newHash, user.id);
    clearLoginFails(ip);
    audit(username, ip, 'reset.success', null);
    ok(res);
  }));

  return { router, auth, verifyToken };
};
