'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { ok, fail, clientIp, runSafe, wrap } = require('../lib/helpers');
const {
  RE_APP_NAME, ALLOWED_APP_TYPES, ALLOWED_APP_ACTIONS,
  APP_BASE_ROOTS, isPort, isValidDomain,
  isValidGitUrl, isValidGitBranch, isAllowedBasePath,
} = require('../lib/validators');
const nginx = require('../lib/nginx');
const { queries, audit } = require('../database');
const {
  removeAppDir, buildPm2Launch, checkBuildRequirements,
  detectProject, flattenSingleSubdir,
} = require('../lib/appdeploy');
const { findFreePort } = require('../lib/catalogEngine');
const { detect } = require('../lib/apps/detect');
const { preflight, preflightOk } = require('../lib/apps/preflight');

const router = express.Router();

// Lee `pm2 jlist` una sola vez y devuelve un mapa {name: {status, restarts}}.
// Antes se llamaba una vez por app en Promise.all (N+1 spawns de pm2).
async function pm2Snapshot() {
  const r = await runSafe('pm2', ['jlist']);
  if (!r.ok) return null;
  try {
    const list = JSON.parse(r.stdout);
    const map = new Map();
    for (const p of list) {
      map.set(p.name, {
        status: p.pm2_env?.status === 'online' ? 'running' : 'stopped',
        restarts: p.pm2_env?.restart_time || 0,
      });
    }
    return map;
  } catch (_) { return null; }
}

router.get('/', wrap(async (req, res) => {
  const apps = queries.listApps.all();
  const snap = await pm2Snapshot();
  const enriched = apps.map((a) => {
    const info = snap?.get(a.pm2_name);
    return {
      id: a.id, name: a.name, type: a.type, path: a.path, start_cmd: a.start_cmd,
      port: a.port, domain: a.domain,
      git_repo: a.git_repo, git_branch: a.git_branch, webhook_secret: a.webhook_secret,
      status: snap ? (info ? info.status : 'stopped') : 'unknown',
      restarts: info?.restarts || 0,
    };
  });
  ok(res, enriched);
}));

const APP_TIMEOUT = { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 };
// Sin timeout práctico para install/build (npm/pip son lentos); buffer amplio.
const DEPLOY_STEP = { timeout: 900_000, maxBuffer: 32 * 1024 * 1024 };

// Lee del disco lo justo (package.json, ficheros de la raíz, requirements.txt) y
// delega en el detector PURO lib/apps/detect. Wrapper de I/O de esa función.
function readDetect(cwd) {
  let pkg = null;
  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) { try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch (_) { pkg = {}; } }
  const files = fs.existsSync(cwd) ? fs.readdirSync(cwd) : [];
  const reqPath = path.join(cwd, 'requirements.txt');
  const reqText = fs.existsSync(reqPath) ? fs.readFileSync(reqPath, 'utf8') : null;
  return detect({ pkg, files, reqText });
}

// Sonda de runtimes para el preflight puro (¿está node/npm/python/pip?).
async function probeRuntimes(runtime) {
  const o = { timeout: 10_000 };
  if (runtime === 'node') {
    const n = await runSafe('node', ['--version'], o);
    const m = await runSafe('npm', ['--version'], o);
    return { runtime, nodeVersion: n.ok ? n.stdout.trim() : null, npmVersion: m.ok ? m.stdout.trim() : null };
  }
  if (runtime === 'python') {
    const p = await runSafe('python3', ['--version'], o);
    const v = await runSafe('bash', ['-lc', 'python3 -m venv --help >/dev/null 2>&1 && python3 -m pip --version'], o);
    return { runtime, pythonVersion: p.ok ? (p.stdout.trim() || p.stderr.trim()) : null, pipOk: v.ok };
  }
  return { runtime };
}

