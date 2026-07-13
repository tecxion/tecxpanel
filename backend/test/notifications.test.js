const { test } = require('node:test');
const assert = require('node:assert');
const ntf = require('../lib/notifications');

// ── Validadores ──────────────────────────────────────────────────

test('isValidTelegramToken: acepta el formato <digitos>:<hash> de BotFather', () => {
  assert.ok(ntf.isValidTelegramToken('123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1'));
  assert.ok(ntf.isValidTelegramToken(' 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1 '), 'tolera espacios alrededor');
});

test('isValidTelegramToken: rechaza tokens malformados', () => {
  assert.strictEqual(ntf.isValidTelegramToken(''), false);
  assert.strictEqual(ntf.isValidTelegramToken('sin-dos-puntos'), false);
  assert.strictEqual(ntf.isValidTelegramToken('abc:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw1'), false, 'la parte izquierda debe ser numérica');
  assert.strictEqual(ntf.isValidTelegramToken('123:corto'), false, 'hash demasiado corto');
  assert.strictEqual(ntf.isValidTelegramToken(null), false);
  assert.strictEqual(ntf.isValidTelegramToken(12345), false);
});

test('isValidChatId: numérico, admite negativos (grupos)', () => {
  assert.ok(ntf.isValidChatId('123456789'));
  assert.ok(ntf.isValidChatId('-1001234567890'));
  assert.ok(ntf.isValidChatId(987654));
  assert.strictEqual(ntf.isValidChatId(''), false);
  assert.strictEqual(ntf.isValidChatId('abc'), false);
  assert.strictEqual(ntf.isValidChatId('12.5'), false);
  assert.strictEqual(ntf.isValidChatId(null), false);
});

test('isValidSmtpConfig: exige host, puerto 1-65535 y emails de/para', () => {
  const good = { host: 'smtp.ejemplo.com', port: 587, from: 'panel@ejemplo.com', to: 'admin@ejemplo.com' };
  assert.ok(ntf.isValidSmtpConfig(good));
  assert.strictEqual(ntf.isValidSmtpConfig({ ...good, host: '' }), false);
  assert.strictEqual(ntf.isValidSmtpConfig({ ...good, host: 'con espacios' }), false);
  assert.strictEqual(ntf.isValidSmtpConfig({ ...good, port: 0 }), false);
  assert.strictEqual(ntf.isValidSmtpConfig({ ...good, port: 70000 }), false);
  assert.strictEqual(ntf.isValidSmtpConfig({ ...good, port: 'abc' }), false);
  assert.strictEqual(ntf.isValidSmtpConfig({ ...good, from: 'no-es-email' }), false);
  assert.strictEqual(ntf.isValidSmtpConfig({ ...good, to: '' }), false);
  assert.strictEqual(ntf.isValidSmtpConfig(null), false);
});

// ── Claves de recurso ────────────────────────────────────────────

test('resourceKey: claves estables por tipo', () => {
  assert.strictEqual(ntf.resourceKey.disk(), 'disk');
  assert.strictEqual(ntf.resourceKey.service('nginx'), 'service:nginx');
  assert.strictEqual(ntf.resourceKey.container('txpl-n8n'), 'container:txpl-n8n');
});

test('CONFIRM_TICKS es 2 (anti-flapping)', () => {
  assert.strictEqual(ntf.CONFIRM_TICKS, 2);
});

// ── applyTick: transiciones + anti-flapping + reintento ──────────

const NOW = '2026-07-11T12:00:00.000Z';
const okState = { status: 'ok', pending_status: null, pending_count: 0, since: NOW, notified: 1 };
const downState = { status: 'down', pending_status: null, pending_count: 0, since: NOW, notified: 1 };

test('applyTick: recurso nuevo adopta el estado SIN notificar (primer avistamiento)', () => {
  const down = ntf.applyTick(null, 'down', NOW);
  assert.strictEqual(down.event, null);
  assert.strictEqual(down.next.status, 'down');
  assert.strictEqual(down.next.notified, 1);
  const okr = ntf.applyTick(null, 'ok', NOW);
  assert.strictEqual(okr.event, null);
  assert.strictEqual(okr.next.status, 'ok');
});

