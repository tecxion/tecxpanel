'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { isValidVersion, compareVersions, changelogSection, parseUpdateLog } = require('../lib/update');

test('compareVersions: compara número a número, no como texto', () => {
  assert.strictEqual(compareVersions('2.0.0', '2.1.0'), -1);
  assert.strictEqual(compareVersions('2.10.0', '2.9.0'), 1);
  assert.strictEqual(compareVersions('2.1.1', '2.1.1'), 0);
  assert.strictEqual(compareVersions('2.1.0', '2.1.1'), -1);
});

test('isValidVersion: solo X.Y.Z', () => {
  assert.ok(isValidVersion('2.1.0'));
  assert.ok(!isValidVersion('2.1'));
  assert.ok(!isValidVersion('v2.1.0'));
  assert.ok(!isValidVersion('2.1.0\n<script>'));
});

test('changelogSection: extrae solo la sección pedida', () => {
  const md = '# Changelog\n\n## 2.1.0 — 2026-10-26\n\n- A\n- B\n\n## 2.0.0\n\n- C\n';
  assert.strictEqual(changelogSection(md, '2.1.0'), '- A\n- B');
  assert.strictEqual(changelogSection(md, '2.0.0'), '- C');
  assert.strictEqual(changelogSection(md, '9.9.9'), '');
});

test('parseUpdateLog: solo la última ejecución y su resultado', () => {
  const raw = '__TXPL_UPDATE_START__ a\nviejo\n__TXPL_UPDATE_DONE__1\n__TXPL_UPDATE_START__ b\nnuevo\n';
  assert.deepStrictEqual(parseUpdateLog(raw), { text: 'nuevo', result: null });
  assert.strictEqual(parseUpdateLog(raw + '__TXPL_UPDATE_DONE__0').result, 0);
  assert.deepStrictEqual(parseUpdateLog(''), { text: '', result: null });
});
