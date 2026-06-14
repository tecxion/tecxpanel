'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const { ok, fail, clientIp, runSafe, wrap } = require('../lib/helpers');
const { RE_APP_NAME, ALLOWED_APP_TYPES, ALLOWED_APP_ACTIONS, isPort, isValidDomain } = require('../lib/validators');
const { queries, audit } = require('../database');

const NGINX_AVAILABLE = '/etc/nginx/sites-available';
const NGINX_ENABLED = '/etc/nginx/sites-enabled';

const router = express.Router();

// Borra recursivamente la carpeta de una app, con guardas de seguridad
// para no eliminar nunca rutas raíz o demasiado superficiales.
function removeAppDir(dir) {
  if (!dir || typeof dir !== 'string') return;
  const resolved = path.resolve(dir);
  const depth = resolved.split(/[\\/]+/).filter(Boolean).length;
  const forbidden = ['/', '/root', '/etc', '/var', '/var/www', '/home', '/usr', '/opt', '/bin', '/boot'];
  if (depth < 2 || forbidden.includes(resolved)) return; // demasiado peligroso, no tocar
  try { fs.rmSync(resolved, { recursive: true, force: true }); } catch (_) {}
}

// Config nginx que enruta un dominio hacia el puerto local de la app.
function buildAppProxy(domain, port) {
  return `server {
    listen 80;
    server_name ${domain} www.${domain};
    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
`;
}

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
  // Opciones de PM2 — DEBEN ir antes del separador '--' para no pasarse al script
  const baseOpts = ['--name', pm2Name, '--cwd', cwd, '--max-restarts', '5', '--restart-delay', '3000'];
  let pm2Args;

  if (/^(npm|yarn|pnpm)\b/.test(cmd)) {
    const parts = cmd.split(/\s+/);
    pm2Args = ['start', parts[0], ...baseOpts, '--', ...parts.slice(1)];
  } else if (/^(python3?|node)\s/.test(cmd)) {
    const parts = cmd.split(/\s+/);
    const interp = parts[0];
    const script = parts.slice(1).join(' ') || (interp.startsWith('python') ? 'app.py' : 'index.js');
    pm2Args = ['start', script, ...baseOpts];
    if (interp.startsWith('python')) pm2Args.push('--interpreter', interp);
  } else {
    const script = cmd || (appRow.type === 'python' ? 'app.py' : 'index.js');
    pm2Args = ['start', script, ...baseOpts];
    if (appRow.type === 'python') pm2Args.push('--interpreter', 'python3');
  }
  return pm2Args;
}

// Comprueba requisitos previos según el tipo de proyecto antes de arrancar.
function checkBuildRequirements(appRow) {
  const cwd = appRow.path;
  const cmd = (appRow.start_cmd || '').trim();
  try {
    const pkgPath = path.join(cwd, 'package.json');
    if (!fs.existsSync(pkgPath)) return null;

    // node_modules ausente con comando npm/yarn/pnpm
    if (/^(npm|yarn|pnpm)\b/.test(cmd) && !fs.existsSync(path.join(cwd, 'node_modules'))) {
      return 'Faltan las dependencias. Pulsa el botón de instalar (📦) o ejecuta "npm install" en la consola antes de iniciar.';
    }

    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const startScript = (pkg.scripts && pkg.scripts.start) || '';

    // Next.js: "next start" necesita un build previo (.next)
    if ((deps.next || /\bnext start\b/.test(startScript)) && /next start/.test(startScript)) {
      if (!fs.existsSync(path.join(cwd, '.next'))) {
        return 'Es una app Next.js sin compilar. Abre la consola y ejecuta "npm run build" antes de iniciar.';
      }
    }
  } catch (_) { /* si falla la comprobación, dejamos que PM2 lo intente */ }
  return null;
}

router.get('/', wrap(async (req, res) => {
  const apps = queries.listApps.all();
  const enriched = await Promise.all(apps.map(async (a) => ({
    id: a.id, name: a.name, type: a.type, port: a.port, domain: a.domain,
    status: await pm2Status(a.pm2_name),
  })));
  ok(res, enriched);
}));

