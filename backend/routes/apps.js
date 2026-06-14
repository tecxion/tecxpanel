'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const { ok, fail, clientIp, runSafe, wrap } = require('../lib/helpers');
const { RE_APP_NAME, ALLOWED_APP_TYPES, ALLOWED_APP_ACTIONS, isPort, isValidDomain } = require('../lib/validators');
const { queries, audit } = require('../database');

const router = express.Router();

async function pm2Status(pm2Name) {
  const r = await runSafe('pm2', ['jlist']);
  if (!r.ok) return 'unknown';
  try {
    const list = JSON.parse(r.stdout);
    const proc = list.find((p) => p.name === pm2Name);
    return proc ? (proc.pm2_env.status === 'online' ? 'running' : 'stopped') : 'stopped';
  } catch (_) { return 'unknown'; }
}

// Reconstruye los argumentos de pm2 start a partir de la config guardada en la BD.
function buildPm2Launch(appRow) {
  const pm2Name = appRow.pm2_name;
  const cwd = appRow.path;
  const cmd = (appRow.start_cmd || '').trim();
  let pm2Args;

  if (/^(npm|yarn|pnpm)\b/.test(cmd)) {
    const parts = cmd.split(/\s+/);
    pm2Args = ['start', parts[0], '--name', pm2Name, '--cwd', cwd, '--', ...parts.slice(1)];
  } else if (/^(python3?|node)\s/.test(cmd)) {
    const parts = cmd.split(/\s+/);
    const interp = parts[0];
    const script = parts.slice(1).join(' ') || (interp.startsWith('python') ? 'app.py' : 'index.js');
    pm2Args = ['start', script, '--name', pm2Name, '--cwd', cwd];
    if (interp.startsWith('python')) pm2Args.push('--interpreter', interp);
  } else {
    const script = cmd || (appRow.type === 'python' ? 'app.py' : 'index.js');
    pm2Args = ['start', script, '--name', pm2Name, '--cwd', cwd];
    if (appRow.type === 'python') pm2Args.push('--interpreter', 'python3');
  }
  return pm2Args;
}

router.get('/', wrap(async (req, res) => {
  const apps = queries.listApps.all();
  const enriched = await Promise.all(apps.map(async (a) => ({
    id: a.id, name: a.name, type: a.type, port: a.port, domain: a.domain,
    status: await pm2Status(a.pm2_name),
  })));
  ok(res, enriched);
}));

const STARTER_FILES = {
  nodejs: { file: 'index.js', content: (port) => `const http = require('http');\nconst PORT = process.env.PORT || ${port || 3000};\nhttp.createServer((req, res) => {\n  res.writeHead(200, { 'Content-Type': 'text/plain' });\n  res.end('App running on port ' + PORT);\n}).listen(PORT, () => console.log('Listening on port ' + PORT));\n` },
  typescript: { file: 'index.ts', content: (port) => `import http from 'http';\nconst PORT = process.env.PORT || ${port || 3000};\nhttp.createServer((req, res) => {\n  res.writeHead(200, { 'Content-Type': 'text/plain' });\n  res.end('App running on port ' + PORT);\n}).listen(PORT, () => console.log('Listening on port ' + PORT));\n` },
  react: { file: 'package.json', content: () => JSON.stringify({ name: 'react-app', version: '1.0.0', scripts: { start: 'react-scripts start', build: 'react-scripts build' } }, null, 2) + '\n' },
  python: { file: 'app.py', content: (port) => `from http.server import HTTPServer, SimpleHTTPRequestHandler\n\nPORT = ${port || 8000}\nprint(f"Listening on port {PORT}")\nHTTPServer(("", PORT), SimpleHTTPRequestHandler).serve_forever()\n` },
};

router.post('/', wrap(async (req, res) => {
  const { name, type = 'nodejs', path: basePath, startCmd, port, domain } = req.body || {};
  if (!RE_APP_NAME.test(name || '')) return fail(res, 400, 'Nombre de app inválido (solo letras, números, - y _)');
  if (!ALLOWED_APP_TYPES.includes(type)) return fail(res, 400, 'Tipo de app inválido');
  if (queries.getAppByName.get(name)) return fail(res, 409, 'Ya existe una app con ese nombre');

  const portNum = port ? parseInt(port, 10) : null;
  if (port && !isPort(portNum)) return fail(res, 400, 'Puerto inválido');
  if (domain && !isValidDomain(domain)) return fail(res, 400, 'Dominio inválido');

  const base = path.resolve(basePath || '/var/www');
  if (!fs.existsSync(base)) return fail(res, 400, 'La ruta base no existe');

  const cwd = path.join(base, name);
  if (fs.existsSync(cwd)) return fail(res, 409, `La carpeta "${cwd}" ya existe`);

  fs.mkdirSync(cwd, { recursive: true });

  const starter = STARTER_FILES[type] || STARTER_FILES.nodejs;
  const cmd = (startCmd || '').trim();

  if (!cmd) {
    fs.writeFileSync(path.join(cwd, starter.file), starter.content(portNum));
  }

  const pm2Name = `txpl-app-${name}`;
  let pm2Args, script;

  if (/^(npm|yarn|pnpm)\b/.test(cmd)) {
    const parts = cmd.split(/\s+/);
    script = cmd;
    pm2Args = ['start', parts[0], '--name', pm2Name, '--cwd', cwd, '--', ...parts.slice(1)];
  } else if (/^(python3?|node)\s/.test(cmd)) {
    const parts = cmd.split(/\s+/);
    const interp = parts[0];
    script = parts.slice(1).join(' ') || (interp.startsWith('python') ? 'app.py' : 'index.js');
    pm2Args = ['start', script, '--name', pm2Name, '--cwd', cwd];
    if (interp.startsWith('python')) pm2Args.push('--interpreter', interp);
  } else {
    script = cmd || starter.file;
    pm2Args = ['start', script, '--name', pm2Name, '--cwd', cwd];
    if (type === 'python') pm2Args.push('--interpreter', 'python3');
  }

  const r = await runSafe('pm2', pm2Args, { cwd });
  if (!r.ok) return fail(res, 500, r.stderr.split('\n').slice(-2).join(' ') || 'PM2 no pudo iniciar la app');
  await runSafe('pm2', ['save']);

  const info = queries.insertApp.run({ name, type, path: cwd, start_cmd: script, port: portNum, domain: domain || null, pm2_name: pm2Name, status: 'running' });
  audit(req.user.username, clientIp(req), 'app.create', name);
  ok(res, { success: true, id: info.lastInsertRowid, path: cwd });
}));

