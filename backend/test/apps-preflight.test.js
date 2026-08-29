'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { preflight, preflightOk } = require('../lib/apps/preflight');

test('Node: todo disponible → checks ok', () => {
  const checks = preflight({ runtime: 'node', nodeVersion: 'v20.11.0', npmVersion: '10.2.4' });
  assert.ok(preflightOk(checks));
  assert.deepStrictEqual(checks.map((c) => c.id), ['node', 'npm']);
});

test('Node: sin node/npm → falla con "cómo arreglarlo"', () => {
  const checks = preflight({ runtime: 'node', nodeVersion: null, npmVersion: null });
  assert.ok(!preflightOk(checks));
  assert.ok(checks.every((c) => !c.ok && /Plugins/.test(c.fix)));
});

test('Python: python + pip/venv → ok', () => {
  const checks = preflight({ runtime: 'python', pythonVersion: 'Python 3.11.2', pipOk: true });
  assert.ok(preflightOk(checks));
  assert.deepStrictEqual(checks.map((c) => c.id), ['python', 'venv']);
});

test('Python: falta venv → falla ese check', () => {
  const checks = preflight({ runtime: 'python', pythonVersion: 'Python 3.11.2', pipOk: false });
  assert.ok(!preflightOk(checks));
  const venv = checks.find((c) => c.id === 'venv');
  assert.strictEqual(venv.ok, false);
  assert.match(venv.fix, /venv/);
});

test('Puerto ocupado → añade check de puerto en falso', () => {
  const checks = preflight({ runtime: 'node', nodeVersion: 'v20', npmVersion: '10', portFree: false });
  assert.ok(!preflightOk(checks));
  assert.ok(checks.some((c) => c.id === 'port' && !c.ok));
});

test('portFree null (SPA estática) → no añade check de puerto', () => {
  const checks = preflight({ runtime: 'node', nodeVersion: 'v20', npmVersion: '10', portFree: null });
  assert.ok(preflightOk(checks));
  assert.ok(!checks.some((c) => c.id === 'port'));
});

test('runtime desconocido → falla', () => {
  const checks = preflight({ runtime: 'unknown' });
  assert.ok(!preflightOk(checks));
  assert.strictEqual(checks[0].id, 'runtime');
});