// Detecta tipo de proyecto y comandos de install/build/start desde los archivos.
function detectProject(cwd) {
  const det = { type: 'nodejs', manager: 'npm', installCmd: '', buildCmd: '', startCmd: '', notes: [] };
  const pkgPath = path.join(cwd, 'package.json');
  const reqPath = path.join(cwd, 'requirements.txt');
  const hasPyFile = () => ['app.py', 'main.py', 'wsgi.py', 'server.py'].some((f) => fs.existsSync(path.join(cwd, f)));

  if (fs.existsSync(pkgPath)) {
    let pkg = {};
    try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch (_) {}
    const scripts = pkg.scripts || {};
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };

    let mgr = 'npm';
    if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) mgr = 'pnpm';
    else if (fs.existsSync(path.join(cwd, 'yarn.lock'))) mgr = 'yarn';
    det.manager = mgr;
    // IMPORTANTE: forzar la instalación de devDependencies (necesarias para el build,
    // ej. tailwindcss). Si no, con NODE_ENV=production npm/yarn/pnpm las omiten.
    det.installCmd = mgr === 'npm' ? 'npm install --include=dev'
      : mgr === 'yarn' ? 'yarn install --production=false'
      : 'pnpm install --prod=false';

    if (scripts.build) det.buildCmd = mgr === 'npm' ? 'npm run build' : `${mgr} run build`;

    if (scripts.start) {
      det.startCmd = mgr === 'npm' ? 'npm start' : `${mgr} start`;
    } else if (deps.next) {
      det.startCmd = 'npx next start';
    } else {
      const entry = (pkg.main && fs.existsSync(path.join(cwd, pkg.main)) && pkg.main)
        || ['server.js', 'index.js', 'app.js', 'main.js'].find((f) => fs.existsSync(path.join(cwd, f)));
      det.startCmd = entry ? `node ${entry}` : 'npm start';
    }

    if (deps.next) det.notes.push('Next.js detectado');
    det.type = deps.react && !deps.next ? 'react' : 'nodejs';
  } else if (fs.existsSync(reqPath) || hasPyFile()) {
    det.type = 'python';
    det.manager = 'pip';
    det.installCmd = fs.existsSync(reqPath) ? 'pip3 install -r requirements.txt' : '';
    const entry = ['app.py', 'main.py', 'wsgi.py', 'server.py'].find((f) => fs.existsSync(path.join(cwd, f)));
    det.startCmd = `python3 ${entry || 'app.py'}`;
  } else {
    det.notes.push('No se detectó package.json ni requirements.txt');
    det.startCmd = 'npm start';
  }
  return det;
}

// Si el zip se extrajo dentro de una única subcarpeta, sube su contenido a la raíz.
function flattenSingleSubdir(cwd) {
  const entries = fs.readdirSync(cwd, { withFileTypes: true });
  const hasRootManifest = entries.some((e) => e.isFile() && ['package.json', 'requirements.txt'].includes(e.name));
  if (hasRootManifest) return;
  const dirs = entries.filter((e) => e.isDirectory());
  if (entries.length !== 1 || dirs.length !== 1) return;
  const sub = path.join(cwd, dirs[0].name);
  const subHasManifest = ['package.json', 'requirements.txt'].some((f) => fs.existsSync(path.join(sub, f)));
  if (!subHasManifest) return;
  for (const item of fs.readdirSync(sub)) {
    fs.renameSync(path.join(sub, item), path.join(cwd, item));
  }
  fs.rmdirSync(sub);
}

const APP_TIMEOUT = { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 };

// Crear app: solo registra y crea la carpeta (NO arranca). El deploy va por pasos.
router.post('/', wrap(async (req, res) => {
  const { name, path: basePath, port, domain } = req.body || {};
  if (!RE_APP_NAME.test(name || '')) return fail(res, 400, 'Nombre de app inválido (solo letras, números, - y _)');
  if (queries.getAppByName.get(name)) return fail(res, 409, 'Ya existe una app con ese nombre');

  const portNum = port ? parseInt(port, 10) : null;
  if (port && !isPort(portNum)) return fail(res, 400, 'Puerto inválido');
  if (domain && !isValidDomain(domain)) return fail(res, 400, 'Dominio inválido');

  const base = path.resolve(basePath || '/var/www');
  if (!fs.existsSync(base)) return fail(res, 400, 'La ruta base no existe');

  const cwd = path.join(base, name);
  if (fs.existsSync(cwd)) return fail(res, 409, `La carpeta "${cwd}" ya existe`);
  fs.mkdirSync(cwd, { recursive: true });

  const pm2Name = `txpl-app-${name}`;
  const info = queries.insertApp.run({
    name, type: 'nodejs', path: cwd, start_cmd: '', port: portNum,
    domain: domain || null, pm2_name: pm2Name, status: 'stopped',
  });
  audit(req.user.username, clientIp(req), 'app.create', name);
  ok(res, { success: true, id: info.lastInsertRowid, path: cwd });
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

  // 2. Si hay dominio, crear/actualizar el proxy de nginx → acceso por dominio
  if (appRow.domain) {
    if (!appRow.port) return fail(res, 400, 'Se necesita un puerto para crear el proxy del dominio');
    const confName = appRow.pm2_name; // txpl-app-<nombre>
    const confPath = path.join(NGINX_AVAILABLE, confName);
    fs.writeFileSync(confPath, buildAppProxy(appRow.domain, appRow.port));
    try { fs.symlinkSync(confPath, path.join(NGINX_ENABLED, confName)); } catch (e) { if (e.code !== 'EEXIST') throw e; }

    const test = await runSafe('nginx', ['-t']);
    if (!test.ok) {
      fs.rmSync(path.join(NGINX_ENABLED, confName), { force: true });
      return fail(res, 500, 'Config nginx inválida: ' + (test.stderr.split('\n').find((l) => /error|emerg/i.test(l)) || test.stderr.split('\n')[0]));
    }
    await runSafe('systemctl', ['reload', 'nginx']);
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
    // Limpia el proxy nginx y cierra el puerto si existían
    const confName = appRow.pm2_name;
    let removedProxy = false;
    try { if (fs.existsSync(path.join(NGINX_ENABLED, confName))) { fs.rmSync(path.join(NGINX_ENABLED, confName), { force: true }); removedProxy = true; } } catch (_) {}
    try { fs.rmSync(path.join(NGINX_AVAILABLE, confName), { force: true }); } catch (_) {}
    if (removedProxy) await runSafe('systemctl', ['reload', 'nginx']);
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
