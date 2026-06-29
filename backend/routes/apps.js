'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { ok, fail, clientIp, runSafe, wrap } = require('../lib/helpers');
const { RE_APP_NAME, ALLOWED_APP_TYPES, ALLOWED_APP_ACTIONS, isPort, isValidDomain } = require('../lib/validators');
const nginx = require('../lib/nginx');
const { queries, audit } = require('../database');
const {
  removeAppDir, buildPm2Launch, checkBuildRequirements,
  detectProject, flattenSingleSubdir,
} = require('../lib/appdeploy');

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
    git_repo: a.git_repo, git_branch: a.git_branch, webhook_secret: a.webhook_secret,
    status: await pm2Status(a.pm2_name),
  })));
  ok(res, enriched);
}));

const APP_TIMEOUT = { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 };

// Crear app: solo registra y crea la carpeta o clona (NO arranca). El deploy va por pasos.
router.post('/', wrap(async (req, res) => {
  const { name, path: basePath, port, domain, git_repo, git_branch } = req.body || {};
  if (!RE_APP_NAME.test(name || '')) return fail(res, 400, 'Nombre de app inválido (solo letras, números, - y _)');
  if (queries.getAppByName.get(name)) return fail(res, 409, 'Ya existe una app con ese nombre');

  const portNum = port ? parseInt(port, 10) : null;
  if (port && !isPort(portNum)) return fail(res, 400, 'Puerto inválido');
  if (domain && !isValidDomain(domain)) return fail(res, 400, 'Dominio inválido');

  const base = path.resolve(basePath || '/var/www');
  if (!fs.existsSync(base)) return fail(res, 400, 'La ruta base no existe');

  const cwd = path.join(base, name);
  if (fs.existsSync(cwd)) return fail(res, 409, `La carpeta "${cwd}" ya existe`);

  let isGit = false;
  let gitRepo = null;
  let gitBranch = 'main';
  let webhookSecret = null;

  if (git_repo && git_repo.trim()) {
    isGit = true;
    gitRepo = git_repo.trim();
    gitBranch = (git_branch || 'main').trim();
    webhookSecret = crypto.randomBytes(16).toString('hex');
  }

  if (!isGit) {
    fs.mkdirSync(cwd, { recursive: true });
  } else {
    // Intentar clonar el repositorio Git
    const cloneRes = await runSafe('git', ['clone', '--depth=1', '-b', gitBranch, gitRepo, cwd]);
    if (!cloneRes.ok) {
      removeAppDir(cwd);
      return fail(res, 400, `Error al clonar el repositorio Git: ${cloneRes.stderr}`);
    }
  }

  const pm2Name = `txpl-app-${name}`;
  let appType = 'nodejs';
  let startCmd = '';
  let detectedInfo = null;

  if (isGit) {
    // Detectar la configuración del proyecto clonado de inmediato
    const det = detectProject(cwd);
    appType = det.type;
    startCmd = det.startCmd;
    detectedInfo = det;
  }

  const info = queries.insertApp.run({
    name,
    type: appType,
    path: cwd,
    start_cmd: startCmd,
    port: portNum,
    domain: domain || null,
    pm2_name: pm2Name,
    status: 'stopped',
    git_repo: gitRepo,
    git_branch: gitBranch,
    webhook_secret: webhookSecret
  });

  audit(req.user.username, clientIp(req), 'app.create', name + (isGit ? ' (Git)' : ''));
  
  ok(res, {
    success: true,
    id: info.lastInsertRowid,
    path: cwd,
    isGit,
    webhook_secret: webhookSecret,
    detected: detectedInfo
  });
}));

// Paso de deploy: extrae el archivo subido y detecta el tipo de proyecto.
router.post('/:id/extract', wrap(async (req, res) => {
  const appRow = queries.getApp.get(+req.params.id);
  if (!appRow) return fail(res, 404, 'App no encontrada');
  const cwd = appRow.path;
  if (!fs.existsSync(cwd)) return fail(res, 400, 'La carpeta de la app ya no existe');

  const archive = fs.readdirSync(cwd).find((f) => /\.(zip|tar\.gz|tgz|tar)$/i.test(f));
  if (!archive) return fail(res, 400, 'No se encontró ningún archivo comprimido en la carpeta');
  const archivePath = path.join(cwd, archive);
  const lower = archive.toLowerCase();
  let r;

  if (lower.endsWith('.zip')) {
    let probe = await runSafe('unzip', ['-v']);
    if (!probe.ok) await runSafe('apt-get', ['install', '-y', 'unzip'], { timeout: 120_000 });
    r = await runSafe('unzip', ['-o', archivePath, '-d', cwd], APP_TIMEOUT);
  } else if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    r = await runSafe('tar', ['-xzf', archivePath, '-C', cwd], APP_TIMEOUT);
  } else {
    r = await runSafe('tar', ['-xf', archivePath, '-C', cwd], APP_TIMEOUT);
  }
  if (!r.ok) return fail(res, 500, r.stderr.split('\n').filter(Boolean).slice(-2).join(' ') || 'Error al extraer');

  try { fs.unlinkSync(archivePath); } catch (_) {}
  flattenSingleSubdir(cwd);

  const det = detectProject(cwd);
  queries.setAppConfig.run(det.type, det.startCmd, appRow.id);
  audit(req.user.username, clientIp(req), 'app.extract', appRow.name);
  ok(res, {
    success: true, detected: det,
    output: `Archivo "${archive}" extraído.\nProyecto: ${det.type}${det.notes.length ? ' (' + det.notes.join(', ') + ')' : ''}\nInstalar: ${det.installCmd || '—'}\nBuild: ${det.buildCmd || '—'}\nInicio: ${det.startCmd}`,
  });
}));

