'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const files = require('../routes/files');

test('safePath normaliza rutas y rechaza NUL', () => {
  assert.strictEqual(files.safePath('/var/../tmp'), '/tmp');
  assert.strictEqual(files.safePath('etc/hosts'), '/etc/hosts');
  assert.strictEqual(files.safePath('/tmp' + String.fromCharCode(0) + '/x'), null);
});

test('isEditableText distingue texto de binarios', () => {
  assert.strictEqual(files.isEditableText('/srv/site/index.html', Buffer.from('<h1>Hola</h1>')), true);
  assert.strictEqual(files.isEditableText('/srv/site/notas', Buffer.from('texto plano')), true);
  assert.strictEqual(files.isEditableText('/srv/site/documento.docx', Buffer.from([80, 75, 3, 4, 0])), false);
});

test('languageFor devuelve un lenguaje útil para el editor', () => {
  assert.strictEqual(files.languageFor('/srv/site/index.html'), 'html');
  assert.strictEqual(files.languageFor('/srv/site/app.js'), 'javascript');
  assert.strictEqual(files.languageFor('/srv/site/README.md'), 'markdown');
  assert.strictEqual(files.languageFor('/srv/site/notas.txt'), 'text');
});
