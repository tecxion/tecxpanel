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

// ── Transiciones de estado (anti-flapping + reintento) ───────────
//
// applyTick(prev, currentStatus, now) → { next, event }
//   - prev: fila de notify_state (o null si el recurso es nuevo).
//   - currentStatus: 'ok' | 'down' según el chequeo de este tick.
//   - event: null | 'down' | 'recovered'. Si emite, next.notified=0 y
//     el monitor lo pondrá a 1 cuando algún canal entregue.
//
// Reglas:
//   1. Recurso nuevo: adopta el estado sin notificar (evita spam en
//      instalaciones con servicios parados a propósito).
//   2. Cambio de estado: exige CONFIRM_TICKS ticks consecutivos
//      (anti-flapping: reiniciar nginx desde el panel no notifica).
//   3. Estado estable con notified=0: re-emite (la entrega falló en
//      un tick anterior y no se puede perder el aviso).

function applyTick(prev, currentStatus, now) {
  // 1. Primer avistamiento
  if (!prev) {
    return {
      next: { status: currentStatus, pending_status: null, pending_count: 0, since: now, notified: 1 },
      event: null,
    };
  }

  if (currentStatus === prev.status) {
    // 3. Reintento de entrega pendiente
    if (!prev.notified) {
      return { next: { ...prev, notified: 0 }, event: prev.status === 'down' ? 'down' : 'recovered' };
    }
    // Flapping suprimido: había un cambio a medio confirmar que no se consolidó
    if (prev.pending_status) {
      return { next: { ...prev, pending_status: null, pending_count: 0 }, event: null };
    }
    return { next: prev, event: null };
  }

  // 2. Cambio respecto al estado confirmado: contar confirmaciones
  const count = prev.pending_status === currentStatus ? prev.pending_count + 1 : 1;
  if (count >= CONFIRM_TICKS) {
    return {
      next: { status: currentStatus, pending_status: null, pending_count: 0, since: now, notified: 0 },
      event: currentStatus === 'down' ? 'down' : 'recovered',
    };
  }
  return { next: { ...prev, pending_status: currentStatus, pending_count: count }, event: null };
}

module.exports = {
  CONFIRM_TICKS,
  isValidTelegramToken,
  isValidChatId,
  isValidSmtpConfig,
  resourceKey,
  applyTick,
};
