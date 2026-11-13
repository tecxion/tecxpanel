'use strict';

// ============================================================
//  TecXPaneL — Autenticación y seguridad de acceso
//
//  Gestiona el login, los tokens JWT, el cambio de contraseña, el
//  2FA (TOTP) y la recuperación de contraseña (email + pregunta).
//
//  Conceptos clave:
//   - bcrypt: las contraseñas NUNCA se guardan en claro; se guarda un
//     "hash" (huella) que no se puede revertir. Al hacer login se
//     compara el hash, no la contraseña.
//   - JWT (JSON Web Token): tras el login se entrega un token firmado.
//     El navegador lo envía en cada petición para demostrar quién es,
//     sin tener que reenviar la contraseña.
//   - Token de API (`txpl_…`): credencial de larga duración para clientes
//     externos (p. ej. el MCP). Solo se guarda su hash y solo puede llamar
//     a las rutas de la lista blanca de lib/apitokens; se crea y revoca
//     desde una sesión JWT con /api/auth/tokens.
// ============================================================

const crypto = require('crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { queries, audit } = require('../database');
const { ok, fail, clientIp, wrap } = require('../lib/helpers');
const { base32Encode, totpVerify } = require('../lib/crypto');
const os = require('os');
const { buildSecurityEvent } = require('../lib/notifications');
const { dispatch } = require('../lib/notifyExecutor');
const apitokens = require('../lib/apitokens');

// Notificación puntual de seguridad: fire-and-forget, nunca bloquea el login.
function notifySecurity(title, detail) {
  try {
    const cfg = queries.getNotifyConfig.get();
    if (!cfg || !cfg.ev_security_enabled || (!cfg.telegram_enabled && !cfg.smtp_enabled)) return;
    dispatch(buildSecurityEvent(os.hostname(), title, detail)).catch(() => {});
  } catch (_) { /* la notificación jamás tumba el login */ }
}

// Es una "fábrica": server.js la llama pasándole el secreto JWT, la duración
// del token y el limitador de login, y devuelve el router + utilidades de auth.
module.exports = function createAuthRouter(JWT_SECRET, TOKEN_TTL, loginLimiter) {
  const router = express.Router();

  // Bloqueo por intentos fallidos: tras 5 fallos desde una IP, se bloquea el
  // login de esa IP durante 15 minutos (defensa contra fuerza bruta).
  const LOGIN_MAX_FAILS = 5;
  const LOGIN_LOCK_MS = 15 * 60_000;
  const loginFails = new Map(); // IP -> { count, until }
  function loginLocked(ip) { const e = loginFails.get(ip); return e && e.until && e.until > Date.now(); }
  function recordLoginFail(ip) {
    const e = loginFails.get(ip) || { count: 0, until: 0 };
    e.count++;
    if (e.count === LOGIN_MAX_FAILS) {
      notifySecurity('Bloqueo por fuerza bruta', `IP ${ip} bloqueada 15 min tras ${LOGIN_MAX_FAILS} intentos fallidos de login`);
    }
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
    if (apitokens.isApiToken(token)) return authApiToken(token, req, res, next);
    const payload = token && verifyToken(token);
    if (!payload) return fail(res, 401, 'No autorizado');
    req.user = payload;
    next();
  }

  // Token de API: debe existir, no estar caducado y la ruta pedida debe estar en
  // la lista blanca. Inexistente, caducado o revocado dan el MISMO 401 que un JWT
  // inválido para no revelar cuál de los casos es.
  function authApiToken(token, req, res, next) {
    const row = queries.getApiTokenByHash.get(apitokens.hashToken(token));
    if (!row || apitokens.isExpired(row)) return fail(res, 401, 'No autorizado');
    const username = `${row.username} (token:${row.name})`;
    // baseUrl + path: ruta completa sin query string, sirva auth montado en
    // app.use('/api') o directamente en una ruta del router de auth.
    const ruta = req.baseUrl + req.path;
    if (!apitokens.isAllowed(row.scope, req.method, ruta)) {
      audit(username, clientIp(req), 'apitoken.denied', `${req.method} ${ruta}`);
      return fail(res, 403, 'Este token no tiene permiso para esta operación');
    }
    queries.touchApiToken.run(row.id);
    req.user = { uid: row.user_id, username, role: row.role, apiToken: { id: row.id, name: row.name, scope: row.scope } };
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
    // ¿Primera vez que esta IP inicia sesión con éxito? (consultar ANTES del audit)
    const ipConocida = queries.hasLoginFromIp.get(ip).c > 0;
    const token = jwt.sign({ uid: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: TOKEN_TTL });
    audit(user.username, ip, 'login.ok', null);
    if (!ipConocida) {
      notifySecurity('Inicio de sesión desde IP nueva', `Usuario ${user.username} desde ${ip}`);
    }
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

  // ── Tokens de API (gestión SOLO desde sesión JWT) ─────────────
  // La lista blanca ya excluye /api/auth/*; este rechazo es defensa en profundidad
  // para que un token nunca pueda crear, listar ni revocar tokens.
  function sessionOnly(req, res, next) {
    if (req.user.apiToken) return fail(res, 403, 'Este token no tiene permiso para esta operación');
    next();
  }

  router.get('/tokens', auth, sessionOnly, (req, res) => {
    ok(res, queries.listApiTokens.all(req.user.uid));
  });

  // Crea un token. Exige la contraseña actual: un JWT robado no basta para
  // fabricar una credencial de larga duración. El token en claro sale solo aquí.
  router.post('/tokens', auth, sessionOnly, wrap(async (req, res) => {
    const { name, scope, days, password } = req.body || {};
    if (!apitokens.isValidTokenName(name)) return fail(res, 400, 'Nombre inválido (1-40 caracteres: letras, números, espacio, _ . -)');
    if (!apitokens.SCOPES.includes(scope)) return fail(res, 400, 'Ámbito inválido');
    if (!apitokens.EXPIRY_DAYS.includes(days)) return fail(res, 400, `Caducidad inválida (días: ${apitokens.EXPIRY_DAYS.join(', ')})`);
    const u = queries.getUserFullById.get(req.user.uid);
    if (!u) return fail(res, 401, 'No autorizado');
    const valid = await bcrypt.compare(typeof password === 'string' ? password : '', u.password_hash);
    if (!valid) { audit(u.username, clientIp(req), 'apitoken.create.fail', name); return fail(res, 403, 'La contraseña actual no es correcta'); }
    const { token, hash } = apitokens.generateToken();
    const id = queries.insertApiToken.run(u.id, name, hash, scope, apitokens.expiresAt(days)).lastInsertRowid;
    audit(u.username, clientIp(req), 'apitoken.create', name);
    ok(res, { id: Number(id), token });
  }));

  // Revoca un token propio (deleteApiToken filtra por user_id).
  router.delete('/tokens/:id', auth, sessionOnly, (req, res) => {
    const id = Number(req.params.id);
    const tok = queries.listApiTokens.all(req.user.uid).find((t) => t.id === id);
    if (!tok) return fail(res, 404, 'Token no encontrado');
    queries.deleteApiToken.run(id, req.user.uid);
    audit(req.user.username, clientIp(req), 'apitoken.revoke', tok.name);
    ok(res);
  });

  return { router, auth, verifyToken };
};