test('applyTick: ok→down requiere 2 ticks consecutivos', () => {
  const t1 = ntf.applyTick(okState, 'down', NOW);
  assert.strictEqual(t1.event, null, 'primer tick: aún no');
  assert.strictEqual(t1.next.status, 'ok', 'el estado confirmado no cambia todavía');
  assert.strictEqual(t1.next.pending_status, 'down');
  assert.strictEqual(t1.next.pending_count, 1);

  const t2 = ntf.applyTick(t1.next, 'down', NOW);
  assert.strictEqual(t2.event, 'down', 'segundo tick consecutivo: emite');
  assert.strictEqual(t2.next.status, 'down');
  assert.strictEqual(t2.next.pending_status, null);
  assert.strictEqual(t2.next.notified, 0, 'queda pendiente de entrega hasta que el monitor confirme');
});

test('applyTick: flapping suprimido (ok→down→ok no emite nada)', () => {
  const t1 = ntf.applyTick(okState, 'down', NOW);
  const t2 = ntf.applyTick(t1.next, 'ok', NOW);
  assert.strictEqual(t2.event, null);
  assert.strictEqual(t2.next.status, 'ok');
  assert.strictEqual(t2.next.pending_status, null, 'el pendiente se resetea');
  assert.strictEqual(t2.next.pending_count, 0);
});

test('applyTick: down→ok (2 ticks) emite recovered', () => {
  const t1 = ntf.applyTick(downState, 'ok', NOW);
  assert.strictEqual(t1.event, null);
  const t2 = ntf.applyTick(t1.next, 'ok', NOW);
  assert.strictEqual(t2.event, 'recovered');
  assert.strictEqual(t2.next.status, 'ok');
  assert.strictEqual(t2.next.notified, 0);
});

test('applyTick: estado estable no emite y no toca el estado', () => {
  const r = ntf.applyTick(okState, 'ok', NOW);
  assert.strictEqual(r.event, null);
  assert.deepStrictEqual(r.next, okState);
});

test('applyTick: notified=0 con estado estable re-emite (reintento de entrega)', () => {
  const unsent = { ...downState, notified: 0 };
  const r = ntf.applyTick(unsent, 'down', NOW);
  assert.strictEqual(r.event, 'down', 're-emite el evento no entregado');
  assert.strictEqual(r.next.notified, 0);
  const unsentOk = { ...okState, notified: 0 };
  const r2 = ntf.applyTick(unsentOk, 'ok', NOW);
  assert.strictEqual(r2.event, 'recovered');
});

test('applyTick: al confirmar el cambio, since se actualiza al now del tick', () => {
  const LATER = '2026-07-11T13:00:00.000Z';
  const t1 = ntf.applyTick(okState, 'down', LATER);
  const t2 = ntf.applyTick(t1.next, 'down', LATER);
  assert.strictEqual(t2.next.since, LATER);
});

// ── Constructores de eventos y mensajes ──────────────────────────

test('buildStatusEvent: servicio caído y recuperado', () => {
  const down = ntf.buildStatusEvent({ key: 'service:nginx', event: 'down', hostname: 'mi-vps', since: NOW, detail: null });
  assert.strictEqual(down.kind, 'down');
  assert.strictEqual(down.hostname, 'mi-vps');
  assert.strictEqual(down.title, 'Servicio nginx caído');
  const up = ntf.buildStatusEvent({ key: 'service:nginx', event: 'recovered', hostname: 'mi-vps', since: NOW, detail: null });
  assert.strictEqual(up.title, 'Servicio nginx recuperado');
});

test('buildStatusEvent: contenedor y disco', () => {
  const c = ntf.buildStatusEvent({ key: 'container:txpl-n8n', event: 'down', hostname: 'vps', since: NOW, detail: null });
  assert.strictEqual(c.title, 'Contenedor txpl-n8n caído');
  const d = ntf.buildStatusEvent({ key: 'disk', event: 'down', hostname: 'vps', since: NOW, detail: 'Uso: 93% (umbral 90%)' });
  assert.strictEqual(d.title, 'Disco por encima del umbral');
  assert.strictEqual(d.detail, 'Uso: 93% (umbral 90%)');
  const dr = ntf.buildStatusEvent({ key: 'disk', event: 'recovered', hostname: 'vps', since: NOW, detail: null });
  assert.strictEqual(dr.title, 'Disco de nuevo bajo el umbral');
});

test('buildSecurityEvent y buildTestEvent', () => {
  const s = ntf.buildSecurityEvent('vps', 'Bloqueo por fuerza bruta', 'IP 1.2.3.4 bloqueada 15 min');
  assert.strictEqual(s.kind, 'security');
  assert.strictEqual(s.title, 'Bloqueo por fuerza bruta');
  assert.strictEqual(s.since, null);
  const t = ntf.buildTestEvent('vps');
  assert.strictEqual(t.kind, 'test');
  assert.ok(t.title.length > 0);
});

