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

// ── Constructores de eventos y mensajes ──────────────────────────

const EVENT_EMOJI = { down: '🔴', recovered: '✅', security: '🛡️', test: '🔔' };

// Marca temporal legible; los tests no asertan el formato exacto
// (depende del ICU del sistema), solo que aparece tras "Desde:".
function fmtTime(iso) {
  try { return new Date(iso).toLocaleString('es-ES', { hour12: false }); }
  catch (_) { return String(iso); }
}

// Evento de estado a partir de la clave de recurso.
function buildStatusEvent({ key, event, hostname, since, detail }) {
  const [type, name] = key.includes(':') ? key.split(':') : [key, null];
  let title;
  if (type === 'disk') {
    title = event === 'down' ? 'Disco por encima del umbral' : 'Disco de nuevo bajo el umbral';
  } else if (type === 'service') {
    title = `Servicio ${name} ${event === 'down' ? 'caído' : 'recuperado'}`;
  } else {
    title = `Contenedor ${name} ${event === 'down' ? 'caído' : 'recuperado'}`;
  }
  return { kind: event, hostname, title, detail: detail || null, since: since || null };
}

// Evento puntual de seguridad (sin estado ni recuperación).
function buildSecurityEvent(hostname, title, detail) {
  return { kind: 'security', hostname, title, detail: detail || null, since: null };
}

// Evento del botón "Enviar prueba".
function buildTestEvent(hostname) {
  return {
    kind: 'test',
    hostname,
    title: 'Notificación de prueba de TecXPaneL',
    detail: 'Si lees esto, el canal funciona correctamente.',
    since: null,
  };
}

function buildTelegramMessage(ev) {
  const emoji = EVENT_EMOJI[ev.kind] || '🔔';
  let text = `${emoji} [${ev.hostname}] ${ev.title}`;
  if (ev.detail) text += `\n${ev.detail}`;
  if (ev.since) text += `\nDesde: ${fmtTime(ev.since)}`;
  return text;
}

function buildEmailMessage(ev) {
  const emoji = EVENT_EMOJI[ev.kind] || '🔔';
  const subject = `${emoji} [${ev.hostname}] ${ev.title}`;
  const lines = [ev.title];
  if (ev.detail) lines.push(ev.detail);
  if (ev.since) lines.push(`Desde: ${fmtTime(ev.since)}`);
  lines.push('', '— TecXPaneL');
  return { subject, text: lines.join('\n') };
}

module.exports = {
  CONFIRM_TICKS,
  isValidTelegramToken,
  isValidChatId,
  isValidSmtpConfig,
  resourceKey,
  applyTick,
  buildStatusEvent,
  buildSecurityEvent,
  buildTestEvent,
  buildTelegramMessage,
  buildEmailMessage,
};
