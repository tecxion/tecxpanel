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
const devices = require('../lib/devices');
const loginApproval = require('../lib/loginApproval');

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

  // Flag `ai_admin_enabled` en panel_flags: '1' = encendido; ausente o '0' = apagado.
  function aiAdminEnabled() {
    return queries.getPanelFlag.get('ai_admin_enabled')?.value === '1';
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
    // Interruptor global: con él apagado, los tokens admin quedan inertes (sin touch).
    if (row.scope === 'admin' && !aiAdminEnabled()) {
      audit(username, clientIp(req), 'apitoken.denied', `${req.method} ${ruta} (control total desactivado)`);
      return fail(res, 403, 'Los tokens de control total están desactivados en el panel');
    }
    queries.touchApiToken.run(row.id);
    // Toda petición con token que no sea de lectura queda en la auditoría (nunca el token).
    if (req.method !== 'GET') audit(username, clientIp(req), 'apitoken.call', `${req.method} ${ruta}`);
    req.user = { uid: row.user_id, username, role: row.role, apiToken: { id: row.id, name: row.name, scope: row.scope } };
    next();
  }

  // JWT de sesión (8 h por defecto) para un usuario.
  function issueJwt(u) { return jwt.sign({ uid: u.id, username: u.username, role: u.role }, JWT_SECRET, { expiresIn: TOKEN_TTL }); }

  // Dispositivo recordado: crea la fila y manda la cookie HttpOnly `id.secreto`.
  function rememberDevice(req, res, userId) {
    const secret = devices.newSecret();
    const id = queries.insertDevice.run(userId, devices.hash(secret), devices.label(req.headers['user-agent']), clientIp(req), devices.expiresAt()).lastInsertRowid;
    res.setHeader('Set-Cookie', devices.setCookie(`${id}.${secret}`, req.secure));
    queries.purgeExpiredDevices.run();
  }

  // Interruptor «aprobar logins por Telegram» (panel_flags.tg_login_approval).
  const approvalOn = () => queries.getPanelFlag.get('tg_login_approval')?.value === '1';

  // Cierra un login ya autorizado: JWT (+ cookie de dispositivo si lo pidió) y respuesta.
  function finishLogin(req, res, user, remember) {
    if (remember === true) rememberDevice(req, res, user.id);
    ok(res, { token: issueJwt(user), user: { username: user.username, role: user.role } });
  }

  // Login
  router.post('/login', loginLimiter, wrap(async (req, res) => {
    const ip = clientIp(req);
    if (loginLocked(ip)) {
      audit(req.body?.username, ip, 'login.locked', null);
      return fail(res, 429, 'Demasiados intentos fallidos. Cuenta bloqueada temporalmente.');
    }
    const { username, password, code, remember } = req.body || {};
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
    // Aprobación por Telegram: IP nueva o «recordar dispositivo». Si Telegram no responde
    // al enviar, se deja entrar (fail-open) y queda auditado: no te quedas fuera por una caída.
    if (approvalOn() && (remember === true || !ipConocida) && loginApproval.telegramReady()) {
      const pend = await loginApproval.request({ user: { id: user.id, username: user.username, role: user.role }, ip, label: devices.label(req.headers['user-agent']), remember });
      if (pend) {
        audit(user.username, ip, 'login.approval.requested', null);
        return ok(res, { pending: true, ...pend });
      }
      audit(user.username, ip, 'login.approval.unavailable', null);
    }
    audit(user.username, ip, 'login.ok', null);
    if (!ipConocida) {
      notifySecurity('Inicio de sesión desde IP nueva', `Usuario ${user.username} desde ${ip}`);
    }
    finishLogin(req, res, user, remember);
  }));

  // El navegador pregunta si el login pendiente fue aprobado en Telegram.
  router.post('/login/poll', wrap(async (req, res) => {
    const secret = req.body?.pollSecret;
    if (typeof secret !== 'string' || secret.length > 64) return fail(res, 400, 'Solicitud inválida');
    const { status, entry } = loginApproval.poll(secret);
    if (status === 'pending') return ok(res, { status });
    if (status === 'denied') {
      audit(entry.user.username, entry.ip, 'login.approval.denied', null);
      notifySecurity('Login denegado desde Telegram', `Usuario ${entry.user.username} desde ${entry.ip}`);
      return fail(res, 403, 'Inicio de sesión denegado desde Telegram');
    }
    if (status !== 'approved') return fail(res, 410, 'La aprobación caducó. Inicia sesión de nuevo.');
    const u = queries.getUserById.get(entry.user.id);
    if (!u) return fail(res, 401, 'No autorizado');
    audit(u.username, entry.ip, 'login.ok', 'telegram');
    finishLogin(req, res, u, entry.remember);
  }));

  router.get('/login-approval', auth, sessionOnly, (req, res) => {
    ok(res, { enabled: approvalOn(), telegram: loginApproval.telegramReady() });
  });

  router.post('/login-approval', auth, sessionOnly, wrap(async (req, res) => {
    const { enabled, password } = req.body || {};
    if (typeof enabled !== 'boolean') return fail(res, 400, 'Valor inválido');
    const u = queries.getUserFullById.get(req.user.uid);
    if (!u) return fail(res, 401, 'No autorizado');
    const valid = await bcrypt.compare(typeof password === 'string' ? password : '', u.password_hash);
    if (!valid) { audit(u.username, clientIp(req), 'login.approval.toggle.fail', null); return fail(res, 403, 'La contraseña actual no es correcta'); }
    if (enabled && !loginApproval.telegramReady()) return fail(res, 400, 'Configura y activa primero Telegram en Notificaciones');
    queries.setPanelFlag.run('tg_login_approval', enabled ? '1' : '0');
    audit(u.username, clientIp(req), 'login.approval.toggle', enabled ? 'on' : 'off');
    ok(res, { enabled });
  }));

  // Renueva la sesión con la cookie de dispositivo recordado (sin contraseña).
  // El secreto rota en cada uso. Reusar uno ya rotado (fuera de la ventana de gracia)
  // indica cookie robada: se revocan TODOS los dispositivos del usuario.
  router.post('/refresh', wrap(async (req, res) => {
    const c = devices.parseCookie(req.headers.cookie);
    const deny = () => { res.setHeader('Set-Cookie', devices.clearCookie(req.secure)); return fail(res, 401, 'No autorizado'); };
    if (!c) return fail(res, 401, 'No autorizado');
    const d = queries.getDevice.get(c.id);
    if (!d || d.expires_at < new Date().toISOString().slice(0, 19).replace('T', ' ')) return deny();
    const h = devices.hash(c.secret);
    if (devices.eq(h, d.secret_hash)) {
      const secret = devices.newSecret();
      queries.rotateDevice.run(devices.hash(secret), clientIp(req), devices.expiresAt(), d.id);
      res.setHeader('Set-Cookie', devices.setCookie(`${d.id}.${secret}`, req.secure));
    } else if (d.prev_hash && devices.eq(h, d.prev_hash) && devices.inGrace(d.rotated_at)) {
      queries.touchDevice.run(d.id); // otra pestaña ya rotó: la cookie nueva ya está en el navegador
    } else {
      queries.deleteUserDevices.run(d.user_id);
      audit(d.username, clientIp(req), 'device.reuse', null);
      notifySecurity('Cookie de dispositivo reutilizada', `Usuario ${d.username} desde ${clientIp(req)}: se han revocado todos sus dispositivos recordados`);
      return deny();
    }
    audit(d.username, clientIp(req), 'device.refresh', null);
    ok(res, { token: issueJwt({ id: d.user_id, username: d.username, role: d.role }), user: { username: d.username, role: d.role } });
  }));

  // Salir: revoca el dispositivo de ESTA cookie (si la hay) y la borra. Sin auth: solo actúa sobre su propia cookie.
  router.post('/logout', (req, res) => {
    const c = devices.parseCookie(req.headers.cookie);
    const d = c && queries.getDevice.get(c.id);
    if (d && devices.eq(devices.hash(c.secret), d.secret_hash)) queries.deleteDevice.run(d.id, d.user_id);
    res.setHeader('Set-Cookie', devices.clearCookie(req.secure));
    ok(res);
  });

  router.get('/devices', auth, sessionOnly, (req, res) => {
    const cur = devices.parseCookie(req.headers.cookie)?.id;
    ok(res, queries.listDevices.all(req.user.uid).map((d) => ({ ...d, current: d.id === cur })));
  });

  router.delete('/devices/:id', auth, sessionOnly, (req, res) => {
    const r = queries.deleteDevice.run(Number(req.params.id), req.user.uid);
    if (!r.changes) return fail(res, 404, 'Dispositivo no encontrado');
    audit(req.user.username, clientIp(req), 'device.revoke', String(req.params.id));
    ok(res);
  });

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
    queries.deleteUserDevices.run(u.id); // cambiar la contraseña cierra todos los dispositivos recordados
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
    const { name, scope, days, password, code } = req.body || {};
    if (!apitokens.isValidTokenName(name)) return fail(res, 400, 'Nombre inválido (1-40 caracteres: letras, números, espacio, _ . -)');
    if (!apitokens.SCOPES.includes(scope)) return fail(res, 400, 'Ámbito inválido');
    const dias = apitokens.expiryDaysFor(scope);
    if (!dias.includes(days)) return fail(res, 400, `Caducidad inválida (días: ${dias.join(', ')})`);
    if (scope === 'admin' && !aiAdminEnabled()) return fail(res, 403, 'Los tokens de control total están desactivados en el panel');
    const u = queries.getUserFullById.get(req.user.uid);
    if (!u) return fail(res, 401, 'No autorizado');
    const valid = await bcrypt.compare(typeof password === 'string' ? password : '', u.password_hash);
    if (!valid) { audit(u.username, clientIp(req), 'apitoken.create.fail', name); return fail(res, 403, 'La contraseña actual no es correcta'); }
    // Control total + 2FA activo: además de la contraseña, el código TOTP.
    if (scope === 'admin' && u.totp_enabled && !totpVerify(u.totp_secret, code)) {
      audit(u.username, clientIp(req), 'apitoken.create.fail', name);
      return fail(res, 403, 'Código 2FA requerido o incorrecto'); // 403, no 401: el 401 cierra la sesión en el frontend
    }
    const { token, hash } = apitokens.generateToken();
    const id = queries.insertApiToken.run(u.id, name, hash, scope, apitokens.expiresAt(days)).lastInsertRowid;
    audit(u.username, clientIp(req), 'apitoken.create', name);
    ok(res, { id: Number(id), token });
  }));

  // Interruptor global de los tokens de control total (admin). Solo con sesión;
  // cambiarlo exige la contraseña actual.
  router.get('/ai-admin', auth, sessionOnly, (req, res) => {
    ok(res, { enabled: aiAdminEnabled() });
  });

  router.post('/ai-admin', auth, sessionOnly, wrap(async (req, res) => {
    const { enabled, password } = req.body || {};
    if (typeof enabled !== 'boolean') return fail(res, 400, 'Valor inválido');
    const u = queries.getUserFullById.get(req.user.uid);
    if (!u) return fail(res, 401, 'No autorizado');
    const valid = await bcrypt.compare(typeof password === 'string' ? password : '', u.password_hash);
    if (!valid) { audit(u.username, clientIp(req), 'apitoken.admin.toggle.fail', null); return fail(res, 403, 'La contraseña actual no es correcta'); }
    queries.setPanelFlag.run('ai_admin_enabled', enabled ? '1' : '0');
    audit(u.username, clientIp(req), 'apitoken.admin.toggle', enabled ? 'on' : 'off');
    ok(res, { enabled });
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