test('buildTelegramMessage: emoji + hostname + título + detalle + desde', () => {
  const ev = ntf.buildStatusEvent({ key: 'service:nginx', event: 'down', hostname: 'mi-vps', since: NOW, detail: null });
  const text = ntf.buildTelegramMessage(ev);
  assert.ok(text.startsWith('🔴 [mi-vps] Servicio nginx caído'), text);
  assert.ok(text.includes('Desde:'), 'incluye la marca temporal');
  const up = ntf.buildTelegramMessage({ ...ev, kind: 'recovered', title: 'Servicio nginx recuperado' });
  assert.ok(up.startsWith('✅ '));
  const sec = ntf.buildTelegramMessage(ntf.buildSecurityEvent('vps', 'IP nueva', 'admin desde 1.2.3.4'));
  assert.ok(sec.startsWith('🛡️ [vps] IP nueva'));
  assert.ok(sec.includes('admin desde 1.2.3.4'));
  assert.ok(!sec.includes('Desde:'), 'los eventos puntuales no llevan "Desde:"');
});

test('buildEmailMessage: subject = línea de Telegram, body multilínea con firma', () => {
  const ev = ntf.buildStatusEvent({ key: 'disk', event: 'down', hostname: 'vps', since: NOW, detail: 'Uso: 93% (umbral 90%)' });
  const { subject, text } = ntf.buildEmailMessage(ev);
  assert.strictEqual(subject, '🔴 [vps] Disco por encima del umbral');
  assert.ok(text.includes('Uso: 93% (umbral 90%)'));
  assert.ok(text.includes('— TecXPaneL'));
});

// ── Caducidad de certificados SSL ────────────────────────────────

const { applySslThreshold, buildSslExpiryEvent, SSL_THRESHOLDS } = require('../lib/notifications');

test('SSL_THRESHOLDS: 15/7/1', () => {
  assert.deepStrictEqual(SSL_THRESHOLDS, [15, 7, 1]);
});

test('applySslThreshold: cruza umbrales una sola vez', () => {
  // Sin aviso previo, 60 días: nada.
  assert.deepStrictEqual(applySslThreshold(null, 60), { next: null, event: null });
  // Cae a 14: avisa umbral 15.
  assert.deepStrictEqual(applySslThreshold(null, 14), { next: 15, event: { type: 'threshold', threshold: 15 } });
  // Sigue en 12 con 15 ya avisado: silencio.
  assert.deepStrictEqual(applySslThreshold(15, 12), { next: 15, event: null });
  // Cae a 6: avisa umbral 7.
  assert.deepStrictEqual(applySslThreshold(15, 6), { next: 7, event: { type: 'threshold', threshold: 7 } });
  // Cae a 1: avisa umbral 1. daysLeft 0 (caducado) también es umbral 1.
  assert.deepStrictEqual(applySslThreshold(7, 1), { next: 1, event: { type: 'threshold', threshold: 1 } });
  assert.deepStrictEqual(applySslThreshold(null, 0), { next: 1, event: { type: 'threshold', threshold: 1 } });
  assert.deepStrictEqual(applySslThreshold(1, 0), { next: 1, event: null });
});

test('applySslThreshold: recuperación y casos borde', () => {
  // Renovado (>15) tras aviso: evento recovered y reset.
  assert.deepStrictEqual(applySslThreshold(7, 88), { next: null, event: { type: 'recovered' } });
  // Renovado sin aviso previo: silencio.
  assert.deepStrictEqual(applySslThreshold(null, 88), { next: null, event: null });
  // daysLeft null (parseo desconocido): no-op conservador.
  assert.deepStrictEqual(applySslThreshold(15, null), { next: 15, event: null });
  assert.deepStrictEqual(applySslThreshold(null, null), { next: null, event: null });
});

test('buildSslExpiryEvent: aviso y recuperación', () => {
  const ev = buildSslExpiryEvent({ name: 'vps.tecxart.es', domains: ['vps.tecxart.es'], daysLeft: 6, hostname: 'vps', recovered: false });
  assert.strictEqual(ev.kind, 'down');
  assert.ok(ev.title.includes('vps.tecxart.es') && ev.title.includes('6'));
  assert.ok(ev.detail.includes('vps.tecxart.es'));
  const rec = buildSslExpiryEvent({ name: 'vps.tecxart.es', domains: ['vps.tecxart.es'], daysLeft: 89, hostname: 'vps', recovered: true });
  assert.strictEqual(rec.kind, 'recovered');
  assert.ok(rec.title.includes('renovado'));
});
