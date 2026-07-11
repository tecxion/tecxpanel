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
