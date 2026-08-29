'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { detect } = require('../lib/apps/detect');

test('Node server: express con start → PM2, no estático', () => {
  const d = detect({ pkg: { scripts: { start: 'node server.js' }, dependencies: { express: '^4' } }, files: ['package.json', 'server.js'] });
  assert.strictEqual(d.runtime, 'node');
  assert.strictEqual(d.type, 'nodejs');
  assert.strictEqual(d.servesStatic, false);
  assert.strictEqual(d.startCmd, 'npm start');
  assert.match(d.installCmd, /npm install/);
});

test('React CRA: build estático (react-scripts → build/, sin proceso)', () => {
  const d = detect({
    pkg: { scripts: { build: 'react-scripts build', start: 'react-scripts start' }, dependencies: { react: '^18' }, devDependencies: { 'react-scripts': '5' } },
    files: ['package.json', 'package-lock.json'],
  });
  assert.strictEqual(d.type, 'react');
  assert.strictEqual(d.servesStatic, true);
  assert.strictEqual(d.buildDir, 'build');
  assert.strictEqual(d.startCmd, '');
  assert.strictEqual(d.buildCmd, 'npm run build');
});

test('Vite SPA: estático → dist/, respeta el gestor (pnpm)', () => {
  const d = detect({ pkg: { scripts: { build: 'vite build' }, devDependencies: { vite: '^5' } }, files: ['package.json', 'pnpm-lock.yaml'] });
  assert.strictEqual(d.manager, 'pnpm');
  assert.strictEqual(d.servesStatic, true);
  assert.strictEqual(d.buildDir, 'dist');
  assert.strictEqual(d.buildCmd, 'pnpm run build');
});

test('Next.js: servidor (no estático) aunque tenga build', () => {
  const d = detect({ pkg: { scripts: { start: 'next start', build: 'next build' }, dependencies: { next: '^14', react: '^18' } }, files: ['package.json'] });
  assert.strictEqual(d.type, 'nodejs');
  assert.strictEqual(d.servesStatic, false);
  assert.strictEqual(d.startCmd, 'npm start');
});

test('Node sin start: usa el entry detectado', () => {
  const d = detect({ pkg: { dependencies: {} }, files: ['package.json', 'index.js'] });
  assert.strictEqual(d.startCmd, 'node index.js');
});

test('Node sin start ni entry: avisa', () => {
  const d = detect({ pkg: {}, files: ['package.json'] });
  assert.ok(d.warnings.some((w) => /entry|start/i.test(w)));
});

test('Python web: flask/gunicorn → venv + modo web', () => {
  const d = detect({ files: ['requirements.txt', 'app.py'], reqText: 'flask==3.0\ngunicorn' });
  assert.strictEqual(d.runtime, 'python');
  assert.strictEqual(d.mode, 'web');
  assert.match(d.installCmd, /venv/);
  assert.strictEqual(d.startCmd, 'python app.py');
});

test('Python worker: sin framework web → modo worker', () => {
  const d = detect({ files: ['bot.py', 'requirements.txt'], reqText: 'requests\nschedule' });
  assert.strictEqual(d.runtime, 'python');
  assert.strictEqual(d.mode, 'worker');
  assert.strictEqual(d.startCmd, 'python bot.py');
});

test('Python sin requirements: crea venv y avisa', () => {
  const d = detect({ files: ['main.py'] });
  assert.strictEqual(d.runtime, 'python');
  assert.ok(!/pip install/.test(d.installCmd));
  assert.ok(d.warnings.some((w) => /requirements/i.test(w)));
});

test('Desconocido: sin package.json ni Python', () => {
  const d = detect({ files: ['index.html', 'style.css'] });
  assert.strictEqual(d.runtime, 'unknown');
  assert.ok(d.warnings.length);
});
