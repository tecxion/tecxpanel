'use strict';

// lib/loginApproval — aprobación de inicios de sesión por Telegram.
// Estado EN MEMORIA (un login pendiente dura 2 min; si el panel se reinicia, se pide de nuevo).
// Dos secretos distintos: `approveId` viaja por Telegram (botones) y `pollSecret` solo lo conoce
// el navegador que inició el login. Aprobar no revela el pollSecret.
const os = require('os');
const crypto = require('crypto');
const { loadConfig } = require('../notifications/executor');

const TTL_MS = 120_000;
const MAX_PENDING = 20;
const pending = new Map(); // approveId → { pollHash, user, ip, label, remember, expires, status, msgId }

const rnd = () => crypto.randomBytes(16).toString('base64url');
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Quita entradas caducadas.
function purge() { const now = Date.now(); for (const [k, e] of pending) if (e.expires < now) pending.delete(k); }

// ¿Hay Telegram listo para enviar la petición?
function telegramReady() {
  const c = loadConfig();
  return !!(c && c.telegram_enabled && c.telegram_token && c.telegram_chat_id);
}

// Envía la petición con botones Aprobar/Denegar. Devuelve el message_id o null si falla.
async function sendRequest(approveId, e) {
  const c = loadConfig();
  const text = `🔐 <b>Inicio de sesión en ${esc(os.hostname())}</b>\n`
    + `Usuario: ${esc(e.user.username)}\nIP: ${esc(e.ip)}\nNavegador: ${esc(e.label)}\n`
    + (e.remember ? 'Pide recordar el dispositivo 30 días\n' : '')
    + '\n¿Eres tú? Caduca en 2 minutos.';
  try {
    const res = await fetch(`https://api.telegram.org/bot${c.telegram_token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ chat_id: c.telegram_chat_id, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[
        { text: '✅ Aprobar', callback_data: `la:${approveId}` }, { text: '❌ Denegar', callback_data: `ld:${approveId}` }] ] } }),
    });
    const d = await res.json().catch(() => ({}));
    return res.ok && d.ok ? d.result.message_id : null;
  } catch (_) { return null; }
}

// Crea la petición y la envía. null → no se pudo avisar a Telegram (el llamador decide qué hacer).
async function request({ user, ip, label, remember }) {
  purge();
  if (pending.size >= MAX_PENDING) return null;
  const approveId = rnd(), pollSecret = rnd();
  const e = { pollHash: sha(pollSecret), user, ip, label, remember: !!remember, expires: Date.now() + TTL_MS, status: 'pending', msgId: null };
  e.msgId = await sendRequest(approveId, e);
  if (e.msgId == null) return null;
  pending.set(approveId, e);
  return { pollSecret, expiresIn: TTL_MS / 1000 };
}

// Lo llama el bot al pulsar un botón. Devuelve el usuario/IP decididos, o null si ya no vale.
function decide(approveId, approve) {
  purge();
  const e = pending.get(approveId);
  if (!e || e.status !== 'pending') return null;
  e.status = approve ? 'approved' : 'denied';
  return e;
}

// Consulta del navegador. approved/denied se entregan UNA vez y se borran.
function poll(pollSecret) {
  purge();
  const h = sha(pollSecret);
  for (const [k, e] of pending) {
    if (e.pollHash !== h) continue;
    if (e.status !== 'pending') pending.delete(k);
    return { status: e.status, entry: e };
  }
  return { status: 'expired' };
}

module.exports = { request, decide, poll, telegramReady, TTL_MS };
