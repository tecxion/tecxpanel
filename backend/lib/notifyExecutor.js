'use strict';

// ─────────────────────────────────────────────────────────────────
//  notifyExecutor.js — EFECTOS de notificaciones.
//  Lee la fila única notify_config, descifra los secretos y envía
//  por Telegram (fetch a api.telegram.org) y/o email (nodemailer).
//  Usable desde el monitor, las rutas y (futuro) backup-runner.
//  Los errores se loguean SIN token ni contraseña.
// ─────────────────────────────────────────────────────────────────

const nodemailer = require('nodemailer');
const { queries } = require('../database');
const { decryptSecret } = require('./crypto');
const { buildTelegramMessage, buildEmailMessage } = require('./notifications');

const TG_TIMEOUT_MS = 10_000;

function safeDecrypt(v) {
  try { return decryptSecret(v); } catch (_) { return null; }
}

// Config efectiva con secretos descifrados (o null si no hay fila).
function loadConfig() {
  const row = queries.getNotifyConfig.get();
  if (!row) return null;
  return {
    ...row,
    telegram_token: row.telegram_token_enc ? safeDecrypt(row.telegram_token_enc) : null,
    smtp_pass: row.smtp_pass_enc ? safeDecrypt(row.smtp_pass_enc) : null,
  };
}

// Envía un mensaje por la API de Telegram. Sin proceso bot: una petición HTTPS.
async function sendTelegram({ token, chatId }, text) {
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
    signal: AbortSignal.timeout(TG_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    const e = new Error(data.description || `HTTP ${res.status}`);
    e.http = 502;
    throw e;
  }
}

// Envía un email por SMTP (transporte efímero: no mantenemos conexiones vivas).
async function sendEmail(cfg, subject, text) {
  const transporter = nodemailer.createTransport({
    host: cfg.host,
    port: Number(cfg.port),
    secure: !!cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass || '' } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  await transporter.sendMail({ from: cfg.from, to: cfg.to, subject, text });
}

// dispatch(ev): envía a todos los canales activos. Devuelve true si al menos
// uno entregó. Nunca lanza: el que llama no debe romperse por un canal caído.
async function dispatch(ev) {
  const cfg = loadConfig();
  if (!cfg) return false;
  let delivered = false;

  if (cfg.telegram_enabled && cfg.telegram_token && cfg.telegram_chat_id) {
    try {
      await sendTelegram({ token: cfg.telegram_token, chatId: cfg.telegram_chat_id }, buildTelegramMessage(ev));
      delivered = true;
    } catch (e) {
      console.error('[notify] telegram:', e.message);
    }
  }

  if (cfg.smtp_enabled && cfg.smtp_host && cfg.smtp_to) {
    const { subject, text } = buildEmailMessage(ev);
    try {
      await sendEmail({
        host: cfg.smtp_host, port: cfg.smtp_port, secure: cfg.smtp_secure,
        user: cfg.smtp_user, pass: cfg.smtp_pass, from: cfg.smtp_from, to: cfg.smtp_to,
      }, subject, text);
      delivered = true;
    } catch (e) {
      console.error('[notify] email:', e.message);
    }
  }

  return delivered;
}

// detectChatId(token): tras pulsar /start en el bot, getUpdates trae el chat.
async function detectChatId(token) {
  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, {
    signal: AbortSignal.timeout(TG_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) {
    const e = new Error(data.description || 'Telegram rechazó el token');
    e.http = 502;
    throw e;
  }
  const withChat = (data.result || []).slice().reverse().find((u) => u.message?.chat?.id);
  if (!withChat) {
    const e = new Error('No hay mensajes: abre tu bot en Telegram, pulsa /start y reintenta.');
    e.http = 404;
    throw e;
  }
  const chat = withChat.message.chat;
  return { chatId: String(chat.id), name: chat.first_name || chat.username || '' };
}

module.exports = { loadConfig, dispatch, sendTelegram, sendEmail, detectChatId };
