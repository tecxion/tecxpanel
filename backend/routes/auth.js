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
    ok(res);
  }));

  return { router, auth, verifyToken };
};
