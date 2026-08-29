'use strict';
// ============================================================
//  TecXPaneL — lib/apps/detect.js
//  Detección PURA del tipo de proyecto y su plan de despliegue a partir de datos
//  YA leídos de disco (package.json parseado, lista de ficheros de la raíz y el
//  contenido de requirements.txt). Sin I/O → testeable en aislamiento. El wrapper
//  con acceso a disco (el endpoint de deploy) lee los ficheros y llama a detect().
//  Sustituye a la lógica mezclada de detectProject() cuando se cablee (Tarea 3).
// ============================================================

// Frameworks Python que implican un servicio web (escuchan en un puerto).
const PY_WEB_FRAMEWORKS = ['flask', 'fastapi', 'django', 'gunicorn', 'uvicorn'];
const PY_ENTRIES = ['app.py', 'main.py', 'wsgi.py', 'server.py', 'bot.py', 'run.py'];
// Bundlers de frontend que producen un build ESTÁTICO (se sirve por Nginx, sin
// proceso). dep -> carpeta de salida del build.
const STATIC_BUILDERS = { 'react-scripts': 'build', vite: 'dist', '@angular/cli': 'dist', parcel: 'dist', '@vue/cli-service': 'dist' };
// Frameworks Node que SÍ necesitan un proceso servidor (aunque tengan build).
const NODE_SERVER_DEPS = ['next', 'nuxt', 'express', 'fastify', 'koa', '@nestjs/core'];

function pickManager(files) {
  if (files.includes('pnpm-lock.yaml')) return 'pnpm';
  if (files.includes('yarn.lock')) return 'yarn';
  return 'npm';
}

// Fuerza devDependencies (necesarias para el build: tailwind, vite, etc.).
function installCmdFor(manager) {
  return manager === 'npm' ? 'npm install --include=dev'
    : manager === 'yarn' ? 'yarn install --production=false'
    : 'pnpm install --prod=false';
}

// detect({ pkg, files, reqText }) → plan de despliegue.
//   pkg     = objeto package.json ya parseado, o null
//   files   = nombres de ficheros/carpetas de la raíz del proyecto (array de strings)
//   reqText = contenido de requirements.txt, o null si no existe
function detect({ pkg = null, files = [], reqText = null } = {}) {
  const has = (f) => files.includes(f);
  const warnings = [];

  // ── Node / React ──────────────────────────────────────────
  if (pkg) {
    const scripts = pkg.scripts || {};
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const manager = pickManager(files);
    const run = (s) => (manager === 'npm' ? `npm run ${s}` : `${manager} run ${s}`);
    const buildCmd = scripts.build ? run('build') : '';

    // ¿Build estático (SPA por Nginx) o servidor Node (PM2)?
    const staticDep = Object.keys(STATIC_BUILDERS).find((d) => deps[d]);
    const isServer = NODE_SERVER_DEPS.some((d) => deps[d]);
    if (staticDep && buildCmd && !isServer) {
      const buildDir = STATIC_BUILDERS[staticDep];
      warnings.push(`SPA estática (${staticDep}): tras el build se sirve ${buildDir}/ por Nginx, sin proceso.`);
      return {
        runtime: 'node', type: 'react', manager,
        installCmd: installCmdFor(manager), buildCmd,
        startCmd: '', servesStatic: true, buildDir, port: null, mode: 'static', warnings,
      };
    }

    // Servidor Node: comando de arranque.
    let startCmd;
    if (scripts.start) startCmd = manager === 'npm' ? 'npm start' : `${manager} start`;
    else if (deps.next) startCmd = 'npx next start';
    else {
      const entry = (pkg.main && has(pkg.main) && pkg.main)
        || ['server.js', 'index.js', 'app.js', 'main.js'].find(has);
      startCmd = entry ? `node ${entry}` : 'npm start';
      if (!entry) warnings.push('No hay script "start" ni un entry claro (server.js/index.js…). Revisa el comando de inicio.');
    }
    if (deps.next && /next start/.test(scripts.start || '') && !has('.next')) {
      warnings.push('Next.js: "next start" necesita un build previo (npm run build).');
    }
    return {
      runtime: 'node', type: 'nodejs', manager,
      installCmd: installCmdFor(manager), buildCmd,
      startCmd, servesStatic: false, buildDir: null, port: null, mode: 'web', warnings,
    };
  }

  // ── Python ────────────────────────────────────────────────
  const pyEntry = PY_ENTRIES.find(has) || files.find((f) => f.endsWith('.py'));
  if (reqText != null || pyEntry) {
    const reqs = (reqText || '').toLowerCase();
    const mode = PY_WEB_FRAMEWORKS.some((fw) => reqs.includes(fw)) ? 'web' : 'worker';
    const installCmd = reqText != null
      ? 'python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt'
      : 'python3 -m venv .venv';
    if (reqText == null) warnings.push('Sin requirements.txt: se crea el venv pero no se instala nada.');
    return {
      runtime: 'python', type: 'python', manager: 'pip',
      installCmd, buildCmd: '', startCmd: `python ${pyEntry || 'app.py'}`,
      servesStatic: false, buildDir: null, port: null, mode, warnings,
    };
  }

  // ── Desconocido ───────────────────────────────────────────
  warnings.push('No se detectó package.json ni requirements.txt. Sube un proyecto Node o Python.');
  return {
    runtime: 'unknown', type: 'unknown', manager: null,
    installCmd: '', buildCmd: '', startCmd: '',
    servesStatic: false, buildDir: null, port: null, mode: 'unknown', warnings,
  };
}

module.exports = { detect, pickManager, installCmdFor, PY_WEB_FRAMEWORKS, STATIC_BUILDERS, NODE_SERVER_DEPS };
