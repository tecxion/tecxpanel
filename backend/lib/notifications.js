'use strict';

// ─────────────────────────────────────────────────────────────────
//  notifications.js — Helpers PUROS de notificaciones.
//  Sin estado, sin DB, sin red: solo funciones deterministas.
//  Unit-tested en backend/test/notifications.test.js.
// ─────────────────────────────────────────────────────────────────

// Anti-flapping: nº de ticks consecutivos en el nuevo estado antes de emitir.
const CONFIRM_TICKS = 2;

// ── Validadores de configuración ─────────────────────────────────

// Token de BotFather: "<id numérico>:<hash de 30+ chars url-safe>"
const TELEGRAM_TOKEN_RE = /^\d+:[A-Za-z0-9_-]{30,}$/;
function isValidTelegramToken(t) {
  return typeof t === 'string' && TELEGRAM_TOKEN_RE.test(t.trim());
}

// Chat ID: entero (negativo en grupos/supergrupos)
function isValidChatId(id) {
  if (id === null || id === undefined) return false;
  return /^-?\d+$/.test(String(id).trim());
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
function isValidSmtpConfig(cfg) {
  if (!cfg || typeof cfg !== 'object') return false;
  if (typeof cfg.host !== 'string' || !cfg.host.trim() || /\s/.test(cfg.host.trim())) return false;
  const port = Number(cfg.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return false;
  if (typeof cfg.from !== 'string' || !EMAIL_RE.test(cfg.from)) return false;
  if (typeof cfg.to !== 'string' || !EMAIL_RE.test(cfg.to)) return false;
  return true;
}

// ── Claves de recurso para notify_state ──────────────────────────

const resourceKey = {
  disk: () => 'disk',
  service: (name) => `service:${name}`,
  container: (name) => `container:${name}`,
};

module.exports = {
  CONFIRM_TICKS,
  isValidTelegramToken,
  isValidChatId,
  isValidSmtpConfig,
  resourceKey,
};
