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

router.get('/', wrap(async (req, res) => {
  const apps = queries.listApps.all();
  const enriched = await Promise.all(apps.map(async (a) => ({
    id: a.id, name: a.name, type: a.type, port: a.port, domain: a.domain,
    status: await pm2Status(a.pm2_name),
  })));
  ok(res, enriched);
}));

router.post('/', wrap(async (req, res) => {
  const { name, type = 'nodejs', path: appPath, startCmd, port, domain } = req.body || {};
  if (!RE_APP_NAME.test(name || '')) return fail(res, 400, 'Nombre de app inválido (solo letras, números, - y _)');
  if (!ALLOWED_APP_TYPES.includes(type)) return fail(res, 400, 'Tipo de app inválido');
  if (queries.getAppByName.get(name)) return fail(res, 409, 'Ya existe una app con ese nombre');

  const portNum = port ? parseInt(port, 10) : null;
  if (port && !isPort(portNum)) return fail(res, 400, 'Puerto inválido');
  if (domain && !isValidDomain(domain)) return fail(res, 400, 'Dominio inválido');

  const cwd = path.resolve(appPath || '');
  if (!appPath || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) return fail(res, 400, 'La ruta del proyecto no existe');

  const pm2Name = `txpl-app-${name}`;
  const cmd = (startCmd || '').trim();
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
    script = cmd || (type === 'python' ? 'app.py' : 'index.js');
    const fullPath = path.join(cwd, script);
    if (!fs.existsSync(fullPath)) return fail(res, 400, `No se encontró "${script}" en ${cwd}. Escribe el archivo a ejecutar (ej: server.js) o un comando npm (ej: npm start).`);
    pm2Args = ['start', script, '--name', pm2Name, '--cwd', cwd];
    if (type === 'python') pm2Args.push('--interpreter', 'python3');
  }

  const r = await runSafe('pm2', pm2Args, { cwd });
  if (!r.ok) return fail(res, 500, r.stderr.split('\n').slice(-2).join(' ') || 'PM2 no pudo iniciar la app');
  await runSafe('pm2', ['save']);

  const info = queries.insertApp.run({ name, type, path: cwd, start_cmd: script, port: portNum, domain: domain || null, pm2_name: pm2Name, status: 'running' });
  audit(req.user.username, clientIp(req), 'app.create', name);
  ok(res, { success: true, id: info.lastInsertRowid });
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
  } else {
    const r = await runSafe('pm2', [action, appRow.pm2_name]);
    if (!r.ok) return fail(res, 500, r.stderr.split('\n').slice(-1)[0] || 'Error de PM2');
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
