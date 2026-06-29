'use strict';

const path = require('path');
const fs = require('fs');

// Entrypoints Python reconocidos (en orden de preferencia)
const PY_ENTRIES = ['app.py', 'main.py', 'wsgi.py', 'server.py', 'bot.py', 'run.py'];
// Frameworks que implican un servicio web (escucha en un puerto)
const PY_WEB_FRAMEWORKS = ['flask', 'fastapi', 'django', 'gunicorn', 'uvicorn'];

// Decide si un proyecto Python es "web" (puerto + proxy) o "worker" (sin puerto)
// mirando los frameworks declarados en requirements.txt.
function detectPyMode(cwd, reqPath) {
  try {
    if (!fs.existsSync(reqPath)) return 'worker';
    const reqs = fs.readFileSync(reqPath, 'utf8').toLowerCase();
    return PY_WEB_FRAMEWORKS.some((fw) => reqs.includes(fw)) ? 'web' : 'worker';
  } catch (_) { return 'worker'; }
}

// Borra recursivamente la carpeta de una app, con guardas de seguridad
// para no eliminar nunca rutas raíz o demasiado superficiales.
// (Evita catástrofes como borrar "/" o "/etc" si la ruta viene mal.)
function removeAppDir(dir) {
  if (!dir || typeof dir !== 'string') return;
  const resolved = path.resolve(dir);
  // Profundidad = nº de segmentos de la ruta. Menos de 2 es demasiado superficial.
  const depth = resolved.split(/[\\/]+/).filter(Boolean).length;
  const forbidden = ['/', '/root', '/etc', '/var', '/var/www', '/home', '/usr', '/opt', '/bin', '/boot'];
  if (depth < 2 || forbidden.includes(resolved)) return; // demasiado peligroso, no tocar
  try { fs.rmSync(resolved, { recursive: true, force: true }); } catch (_) {}
}

// Reconstruye los argumentos de pm2 start a partir de la config guardada en la BD.
function buildPm2Launch(appRow) {
  const pm2Name = appRow.pm2_name;
  const cwd = appRow.path;
  const cmd = (appRow.start_cmd || '').trim();
  // Opciones de PM2 — DEBEN ir antes del separador '--' para no pasarse al script
  const baseOpts = ['--name', pm2Name, '--cwd', cwd, '--max-restarts', '5', '--restart-delay', '3000'];
  let pm2Args;

  // Python: ejecutar siempre con el intérprete/binarios del virtualenv (.venv)
  if (appRow.type === 'python') {
    const venvBin = path.join(cwd, '.venv', 'bin');
    const parts = cmd.split(/\s+/).filter(Boolean);
    const first = parts[0] || 'python';
    if (/^python3?$/.test(first)) {
      const script = parts.slice(1).join(' ') || 'app.py';
      return ['start', script, ...baseOpts, '--interpreter', path.join(venvBin, 'python')];
    }
    // gunicorn / uvicorn / otro binario instalado en el venv
    return ['start', path.join(venvBin, first), ...baseOpts, '--interpreter', 'none', '--', ...parts.slice(1)];
  }

  if (/^(npm|yarn|pnpm)\b/.test(cmd)) {
    const parts = cmd.split(/\s+/);
    pm2Args = ['start', parts[0], ...baseOpts, '--', ...parts.slice(1)];
  } else if (/^node\s/.test(cmd)) {
    const parts = cmd.split(/\s+/);
    const script = parts.slice(1).join(' ') || 'index.js';
    pm2Args = ['start', script, ...baseOpts];
  } else {
    const script = cmd || 'index.js';
    pm2Args = ['start', script, ...baseOpts];
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

// Detecta tipo de proyecto y comandos de install/build/start desde los archivos.
function detectProject(cwd) {
  const det = { type: 'nodejs', manager: 'npm', installCmd: '', buildCmd: '', startCmd: '', notes: [], mode: 'web', pyFiles: [] };
  const pkgPath = path.join(cwd, 'package.json');
  const reqPath = path.join(cwd, 'requirements.txt');
  const hasPyFile = () => PY_ENTRIES.some((f) => fs.existsSync(path.join(cwd, f)));

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
    det.installCmd = mgr === 'npm' ? 'npm install --include=dev --also=dev'
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
    // Virtualenv por app: crea .venv y, si hay requirements.txt, instala dentro.
    // Evita el error PEP 668 (externally-managed-environment) del pip global.
    det.installCmd = fs.existsSync(reqPath)
      ? 'python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt'
      : 'python3 -m venv .venv';
    const entry = PY_ENTRIES.find((f) => fs.existsSync(path.join(cwd, f)));
    det.startCmd = `python ${entry || 'app.py'}`;
    det.mode = detectPyMode(cwd, reqPath);
    det.pyFiles = fs.readdirSync(cwd).filter((f) => f.endsWith('.py'));
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

module.exports = {
  removeAppDir,
  buildPm2Launch,
  checkBuildRequirements,
  detectProject,
  flattenSingleSubdir,
};