// Paso de deploy: instala dependencias.
router.post('/:id/install', wrap(async (req, res) => {
  const appRow = queries.getApp.get(+req.params.id);
  if (!appRow) return fail(res, 404, 'App no encontrada');
  if (!fs.existsSync(appRow.path)) return fail(res, 400, 'La carpeta de la app ya no existe');

  const det = detectProject(appRow.path);
  if (!det.installCmd) return ok(res, { success: true, ok: true, skipped: true, output: 'No hay dependencias que instalar.' });

  // NODE_ENV=development garantiza que se instalen las devDependencies
  const env = { ...process.env, NODE_ENV: 'development' };
  const r = await runSafe('bash', ['-lc', det.installCmd], { cwd: appRow.path, env, ...APP_TIMEOUT });
  audit(req.user.username, clientIp(req), 'app.install', appRow.name);
  const output = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
  ok(res, { success: true, ok: r.ok, command: det.installCmd, output: output || 'Sin salida' });
}));

// Paso de deploy: compila si el proyecto tiene script de build.
router.post('/:id/build', wrap(async (req, res) => {
  const appRow = queries.getApp.get(+req.params.id);
  if (!appRow) return fail(res, 404, 'App no encontrada');
  if (!fs.existsSync(appRow.path)) return fail(res, 400, 'La carpeta de la app ya no existe');

  const det = detectProject(appRow.path);
  if (!det.buildCmd) return ok(res, { success: true, ok: true, skipped: true, output: 'Este proyecto no requiere build.' });

  const env = { ...process.env };
  if (appRow.port) env.PORT = String(appRow.port);
  const r = await runSafe('bash', ['-lc', det.buildCmd], { cwd: appRow.path, env, ...APP_TIMEOUT });
  audit(req.user.username, clientIp(req), 'app.build', appRow.name);
  const output = [r.stdout, r.stderr].filter(Boolean).join('\n').trim();
  ok(res, { success: true, ok: r.ok, command: det.buildCmd, output: output || 'Sin salida' });
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

// Paso de deploy: expone la app. Abre el puerto (IP:puerto) y, si hay dominio, crea el proxy nginx.
router.post('/:id/proxy', wrap(async (req, res) => {
  const appRow = queries.getApp.get(+req.params.id);
  if (!appRow) return fail(res, 404, 'App no encontrada');
  const lines = [];

  // 1. Abrir el puerto en el firewall → acceso por IP:puerto
  if (appRow.port) {
    const u = await runSafe('ufw', ['allow', `${appRow.port}/tcp`]);
    lines.push(u.ok ? `Puerto ${appRow.port} abierto en el firewall` : `Aviso: no se pudo abrir el puerto (${u.stderr.split('\n')[0] || 'ufw'})`);
  }

  // 2. Si hay dominio, crear/actualizar el proxy de nginx → acceso por dominio.
  //    El vhost se llama como la app en PM2 (txpl-app-<nombre>) para localizarlo
  //    fácilmente al borrar. enableSite valida la config y revierte si falla.
  if (appRow.domain) {
    if (!appRow.port) return fail(res, 400, 'Se necesita un puerto para crear el proxy del dominio');
    try {
      await nginx.enableSite(appRow.pm2_name, nginx.buildProxy(appRow.domain, appRow.port, { www: true }));
    } catch (e) {
      return fail(res, 500, e.message);
    }
    lines.push(`Dominio ${appRow.domain} → puerto ${appRow.port} (proxy nginx activo)`);
  }

  audit(req.user.username, clientIp(req), 'app.proxy', appRow.name);
  ok(res, { success: true, output: lines.join('\n') || 'Sin cambios de red' });
}));

router.post('/:id/:action', wrap(async (req, res) => {
  const { action } = req.params;
  if (!ALLOWED_APP_ACTIONS.includes(action)) return fail(res, 400, 'Acción no permitida');
  const appRow = queries.getApp.get(+req.params.id);
  if (!appRow) return fail(res, 404, 'App no encontrada');

  if (action === 'delete') {
    await runSafe('pm2', ['delete', appRow.pm2_name]);
    await runSafe('pm2', ['save']);
    // Limpia el proxy nginx (si existía) y cierra el puerto del firewall.
    await nginx.removeSite(appRow.pm2_name);
    if (appRow.port) await runSafe('ufw', ['delete', 'allow', `${appRow.port}/tcp`]);
    // Borrado recursivo de la carpeta de la app (no deja nada)
    removeAppDir(appRow.path);
    queries.deleteApp.run(appRow.id);
  } else if (action === 'start') {
    if (!fs.existsSync(appRow.path)) return fail(res, 400, 'La carpeta de la app ya no existe');
    const prereq = checkBuildRequirements(appRow);
    if (prereq) return fail(res, 400, prereq);
    // Re-lanza desde cero para evitar fallos si PM2 ya no conoce el proceso
    await runSafe('pm2', ['delete', appRow.pm2_name]);
    const env = { ...process.env };
    if (appRow.port) env.PORT = String(appRow.port);
    const r = await runSafe('pm2', buildPm2Launch(appRow), { cwd: appRow.path, env });
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

// POST /api/apps/:id/git-pull - Actualización manual de Git con re-compilación e inicio
router.post('/:id/git-pull', wrap(async (req, res) => {
  const appRow = queries.getApp.get(+req.params.id);
  if (!appRow) return fail(res, 404, 'App no encontrada');
  if (!appRow.git_repo) return fail(res, 400, 'Esta aplicación no está configurada con un repositorio Git');
  const cwd = appRow.path;
  if (!fs.existsSync(cwd)) return fail(res, 400, 'La carpeta de la app ya no existe');

  const branch = appRow.git_branch || 'main';
  const lines = [];

  // 1. git fetch && git reset --hard
  lines.push(`$ git fetch --all && git reset --hard origin/${branch}`);
  const gitFetch = await runSafe('git', ['fetch', '--all'], { cwd });
  if (!gitFetch.ok) {
    return ok(res, { success: false, output: lines.join('\n') + `\n\nError al sincronizar repositorio (fetch):\n${gitFetch.stderr}` });
  }
  const gitReset = await runSafe('git', ['reset', '--hard', `origin/${branch}`], { cwd });
  if (!gitReset.ok) {
    return ok(res, { success: false, output: lines.join('\n') + `\n\nError al reiniciar código (reset):\n${gitReset.stderr}` });
  }
  lines.push(gitReset.stdout || 'Código reiniciado con éxito.');

  // Detectar proyecto
  const det = detectProject(cwd);

  // Actualizar comando si el tipo es nodejs/react/python etc.
  queries.setAppConfig.run(det.type, det.startCmd, appRow.id);

  // 2. Instalar dependencias con devDependencies
  if (det.installCmd) {
    lines.push(`\n$ ${det.installCmd}`);
    const env = { ...process.env, NODE_ENV: 'development' };
    const installRes = await runSafe('bash', ['-lc', det.installCmd], { cwd, env, timeout: 300_000 });
    lines.push(installRes.stdout || installRes.stderr || 'Dependencias instaladas.');
    if (!installRes.ok) {
      return ok(res, { success: false, output: lines.join('\n') + `\n\nError al instalar dependencias.` });
    }
  }

  // 3. Build si aplica
  if (det.buildCmd) {
    lines.push(`\n$ ${det.buildCmd}`);
    const env = { ...process.env };
    if (appRow.port) env.PORT = String(appRow.port);
    const buildRes = await runSafe('bash', ['-lc', det.buildCmd], { cwd, env, timeout: 300_000 });
    lines.push(buildRes.stdout || buildRes.stderr || 'Build completado.');
    if (!buildRes.ok) {
      return ok(res, { success: false, output: lines.join('\n') + `\n\nError al compilar el proyecto.` });
    }
  }

  // 4. PM2 Reload o restart
  lines.push(`\n$ pm2 reload ${appRow.pm2_name}`);
  const reloadRes = await runSafe('pm2', ['reload', appRow.pm2_name]);
  if (!reloadRes.ok) {
    // Si falla o no está iniciado en PM2, iniciamos/reiniciamos directamente
    const restartRes = await runSafe('pm2', ['restart', appRow.pm2_name]);
    lines.push(restartRes.stdout || restartRes.stderr || 'Aplicación reiniciada en PM2.');
  } else {
    lines.push(reloadRes.stdout || 'Aplicación recargada con éxito (Zero-Downtime).');
  }

  queries.setAppStatus.run('running', appRow.id);
  audit(req.user.username, clientIp(req), 'app.git-pull', appRow.name);

  ok(res, { success: true, output: lines.join('\n') });
}));

module.exports = router;