// Crear app: solo registra y crea la carpeta o clona (NO arranca). El deploy va por pasos.
router.post('/', wrap(async (req, res) => {
  const { name, path: basePath, port, domain, git_repo, git_branch } = req.body || {};
  if (!RE_APP_NAME.test(name || '')) return fail(res, 400, 'Nombre de app inválido (solo letras, números, - y _)');
  if (queries.getAppByName.get(name)) return fail(res, 409, 'Ya existe una app con ese nombre');

  const portNum = port ? parseInt(port, 10) : null;
  if (port && !isPort(portNum)) return fail(res, 400, 'Puerto inválido');
  if (domain && !isValidDomain(domain)) return fail(res, 400, 'Dominio inválido');

  const rawBase = basePath || '/var/www';
  if (!isAllowedBasePath(rawBase)) return fail(res, 400, `Ruta base no permitida. Usa una dentro de: ${APP_BASE_ROOTS.join(', ')}`);
  const base = path.resolve(rawBase);
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
    // SEGURIDAD: rechazamos URLs raras (rutas locales, valores que empiezan
    // por "-" y git podría interpretar como flag --upload-pack=...).
    if (!isValidGitUrl(gitRepo)) return fail(res, 400, 'URL de repositorio Git inválida (usa https://…, git://… o git@host:usuario/repo.git)');
    if (!isValidGitBranch(gitBranch)) return fail(res, 400, 'Nombre de rama inválido');
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

// Guarda la configuración de despliegue editada por el usuario (comando, modo).
// En modo worker se limpian puerto y dominio (no escucha en red).
router.post('/:id/config', wrap(async (req, res) => {
  const appRow = queries.getApp.get(+req.params.id);
  if (!appRow) return fail(res, 404, 'App no encontrada');

  const startCmd = (req.body?.start_cmd || '').trim();
  if (!startCmd) return fail(res, 400, 'El comando de arranque es obligatorio');

  const type = ALLOWED_APP_TYPES.includes(req.body?.type) ? req.body.type : appRow.type;
  const mode = req.body?.mode === 'worker' ? 'worker' : 'web';

  let port = appRow.port;
  let domain = appRow.domain;
  if (mode === 'worker') { port = null; domain = null; }
  else {
    if (req.body?.port != null && req.body.port !== '') {
      const p = parseInt(req.body.port, 10);
      if (!isPort(p)) return fail(res, 400, 'Puerto inválido');
      port = p;
    }
    if (req.body?.domain) {
      if (!isValidDomain(req.body.domain)) return fail(res, 400, 'Dominio inválido');
      domain = req.body.domain;
    }
  }

  queries.setAppDeployConfig.run(type, startCmd, port, domain, appRow.id);
  audit(req.user.username, clientIp(req), 'app.config', `${appRow.name}: ${startCmd}`);
  ok(res, { success: true, type, start_cmd: startCmd, port, domain, mode });
}));

// POST /api/apps/:id/git-pull - Actualización manual de Git con re-compilación e inicio
// IMPORTANTE: debe ir ANTES de la ruta genérica '/:id/:action' para que Express
// no la interprete como una acción (si no, devolvería 400 "Acción no permitida").
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

  // Preservar el comando de arranque configurado por el usuario (no sobrescribirlo
  // con la auto-detección); solo refrescamos el tipo por si cambió el proyecto.
  queries.setAppConfig.run(det.type, appRow.start_cmd || det.startCmd, appRow.id);

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

// POST /api/apps/:id/deploy — DESPLIEGUE DE UNA PASADA (streaming).
// Orquesta extraer → detectar → preflight → instalar → build → arrancar → proxy,
// parando al primer fallo con mensaje claro y rollback. Sustituye al flujo manual
// por pasos (que sigue existiendo como fallback). Debe ir ANTES de '/:id/:action'.
router.post('/:id/deploy', wrap(async (req, res) => {
  const appRow = queries.getApp.get(+req.params.id);
  if (!appRow) return fail(res, 404, 'App no encontrada');
  const cwd = appRow.path;
  if (!fs.existsSync(cwd)) return fail(res, 400, 'La carpeta de la app ya no existe');

  audit(req.user.username, clientIp(req), 'app.deploy', appRow.name);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const w = (s) => res.write(s);
  const done = (code) => res.end(`\n__TXPL_DONE__${code}`);
  let startedPm2 = false, madeVhost = false;

  try {
    // 1. Extraer si hay un archivo subido en la carpeta.
    const archive = fs.readdirSync(cwd).find((f) => /\.(zip|tar\.gz|tgz|tar)$/i.test(f));
    if (archive) {
      w(`📦 Extrayendo ${archive}...\n`);
      const ap = path.join(cwd, archive);
      const low = archive.toLowerCase();
      let r;
      if (low.endsWith('.zip')) {
        if (!(await runSafe('unzip', ['-v'])).ok) await runSafe('apt-get', ['install', '-y', 'unzip'], { timeout: 120_000 });
        r = await runSafe('unzip', ['-o', ap, '-d', cwd], APP_TIMEOUT);
      } else if (low.endsWith('.tar.gz') || low.endsWith('.tgz')) {
        r = await runSafe('tar', ['-xzf', ap, '-C', cwd], APP_TIMEOUT);
      } else {
        r = await runSafe('tar', ['-xf', ap, '-C', cwd], APP_TIMEOUT);
      }
      if (!r.ok) throw new Error('No se pudo extraer el archivo: ' + (r.stderr.split('\n').filter(Boolean).slice(-1)[0] || ''));
      try { fs.unlinkSync(ap); } catch (_) {}
      flattenSingleSubdir(cwd);
    }

    // 2. Detectar el plan (detector puro).
    const det = readDetect(cwd);
    w(`🔎 Detectado: ${det.type}${det.servesStatic ? ' (SPA estática)' : det.mode === 'worker' ? ' (worker)' : ''}\n`);
    for (const warn of det.warnings) w(`   ⚠ ${warn}\n`);
    if (det.runtime === 'unknown') throw new Error('No se reconoció el proyecto (falta package.json o requirements.txt).');

    // Puerto solo para servicios web (no estático, no worker).
    const needsPort = !det.servesStatic && det.mode === 'web';
    let port = appRow.port;
    if (needsPort && !port) port = await findFreePort();

    // 3. Preflight (¿runtimes disponibles?).
    const probe = await probeRuntimes(det.runtime);
    const checks = preflight({ ...probe, portFree: needsPort ? (port != null) : null });
    for (const c of checks) w(`   ${c.ok ? '✓' : '✗'} ${c.message}${!c.ok && c.fix ? ' → ' + c.fix : ''}\n`);
    if (!preflightOk(checks)) throw new Error('Faltan requisitos en el servidor (ver arriba).');

    // Guardar la config detectada y recargar la fila.
    queries.setAppDeployConfig.run(det.type, det.startCmd || appRow.start_cmd || '', needsPort ? port : null, needsPort ? appRow.domain : null, appRow.id);
    const app2 = queries.getApp.get(appRow.id);

    // 4. Instalar dependencias.
    if (det.installCmd) {
      w(`\n$ ${det.installCmd}\n`);
      const r = await runSafe('bash', ['-lc', det.installCmd], { cwd, env: { ...process.env, NODE_ENV: 'development' }, ...DEPLOY_STEP });
      w(((r.stdout || r.stderr || '').trim() || 'Sin salida.') + '\n');
      if (!r.ok) throw new Error('Fallo al instalar dependencias.');
    }

    // 5. Build (si el proyecto lo tiene).
    if (det.buildCmd) {
      w(`\n$ ${det.buildCmd}\n`);
      const env = { ...process.env };
      if (port) env.PORT = String(port);
      const r = await runSafe('bash', ['-lc', det.buildCmd], { cwd, env, ...DEPLOY_STEP });
      w(((r.stdout || r.stderr || '').trim() || 'Sin salida.') + '\n');
      if (!r.ok) throw new Error('Fallo al compilar (build).');
    }

    // 6. Arranque.
    if (det.servesStatic) {
      // El servido estático por Nginx (root = build/) se completa en la Tarea 4.
      queries.setAppStatus.run('stopped', appRow.id);
      w(`\n🌐 SPA compilada en ${det.buildDir}/. Servir el estático por Nginx llega en la siguiente iteración.\n`);
    } else {
      w(`\n$ pm2 start  (${app2.start_cmd})\n`);
      const env = { ...process.env };
      if (port) env.PORT = String(port);
      await runSafe('pm2', ['delete', app2.pm2_name]).catch(() => {});
      const r = await runSafe('pm2', buildPm2Launch(app2), { cwd, env });
      if (!r.ok) throw new Error('PM2 no pudo arrancar la app: ' + (r.stderr.split('\n').filter(Boolean).slice(-1)[0] || ''));
      startedPm2 = true;
      await runSafe('pm2', ['save']).catch(() => {});
      queries.setAppStatus.run('running', appRow.id);
      w('✓ App arrancada en PM2.\n');

      // 7. Exponer: puerto en UFW + proxy Nginx si hay dominio.
      if (port) { await runSafe('ufw', ['allow', `${port}/tcp`]); w(`✓ Puerto ${port} abierto en el firewall.\n`); }
      if (app2.domain && port) {
        await nginx.enableSite(app2.pm2_name, nginx.buildProxy(app2.domain, port, { www: true }));
        madeVhost = true;
        w(`✓ Proxy Nginx: ${app2.domain} → :${port}\n`);
      }
    }

    w('\n✅ Despliegue completado.\n');
    done(0);
  } catch (e) {
    w(`\n✖ ${e.message}\n`);
    // Rollback best-effort: revertir proceso y proxy (los ficheros se conservan).
    if (startedPm2) await runSafe('pm2', ['delete', appRow.pm2_name]).catch(() => {});
    if (madeVhost) await nginx.removeSite(appRow.pm2_name).catch(() => {});
    queries.setAppStatus.run('stopped', appRow.id);
    w('↩ Rollback: proceso y proxy revertidos.\n');
    done(1);
  }
}));

// GET /api/apps/:id/env — Devuelve el contenido del fichero .env de la app.
// La ruta viene de la BD (appRow.path), no del usuario, así que es segura.
router.get('/:id/env', wrap(async (req, res) => {
  const appRow = queries.getApp.get(+req.params.id);
  if (!appRow) return fail(res, 404, 'App no encontrada');
  const envPath = path.join(appRow.path, '.env');
  if (!fs.existsSync(envPath)) return ok(res, { success: true, path: envPath, content: '', exists: false });
  const content = fs.readFileSync(envPath, 'utf8');
  ok(res, { success: true, path: envPath, content, exists: true });
}));

// PUT /api/apps/:id/env — Sobrescribe el .env. chmod 600 (solo owner puede leer).
// Aviso: hay que reiniciar la app para que los cambios surtan efecto.
router.put('/:id/env', wrap(async (req, res) => {
  const appRow = queries.getApp.get(+req.params.id);
  if (!appRow) return fail(res, 404, 'App no encontrada');
  if (!fs.existsSync(appRow.path)) return fail(res, 400, 'La carpeta de la app ya no existe');
  const content = typeof req.body?.content === 'string' ? req.body.content : '';
  if (content.length > 256 * 1024) return fail(res, 400, 'El .env es demasiado grande (máx 256 KB)');
  const envPath = path.join(appRow.path, '.env');
  fs.writeFileSync(envPath, content, { mode: 0o600 });
  try { fs.chmodSync(envPath, 0o600); } catch (_) {}
  audit(req.user.username, clientIp(req), 'app.env', appRow.name);
  ok(res, { success: true, path: envPath, bytes: Buffer.byteLength(content) });
}));

// POST /api/apps/:id/rebuild-proxy — Regenera el vhost nginx del proxy.
// Útil tras cambiar puerto o dominio sin tener que borrar y desplegar de nuevo.
router.post('/:id/rebuild-proxy', wrap(async (req, res) => {
  const appRow = queries.getApp.get(+req.params.id);
  if (!appRow) return fail(res, 404, 'App no encontrada');
  if (!appRow.domain) return fail(res, 400, 'Esta app no tiene dominio configurado');
  if (!appRow.port) return fail(res, 400, 'Se necesita un puerto para el proxy');
  try {
    await nginx.enableSite(appRow.pm2_name, nginx.buildProxy(appRow.domain, appRow.port, { www: true }));
  } catch (e) {
    return fail(res, 500, e.message);
  }
  audit(req.user.username, clientIp(req), 'app.rebuild-proxy', appRow.name);
  ok(res);
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

module.exports = router;