// Ejecuta un comando arbitrario en la carpeta de la app (npm install, build, etc.)
router.post('/:id/exec', wrap(async (req, res) => {
  const appRow = queries.getApp.get(+req.params.id);
  if (!appRow) return fail(res, 404, 'App no encontrada');
  const command = (req.body?.command || '').trim();
  if (!command) return fail(res, 400, 'Comando requerido');
  if (!fs.existsSync(appRow.path)) return fail(res, 400, 'La carpeta de la app ya no existe');

  const r = await runSafe('bash', ['-lc', command], {
    cwd: appRow.path,
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  audit(req.user.username, clientIp(req), 'app.exec', `${appRow.name}: ${command}`);
  const output = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
  ok(res, { success: true, ok: r.ok, output: output || (r.ok ? 'Comando ejecutado (sin salida)' : 'Error sin salida') });
}));

// Atajo: instala dependencias según el gestor disponible
router.post('/:id/install', wrap(async (req, res) => {
  const appRow = queries.getApp.get(+req.params.id);
  if (!appRow) return fail(res, 404, 'App no encontrada');
  if (!fs.existsSync(appRow.path)) return fail(res, 400, 'La carpeta de la app ya no existe');

  let command;
  if (appRow.type === 'python' || fs.existsSync(path.join(appRow.path, 'requirements.txt'))) {
    command = 'pip3 install -r requirements.txt';
  } else if (fs.existsSync(path.join(appRow.path, 'pnpm-lock.yaml'))) {
    command = 'pnpm install';
  } else if (fs.existsSync(path.join(appRow.path, 'yarn.lock'))) {
    command = 'yarn install';
  } else {
    command = 'npm install';
  }

  const r = await runSafe('bash', ['-lc', command], {
    cwd: appRow.path,
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  audit(req.user.username, clientIp(req), 'app.install', appRow.name);
  const output = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
  ok(res, { success: true, ok: r.ok, command, output: output || 'Sin salida' });
}));

router.post('/:id/:action', wrap(async (req, res) => {
  const { action } = req.params;
  if (!ALLOWED_APP_ACTIONS.includes(action)) return fail(res, 400, 'Acción no permitida');
  const appRow = queries.getApp.get(+req.params.id);
  if (!appRow) return fail(res, 404, 'App no encontrada');

  if (action === 'delete') {
    await runSafe('pm2', ['delete', appRow.pm2_name]);
    await runSafe('pm2', ['save']);
    queries.deleteApp.run(appRow.id);
  } else if (action === 'start') {
    if (!fs.existsSync(appRow.path)) return fail(res, 400, 'La carpeta de la app ya no existe');
    // Re-lanza desde cero para evitar fallos si PM2 ya no conoce el proceso
    await runSafe('pm2', ['delete', appRow.pm2_name]);
    const r = await runSafe('pm2', buildPm2Launch(appRow), { cwd: appRow.path });
    if (!r.ok) {
      const msg = r.stderr.split('\n').filter(Boolean).slice(-2).join(' ') || 'PM2 no pudo iniciar la app';
      return fail(res, 500, msg);
    }
    await runSafe('pm2', ['save']);
    queries.setAppStatus.run('running', appRow.id);
  } else {
    const r = await runSafe('pm2', [action, appRow.pm2_name]);
    if (!r.ok) return fail(res, 500, r.stderr.split('\n').filter(Boolean).slice(-1)[0] || 'Error de PM2');
    queries.setAppStatus.run(action === 'stop' ? 'stopped' : 'running', appRow.id);
  }
  audit(req.user.username, clientIp(req), 'app.' + action, appRow.name);
  ok(res);
}));

router.get('/:id/logs', wrap(async (req, res) => {
  const appRow = queries.getApp.get(+req.params.id);
  if (!appRow) return fail(res, 404, 'App no encontrada');
  const r = await runSafe('pm2', ['logs', appRow.pm2_name, '--lines', '200', '--nostream', '--raw']);
  ok(res, { logs: r.stdout || r.stderr || 'Sin logs' });
}));

module.exports = router;
