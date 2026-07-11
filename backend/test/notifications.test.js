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
