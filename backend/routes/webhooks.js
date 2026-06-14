'use strict';

const express = require('express');
const { queries, audit } = require('../database');
const { ok, fail, runSafe, wrap } = require('../lib/helpers');
const fs = require('fs');
const path = require('path');

const router = express.Router();

// Helper function to run deployment steps in the background
async function executeDeployment(appRow) {
  const cwd = appRow.path;
  const pm2Name = appRow.pm2_name;
  const branch = appRow.git_branch || 'main';

  console.log(`[webhook] Iniciando auto-despliegue para ${appRow.name} desde la rama ${branch}`);
  audit('system', '127.0.0.1', 'app.webhook.deploy.start', `${appRow.name} (rama: ${branch})`);

  try {
    // 1. Git fetch and reset hard
    console.log(`[webhook] [${appRow.name}] git fetch & reset...`);
    const gitFetch = await runSafe('git', ['fetch', '--all'], { cwd });
    if (!gitFetch.ok) throw new Error(`git fetch falló: ${gitFetch.stderr}`);

    const gitReset = await runSafe('git', ['reset', '--hard', `origin/${branch}`], { cwd });
    if (!gitReset.ok) throw new Error(`git reset falló: ${gitReset.stderr}`);

    // Redetect project details
    const pkgPath = path.join(cwd, 'package.json');
    let installCmd = '';
    let buildCmd = '';

    if (fs.existsSync(pkgPath)) {
      let pkg = {};
      try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch (_) {}
      const scripts = pkg.scripts || {};

      let mgr = 'npm';
      if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) mgr = 'pnpm';
      else if (fs.existsSync(path.join(cwd, 'yarn.lock'))) mgr = 'yarn';

      // Always include devDependencies as requested by user
      installCmd = mgr === 'npm' ? 'npm install --include=dev --also=dev'
        : mgr === 'yarn' ? 'yarn install --production=false'
        : 'pnpm install --prod=false';

      if (scripts.build) {
        buildCmd = mgr === 'npm' ? 'npm run build' : `${mgr} run build`;
      }
    } else if (fs.existsSync(path.join(cwd, 'requirements.txt'))) {
      installCmd = 'pip3 install -r requirements.txt';
    }

    // 2. Install dependencies
    if (installCmd) {
      console.log(`[webhook] [${appRow.name}] Ejecutando: ${installCmd}`);
      const env = { ...process.env, NODE_ENV: 'development' };
      const installRes = await runSafe('bash', ['-lc', installCmd], { cwd, env, timeout: 300_000 });
      if (!installRes.ok) throw new Error(`Instalación de dependencias falló: ${installRes.stderr}`);
    }

    // 3. Build
    if (buildCmd) {
      console.log(`[webhook] [${appRow.name}] Ejecutando: ${buildCmd}`);
      const env = { ...process.env };
      if (appRow.port) env.PORT = String(appRow.port);
      const buildRes = await runSafe('bash', ['-lc', buildCmd], { cwd, env, timeout: 300_000 });
      if (!buildRes.ok) throw new Error(`Build falló: ${buildRes.stderr}`);
    }

    // 4. Reload PM2
    console.log(`[webhook] [${appRow.name}] Recargando en PM2: ${pm2Name}`);
    const reloadRes = await runSafe('pm2', ['reload', pm2Name]);
    if (!reloadRes.ok) {
      // fallback to restart
      await runSafe('pm2', ['restart', pm2Name]);
    }

    queries.setAppStatus.run('running', appRow.id);
    audit('system', '127.0.0.1', 'app.webhook.deploy.success', appRow.name);
    console.log(`[webhook] Auto-despliegue exitoso para ${appRow.name}`);
  } catch (err) {
    console.error(`[webhook] Error en auto-despliegue para ${appRow.name}:`, err.message);
    audit('system', '127.0.0.1', 'app.webhook.deploy.error', `${appRow.name}: ${err.message}`);
  }
}

// POST /deploy/:secret
router.post('/deploy/:secret', wrap(async (req, res) => {
  const { secret } = req.params;
  const appRow = queries.getAppByWebhookSecret.get(secret);
  if (!appRow) {
    return fail(res, 404, 'Webhook no válido');
  }

  // Respond with 202 Accepted immediately to avoid remote provider timeout
  ok(res, { success: true, message: 'Despliegue iniciado en segundo plano' });

  // Execute in the background
  executeDeployment(appRow);
}));

module.exports = router;
