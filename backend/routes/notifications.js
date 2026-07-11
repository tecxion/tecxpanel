'use strict';

// ─────────────────────────────────────────────────────────────────
//  notifications.js — Rutas de configuración de notificaciones.
//  Config en fila única (notify_config) con secretos cifrados.
//  Los endpoints /test operan con la config del body (probar antes
//  de guardar), con fallback a los secretos ya guardados.
// ─────────────────────────────────────────────────────────────────

const os = require('os');
const express = require('express');
const { ok, fail, clientIp, wrap } = require('../lib/helpers');
const { encryptSecret, decryptSecret } = require('../lib/crypto');
const { queries, audit } = require('../database');
const {
  isValidTelegramToken, isValidChatId, isValidSmtpConfig,
  buildTestEvent, buildTelegramMessage, buildEmailMessage,
} = require('../lib/notifications');
const { sendTelegram, sendEmail, detectChatId } = require('../lib/notifyExecutor');

const router = express.Router();

// Token del body o, si viene vacío, el guardado (descifrado). Null si no hay.
function resolveToken(bodyToken) {
  const t = (bodyToken || '').trim();
  if (t) return t;
  const row = queries.getNotifyConfig.get();
  if (!row?.telegram_token_enc) return null;
  try { return decryptSecret(row.telegram_token_enc); } catch (_) { return null; }
}

// Contraseña SMTP del body o la guardada.
function resolveSmtpPass(bodyPass) {
  if (typeof bodyPass === 'string' && bodyPass) return bodyPass;
  const row = queries.getNotifyConfig.get();
  if (!row?.smtp_pass_enc) return null;
  try { return decryptSecret(row.smtp_pass_enc); } catch (_) { return null; }
}

// GET /config — config actual SIN secretos (solo flags de "hay secreto").
router.get('/config', wrap(async (req, res) => {
  const row = queries.getNotifyConfig.get();
  if (!row) return ok(res, { configured: false });
  const { telegram_token_enc, smtp_pass_enc, ...pub } = row;
  ok(res, { configured: true, ...pub, telegram_token_set: !!telegram_token_enc, smtp_pass_set: !!smtp_pass_enc });
}));

// POST /config — valida y guarda. Token/contraseña vacíos = conservar los guardados.
router.post('/config', wrap(async (req, res) => {
  const b = req.body || {};
  const prev = queries.getNotifyConfig.get();
  const tgEnabled = b.telegram_enabled ? 1 : 0;
  const smtpEnabled = b.smtp_enabled ? 1 : 0;

  let tokenEnc = prev?.telegram_token_enc || null;
  if (typeof b.telegram_token === 'string' && b.telegram_token.trim()) {
    if (!isValidTelegramToken(b.telegram_token)) return fail(res, 400, 'Token de Telegram no válido (formato de @BotFather: 123456:ABC…)');
    tokenEnc = encryptSecret(b.telegram_token.trim());
  }
  if (tgEnabled) {
    if (!tokenEnc) return fail(res, 400, 'Falta el token del bot de Telegram');
    if (!isValidChatId(b.telegram_chat_id)) return fail(res, 400, 'Chat ID de Telegram no válido (usa "Detectar chat")');
  }

  let passEnc = prev?.smtp_pass_enc || null;
  if (typeof b.smtp_pass === 'string' && b.smtp_pass) passEnc = encryptSecret(b.smtp_pass);
  if (smtpEnabled && !isValidSmtpConfig({ host: b.smtp_host, port: b.smtp_port, from: b.smtp_from, to: b.smtp_to })) {
    return fail(res, 400, 'Config SMTP incompleta: host, puerto (1-65535), remitente y destinatario son obligatorios');
  }

  const th = parseInt(b.ev_disk_threshold, 10);
  queries.upsertNotifyConfig.run({
    telegram_enabled: tgEnabled,
    telegram_token_enc: tokenEnc,
    telegram_chat_id: b.telegram_chat_id ? String(b.telegram_chat_id).trim() : null,
    smtp_enabled: smtpEnabled,
    smtp_host: (b.smtp_host || '').trim() || null,
    smtp_port: parseInt(b.smtp_port, 10) || 587,
    smtp_secure: b.smtp_secure ? 1 : 0,
    smtp_user: (b.smtp_user || '').trim() || null,
    smtp_pass_enc: passEnc,
    smtp_from: (b.smtp_from || '').trim() || null,
    smtp_to: (b.smtp_to || '').trim() || null,
    ev_disk_enabled: b.ev_disk_enabled ? 1 : 0,
    ev_disk_threshold: Number.isInteger(th) && th >= 50 && th <= 99 ? th : 90,
    ev_services_enabled: b.ev_services_enabled ? 1 : 0,
    ev_security_enabled: b.ev_security_enabled ? 1 : 0,
  });
  audit(req.user.username, clientIp(req), 'notify.config', null); // sin secretos en el detalle
  ok(res, { saved: true });
}));

// POST /test/telegram — envía la notificación de prueba con la config del body.
router.post('/test/telegram', wrap(async (req, res) => {
  const b = req.body || {};
  const token = resolveToken(b.telegram_token);
  if (!token || !isValidTelegramToken(token)) return fail(res, 400, 'Token de Telegram no válido');
  if (!isValidChatId(b.telegram_chat_id)) return fail(res, 400, 'Chat ID no válido (usa "Detectar chat")');
  try {
    await sendTelegram({ token, chatId: String(b.telegram_chat_id).trim() }, buildTelegramMessage(buildTestEvent(os.hostname())));
  } catch (e) {
    return fail(res, 502, 'Telegram: ' + e.message);
  }
  ok(res, { sent: true });
}));

// POST /test/email — ídem por SMTP.
router.post('/test/email', wrap(async (req, res) => {
  const b = req.body || {};
  const cfg = { host: (b.smtp_host || '').trim(), port: b.smtp_port, from: (b.smtp_from || '').trim(), to: (b.smtp_to || '').trim() };
  if (!isValidSmtpConfig(cfg)) return fail(res, 400, 'Config SMTP incompleta o no válida');
  const { subject, text } = buildEmailMessage(buildTestEvent(os.hostname()));
  try {
    await sendEmail({
      ...cfg, secure: !!b.smtp_secure,
      user: (b.smtp_user || '').trim() || null,
      pass: resolveSmtpPass(b.smtp_pass),
    }, subject, text);
  } catch (e) {
    return fail(res, 502, 'SMTP: ' + e.message);
  }
  ok(res, { sent: true });
}));

// POST /telegram/detect-chat — autodetecta el chat_id tras pulsar /start.
router.post('/telegram/detect-chat', wrap(async (req, res) => {
  const token = resolveToken(req.body?.telegram_token);
  if (!token || !isValidTelegramToken(token)) return fail(res, 400, 'Introduce primero el token del bot');
  const r = await detectChatId(token); // lanza con e.http (404/502) que wrap respeta
  ok(res, r);
}));

module.exports = router;
