// ============================================================
//  TecXPaneL — routes/docker.js (v2 — router delgado)
//
//  Cada handler valida, llama a lib/docker/*, escribe audit() y
//  responde ok()/fail(). Los helpers puros/vivos live en:
//    lib/docker/socket      → dockerRequest, dockerExec, dockerConfName, DOCKER_SOCKET, decodeDockerLogs
//    lib/docker/config      → DEPLOY_TEMPLATES, buildContainerConfig, flattenSingleSubdir
//    lib/docker/networking  → applyDockerNetworking (UFW + Nginx proxy + SSL)
// ============================================================

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const { ok, fail, clientIp, runSafe, wrap } = require('../lib/helpers');
const { isValidDomain, RE_APP_NAME } = require('../lib/validators');
const nginx = require('../lib/nginx');
const dockerDeploy = require('../lib/dockerDeploy');
const { audit, queries } = require('../database');
const { encryptText, decryptText } = require('../lib/crypto');

const { dockerRequest, dockerConfName, decodeDockerLogs } = require('../lib/docker/socket');
const { DEPLOY_TEMPLATES, buildContainerConfig, flattenSingleSubdir } = require('../lib/docker/config');
const { applyDockerNetworking } = require('../lib/docker/networking');
const dockerService = require('../lib/docker/service');
const dockerJobs = require('../lib/docker/jobs');

const router = express.Router();
const DOCKER_BUILDS_DIR = path.join(process.env.TXPL_DIR || '/opt/txpl', 'data', 'docker-builds');// ── Endpoints ──────────────────────────────────────────────────
const MAX_UPLOAD_BYTES = Number(process.env.TXPL_DOCKER_UPLOAD_MAX_BYTES) || 200 * 1024 * 1024;
const MAX_DOCKERFILE_BYTES = 1024 * 1024;
const COMMAND_ENV = dockerDeploy.buildCommandEnv();
const DEFAULT_DOCKERIGNORE = '.git\n.git/**\n.env\n.env.*\nnode_modules\n.venv\nvenv\n*.key\n*.pem\n';

function ensureDockerignore(dir) {
  const file = path.join(dir, '.dockerignore');
  if (!fs.existsSync(file)) fs.writeFileSync(file, DEFAULT_DOCKERIGNORE, 'utf8');
}

// ¿Se ha pedido cancelar este job? Se consulta entre fases del despliegue para
// abortar en los huecos donde no hay un proceso hijo vivo que matar (unzip, git).
function jobCancelled(jobId) {
  return !!queries.getDockerJob.get(jobId)?.cancel_requested;
}

router.get('/jobs', wrap(async (req, res) => {
  ok(res, queries.listDockerJobs.all());
}));

router.get('/jobs/:id', wrap(async (req, res) => {
  const job = queries.getDockerJob.get(req.params.id);
  if (!job) return fail(res, 404, 'Job Docker no encontrado.');
  ok(res, job);
}));

router.post('/jobs/:id/cancel', wrap(async (req, res) => {
  if (!dockerJobs.cancelJob(req.params.id)) return fail(res, 409, 'El job no está activo o no existe.');
  audit(req.user.username, clientIp(req), 'docker.job_cancel', req.params.id);
  ok(res, { success: true });
}));

// GET /api/docker/containers - List all containers (enrich with git deploy info)
router.get('/containers', wrap(async (req, res) => {
  try {
    const result = await dockerRequest('GET', '/containers/json?all=1');
    if (result.statusCode >= 400) {
      return fail(res, result.statusCode, `Error de Docker API: ${result.body.toString()}`);
    }
    const containers = JSON.parse(result.body.toString());

    // Cruzar con la tabla docker_deploys para adjuntar metadatos de Git
    try {
      const deploys = queries.listDockerDeploys.all();
      const deployMap = new Map();
      for (const d of deploys) {
        deployMap.set(d.container_name, d);
      }
      for (const c of containers) {
        const names = c.Names ? c.Names.map(n => n.replace(/^\//, '')) : [];
        let info = null;
        for (const n of names) {
          if (deployMap.has(n)) {
            info = deployMap.get(n);
            break;
          }
        }
        if (info) {
          c.isGitDeploy = true;
          c.gitRepo = dockerDeploy.sanitizeRepoUrl(info.raw_repo_url);
          c.gitBranch = info.git_branch;
          c.containerName = info.container_name;
        }
      }
    } catch (dbErr) {
      console.warn('[docker] Error al cruzar contenedores con docker_deploys:', dbErr.message);
    }

    ok(res, containers);
  } catch (err) {
    console.error('[docker] Error al listar contenedores:', err.message);
    fail(res, 500, err.message || 'No se pudo conectar a Docker');
  }
}));

router.get('/containers/:id/details', wrap(async (req, res) => {
  const result = await dockerRequest('GET', '/containers/' + encodeURIComponent(req.params.id) + '/json');
  if (result.statusCode >= 400) return fail(res, result.statusCode, 'No se pudo inspeccionar el contenedor.');
  ok(res, dockerService.sanitizeContainerDetails(JSON.parse(result.body.toString())));
}));

router.get('/containers/:id/stats', wrap(async (req, res) => {
  const result = await dockerRequest('GET', '/containers/' + encodeURIComponent(req.params.id) + '/stats?stream=0', null, { timeout: 10_000 });
  if (result.statusCode >= 400) return fail(res, result.statusCode, 'No se pudieron obtener las estadísticas del contenedor.');
  ok(res, dockerService.normalizeStats(JSON.parse(result.body.toString())));
}));

router.get('/images', wrap(async (req, res) => {
  const result = await dockerRequest('GET', '/images/json?all=1');
  if (result.statusCode >= 400) return fail(res, result.statusCode, 'No se pudieron listar las imágenes.');
  ok(res, JSON.parse(result.body.toString()).map(image => ({ id: image.Id, tags: image.RepoTags || [], size: image.Size, created: image.Created, containers: image.Containers })));
}));

router.get('/volumes', wrap(async (req, res) => {
  const result = await dockerRequest('GET', '/volumes');
  if (result.statusCode >= 400) return fail(res, result.statusCode, 'No se pudieron listar los volúmenes.');
  const data = JSON.parse(result.body.toString());
  ok(res, (data.Volumes || []).map(volume => ({ name: volume.Name, driver: volume.Driver, mountpoint: volume.Mountpoint, scope: volume.Scope, created: volume.CreatedAt })));
}));

router.get('/networks', wrap(async (req, res) => {
  const result = await dockerRequest('GET', '/networks');
  if (result.statusCode >= 400) return fail(res, result.statusCode, 'No se pudieron listar las redes.');
  ok(res, JSON.parse(result.body.toString()).map(network => ({ id: network.Id, name: network.Name, driver: network.Driver, scope: network.Scope, containers: Object.keys(network.Containers || {}).length })));
}));

// POST /api/docker/containers/:id/:action - start, stop, restart container
router.post('/containers/:id/:action', wrap(async (req, res) => {
  const { id, action } = req.params;
  if (!['start', 'stop', 'restart'].includes(action)) {
    return fail(res, 400, 'Acción no válida. Use start, stop o restart.');
  }

  try {
    const result = await dockerRequest('POST', `/containers/${id}/${action}`);
    // 204 No Content is success for start/stop/restart, 304 means container already in that state
    if (result.statusCode === 204 || result.statusCode === 304) {
      audit(req.user.username, clientIp(req), `docker.${action}`, id.substring(0, 12));
      return ok(res, { success: true, status: result.statusCode });
    }
    fail(res, result.statusCode, `Error de Docker: ${result.body.toString() || 'Acción fallida'}`);
  } catch (err) {
    console.error(`[docker] Error al realizar acción ${action} en contenedor ${id}:`, err.message);
    fail(res, 500, err.message || `No se pudo realizar la acción ${action}`);
  }
}));

// DELETE /api/docker/containers/:id - delete/remove container (force delete)
router.delete('/containers/:id', wrap(async (req, res) => {
  const { id } = req.params;
  try {
    // Antes de borrar, leer los puertos publicados y el dominio (label) para
    // cerrar el firewall y quitar el proxy Nginx después.
    const hostPorts = [];
    let containerName = null;
    let proxyDomain = null;
    try {
      const insp = await dockerRequest('GET', `/containers/${id}/json`);
      if (insp.statusCode < 400) {
        const info = JSON.parse(insp.body.toString());
        if (info && info.Name) containerName = info.Name.replace(/^\//, '');
        const bindings = (info && info.HostConfig && info.HostConfig.PortBindings) || {};
        for (const arr of Object.values(bindings)) {
          for (const b of (arr || [])) {
            if (b && b.HostPort) hostPorts.push(b.HostPort);
          }
        }
        proxyDomain = (info && info.Config && info.Config.Labels && info.Config.Labels['txpl.domain']) || null;
      }
    } catch (_) { /* best-effort: si no se puede inspeccionar, seguimos con el borrado */ }

    const result = await dockerRequest('DELETE', `/containers/${id}?v=1&force=1`);
    if (result.statusCode === 204) {
      // Cerrar en el firewall los puertos que habíamos abierto al crear (best-effort).
      for (const p of [...new Set(hostPorts)]) {
        await runSafe('ufw', ['delete', 'allow', `${p}/tcp`]);
      }
      // Quitar el proxy Nginx del dominio si lo habíamos creado.
      if (proxyDomain) await nginx.removeSite(dockerConfName(proxyDomain));
      if (containerName) {
        try { queries.deleteDockerDeploy.run(containerName); } catch (_) {}
      }
      audit(req.user.username, clientIp(req), 'docker.delete', id.substring(0, 12));
      return ok(res, { success: true });
    }
    fail(res, result.statusCode, `Error de Docker: ${result.body.toString() || 'No se pudo eliminar el contenedor'}`);
  } catch (err) {
    console.error(`[docker] Error al eliminar el contenedor ${id}:`, err.message);
    fail(res, 500, err.message || 'No se pudo eliminar el contenedor');
  }
}));

// GET /api/docker/containers/:id/logs - Get container logs (last 200 lines)
router.get('/containers/:id/logs', wrap(async (req, res) => {
  const { id } = req.params;
  try {
    const result = await dockerRequest('GET', `/containers/${id}/logs?stdout=1&stderr=1&tail=200`);
    if (result.statusCode >= 400) {
      return fail(res, result.statusCode, `Error al obtener logs: ${result.body.toString()}`);
    }
    const logs = decodeDockerLogs(result.body);
    ok(res, { logs });
  } catch (err) {
    console.error(`[docker] Error al obtener logs del contenedor ${id}:`, err.message);
    fail(res, 500, err.message || 'No se pudieron obtener los logs');
  }
}));

// POST /api/docker/containers/create - pull or build Dockerfile, create, and start a container
router.post('/containers/create', wrap(async (req, res) => {
  const { name, image, hostPort, containerPort, envs, dockerfile, volumeName, volumePath, domain, ssl } = req.body || {};

  if (!image && !dockerfile) {
    return fail(res, 400, 'Se requiere una imagen o un contenido Dockerfile.');
  }
  if (!RE_APP_NAME.test(String(name || ''))) return fail(res, 400, 'Nombre de contenedor inválido.');
  if (typeof dockerfile === 'string' && Buffer.byteLength(dockerfile, 'utf8') > MAX_DOCKERFILE_BYTES) {
    return fail(res, 413, 'El Dockerfile supera el límite de 1 MB.');
  }
  const imageCheck = dockerDeploy.validateImageRef(image);
  if (image && !imageCheck.ok) return fail(res, 400, 'Referencia de imagen inválida.');
  const hostPortCheck = dockerDeploy.validatePort(hostPort);
  const containerPortCheck = dockerDeploy.validatePort(containerPort);
  if (!hostPortCheck.ok || !containerPortCheck.ok) return fail(res, 400, 'Puerto inválido (debe ser un número entre 1 y 65535).');
  const envCheck = dockerDeploy.normalizeEnvLines(envs);
  if (!envCheck.ok) return fail(res, 400, envCheck.error);

  // Validar el volumen persistente (opcional) antes de descargar o compilar nada.
  let volumeBind = null;
  if (volumeName || volumePath) {
    const vName = String(volumeName || '').trim();
    const vPath = String(volumePath || '').trim();
    if (!vName || !vPath) {
      return fail(res, 400, 'Para el volumen persistente indica el nombre y la ruta, o deja ambos vacíos.');
    }
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(vName)) {
      return fail(res, 400, 'Nombre de volumen inválido (letras, números, _ . - y máx 63 caracteres).');
    }
    if (!vPath.startsWith('/') || vPath.includes('..')) {
      return fail(res, 400, 'La ruta del contenedor debe ser absoluta (empezar por /) y sin "..".');
    }
    volumeBind = `${vName}:${vPath}`;
  }

  // Validar el dominio (opcional). Necesita un puerto host al que apuntar el proxy.
  let proxyDomain = null;
  const wantSsl = ssl === true || ssl === 'true';
  if (domain) {
    const d = String(domain).trim();
    if (!isValidDomain(d)) return fail(res, 400, 'Dominio inválido.');
    if (!hostPort) return fail(res, 400, 'Para usar un dominio necesitas indicar un Puerto Host (al que apuntará el proxy).');
    proxyDomain = d;
  }

  let targetImage = image;
  let buildDir = null;

  try {
    // 1. If dockerfile is provided, build it first
    if (dockerfile && dockerfile.trim()) {
      targetImage = `txpl-img-${Date.now()}`;
      buildDir = path.join(process.env.TXPL_DIR || '/opt/txpl', 'data', 'builds', `build-${Date.now()}`);

      console.log(`[docker] Creando directorio temporal de build: ${buildDir}`);
      fs.mkdirSync(buildDir, { recursive: true });
      fs.writeFileSync(path.join(buildDir, 'Dockerfile'), dockerfile);

      // Si se proporcionó un nombre para el contenedor, guardar también el Dockerfile en su carpeta persistente de build
      if (name && name.trim()) {
        try {
          const contBuildDir = path.join(DOCKER_BUILDS_DIR, name.trim());
          fs.mkdirSync(contBuildDir, { recursive: true });
          fs.writeFileSync(path.join(contBuildDir, 'Dockerfile'), dockerfile);
        } catch (_) {}
      }

      console.log(`[docker] Compilando Dockerfile para la imagen: ${targetImage}...`);
      const buildRes = await dockerService.buildImage(targetImage, buildDir);

      if (!buildRes.ok) {
        // Return full compilation output so the user can debug the Dockerfile
        const errMsg = buildRes.stderr || buildRes.stdout || 'Fallo desconocido al compilar Dockerfile';
        console.error(`[docker] Falló docker build:\n`, errMsg);
        return fail(res, 400, `Error de compilación del Dockerfile:\n${errMsg}`);
      }
      console.log(`[docker] Imagen compilada con éxito: ${targetImage}`);
    } else {
      // Pull image if using existing registry image
      console.log(`[docker] Descargando imagen: ${targetImage}...`);
      const pullResult = await dockerService.pullImage(targetImage);
      if (pullResult.statusCode >= 400) {
        return fail(res, pullResult.statusCode, `Error al descargar la imagen: ${pullResult.body.toString()}`);
      }
    }

    // 2. Build configuration (helper reutilizado por el asistente de despliegue).
    const config = buildContainerConfig({ image: targetImage, envs: envCheck.value, hostPort: hostPortCheck.port, containerPort: containerPortCheck.port, volumeBind, proxyDomain });

    // 3. Create container
    console.log(`[docker] Creando contenedor con config:`, JSON.stringify(config));
    const deployed = await dockerService.createAndStartContainer(name.trim(), config);
    if (deployed.create.statusCode >= 400) {
      return fail(res, deployed.create.statusCode, `Error al crear contenedor: ${deployed.create.body.toString()}`);
    }
    if (deployed.start.statusCode >= 400) {
      return fail(res, deployed.start.statusCode, `Contenedor creado pero falló al iniciar: ${deployed.start.body.toString()}`);
    }
    const containerId = deployed.containerId;

    // 5. Abrir el puerto en el firewall para que sea accesible desde fuera (best-effort).
    if (hostPort) {
      await runSafe('ufw', ['allow', `${hostPort}/tcp`]);
    }

    // 6. Si hay dominio, montar el proxy Nginx y, opcionalmente, HTTPS.
    let extraMsg = '';
    if (proxyDomain) {
      try {
        await nginx.enableSite(dockerConfName(proxyDomain), nginx.buildProxy(proxyDomain, hostPort, { www: false }));
        extraMsg = `Dominio ${proxyDomain} → puerto ${hostPort} (proxy Nginx activo).`;
      } catch (e) {
        audit(req.user.username, clientIp(req), 'docker.create', `${name || targetImage} (proxy falló)`);
        return ok(res, { success: true, id: containerId, warning: `Contenedor creado y arrancado, pero falló el proxy del dominio: ${e.message}` });
      }
      if (wantSsl) {
        try { await nginx.installSsl(proxyDomain, { www: false }); extraMsg += ' HTTPS instalado.'; }
        catch (e) { extraMsg += ` HTTPS no se pudo instalar automáticamente (${e.message}).`; }
      }
    }

    audit(req.user.username, clientIp(req), 'docker.create', name || targetImage);
    ok(res, { success: true, id: containerId, message: extraMsg || undefined });
  } catch (err) {
    console.error('[docker] Error al crear contenedor:', err.message);
    fail(res, 500, err.message || 'No se pudo crear el contenedor');
  } finally {
    // Clean up temporary build files
    if (buildDir) {
      try {
        fs.rmSync(buildDir, { recursive: true, force: true });
        console.log(`[docker] Directorio temporal eliminado: ${buildDir}`);
      } catch (_) {}
    }
  }
}));

// ── Asistente "Despliega tu app" ───────────────────────────────
// Paso 1: subir el ZIP del código del usuario (stream binario, sin límite JSON).
router.post('/deploy/upload', (req, res) => {
  const name = String(req.query.name || '').trim();
  if (!RE_APP_NAME.test(name)) return fail(res, 400, 'Nombre inválido (letras, números, - y _).');

  const dir = path.join(DOCKER_BUILDS_DIR, name);
  try {
    fs.rmSync(dir, { recursive: true, force: true }); // limpia un build anterior con el mismo nombre
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    return fail(res, 500, 'No se pudo preparar el directorio de build');
  }

  const target = path.join(dir, 'upload.zip');
  const ws = fs.createWriteStream(target);
  let failed = false;
  let received = 0;
  const abort = (code, msg) => {
    if (failed) return;
    failed = true;
    try { ws.destroy(); } catch (_) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    if (!res.headersSent) fail(res, code, msg);
  };
  ws.on('error', () => abort(500, 'Error al escribir el archivo'));
  req.on('error', () => abort(400, 'Error en la transferencia'));
  ws.on('finish', () => { if (!failed && !res.headersSent) ok(res, { success: true }); });
  req.on('data', (chunk) => {
    received += chunk.length;
    if (received > MAX_UPLOAD_BYTES) {
      abort(413, 'El ZIP supera el límite de ' + Math.round(MAX_UPLOAD_BYTES / 1024 / 1024) + ' MB.');
      req.destroy();
      return;
    }
    if (!failed && !ws.write(chunk)) req.pause(); // respeta backpressure: no acumular en memoria
  });
  ws.on('drain', () => { if (!failed) req.resume(); });
  req.on('end', () => { if (!failed) ws.end(); });
});

// Paso 2: extraer, generar/usar Dockerfile, construir la imagen (logs en vivo),
// crear y arrancar el contenedor y aplicar red (firewall + dominio + HTTPS).
router.post('/deploy/build', wrap(async (req, res) => {
  const { name, template, hostPort, containerPort, domain, ssl, volumeName, volumePath, envs } = req.body || {};

  // ── Validaciones previas (responden JSON antes de empezar a transmitir) ──
  if (!RE_APP_NAME.test(name || '')) return fail(res, 400, 'Nombre inválido (letras, números, - y _).');
  const tpl = DEPLOY_TEMPLATES[template];
  if (!tpl) return fail(res, 400, 'Plantilla desconocida.');
  const deployEnvCheck = dockerDeploy.normalizeEnvLines(envs);
  if (!deployEnvCheck.ok) return fail(res, 400, deployEnvCheck.error);
  const deployHostPort = dockerDeploy.validatePort(hostPort);
  if (!deployHostPort.ok) return fail(res, 400, 'Puerto Host inválido (debe ser un número entre 1 y 65535).');

  const dir = path.join(DOCKER_BUILDS_DIR, name);
  if (!fs.existsSync(path.join(dir, 'upload.zip'))) return fail(res, 400, 'Primero sube el código de tu app (ZIP).');
  const jobId = dockerJobs.createJob({ kind: 'zip', containerName: name, userName: req.user.username });

  // Volumen persistente (opcional)
  const volChk = dockerDeploy.parseVolumeBind(volumeName, volumePath);
  if (!volChk.ok) return fail(res, 400, volChk.error);
  const volumeBind = volChk.bind;

  // Puerto interno efectivo según la plantilla
  let effContainerPort;
  if (tpl.fixedPort) {
    effContainerPort = tpl.containerPort;
  } else if (containerPort) {
    const deployContainerPort = dockerDeploy.validatePort(containerPort);
    if (!deployContainerPort.ok) return fail(res, 400, 'Puerto Contenedor inválido (debe ser un número entre 1 y 65535).');
    effContainerPort = deployContainerPort.port;
  } else {
    effContainerPort = tpl.containerPort;
  }

  // Dominio (opcional) → necesita puerto host y puerto interno conocido
  let proxyDomain = null;
  const wantSsl = ssl === true || ssl === 'true';
  if (domain) {
    const d = String(domain).trim();
    if (!isValidDomain(d)) return fail(res, 400, 'Dominio inválido.');
    if (!deployHostPort.port) return fail(res, 400, 'Para usar un dominio necesitas indicar un Puerto Host.');
    proxyDomain = d;
  }
  if (hostPort && !effContainerPort) {
    return fail(res, 400, 'Indica el puerto interno de tu app (Puerto Contenedor).');
  }

  // ── A partir de aquí transmitimos en vivo (igual que los plugins) ──
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('X-TXPL-Job-Id', jobId);
  res.flushHeaders?.();
  const log = (s) => { res.write(s); dockerJobs.appendLog(jobId, s); };
  const finish = (code) => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    dockerJobs.finishJob(jobId, code === 0 ? 'success' : 'failed'); // finishJob marca 'cancelled' si se pidió cancelar
    res.end('\n__TXPL_DONE__' + code);
  };

  try {
    // 1. Extraer el ZIP
    log('▶ Extrayendo el código...\n');
    const probe = await runSafe('unzip', ['-v'], { env: COMMAND_ENV });
    if (!probe.ok) {
      log('✖ unzip no está instalado en el servidor. Instálalo antes de desplegar.\n');
      return finish(1);
    }
    const listing = await runSafe('unzip', ['-Z1', path.join(dir, 'upload.zip')], { env: COMMAND_ENV, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    const zipCheck = dockerDeploy.validateZipEntries((listing.stdout || '').split(/\r?\n/).filter(Boolean));
    if (!listing.ok || !zipCheck.ok) {
      log('✖ ZIP rechazado: ' + (zipCheck.error || 'no se pudo inspeccionar su contenido') + '\n');
      return finish(1);
    }
    const ex = await runSafe('unzip', ['-o', '-q', path.join(dir, 'upload.zip'), '-d', dir], { env: COMMAND_ENV, timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
    if (!ex.ok) { log('✖ Error al extraer el ZIP: ' + (ex.stderr.split('\n').filter(Boolean).slice(-2).join(' ') || 'desconocido') + '\n'); return finish(1); }
    try { fs.unlinkSync(path.join(dir, 'upload.zip')); } catch (_) {}
    flattenSingleSubdir(dir);
    ensureDockerignore(dir);
    if (jobCancelled(jobId)) { log('\n✖ Despliegue cancelado por el usuario.\n'); return finish(1); }

    // 2. Determinar el Dockerfile
    const hasDockerfile = fs.existsSync(path.join(dir, 'Dockerfile'));
    if (template === 'dockerfile') {
      if (!hasDockerfile) { log('✖ No se encontró ningún Dockerfile en tu código.\n'); return finish(1); }
      log('Usando el Dockerfile incluido en tu código.\n');
    } else if (hasDockerfile) {
      log('Se encontró un Dockerfile en tu código: se usará ese en lugar de la plantilla.\n');
    } else {
      fs.writeFileSync(path.join(dir, 'Dockerfile'), tpl.gen(effContainerPort));
      log(`Dockerfile generado con la plantilla "${tpl.label}".\n`);
    }

    // 3. Construir la imagen (salida en vivo)
    const imageTag = `txpl-app-${name}`;
    dockerJobs.updateJob(jobId, { imageTag });
    log(`\n▶ Construyendo la imagen ${imageTag} (esto puede tardar unos minutos)...\n\n`);
    const buildCode = await new Promise((resolve) => {
      let child;
      try {
      child = spawn('docker', ['build', '-t', imageTag, '.'], { cwd: dir, env: COMMAND_ENV });
      } catch (e) { res.write('[error] No se pudo iniciar docker build: ' + e.message + '\n'); return resolve(1); }
      dockerJobs.registerProcess(jobId, child);
      child.stdout.on('data', (d) => log(d));
      child.stderr.on('data', (d) => log(d));
      child.on('error', (e) => { dockerJobs.unregisterProcess(jobId, child); log('\n[error] ' + e.message + '\n'); resolve(1); });
      child.on('close', (c) => { dockerJobs.unregisterProcess(jobId, child); resolve(c === null ? 1 : c); });
    });
    if (buildCode !== 0) { log(`\n✖ Falló la construcción de la imagen (código ${buildCode}).\n`); return finish(1); }
    log('\n✓ Imagen construida correctamente.\n');

    // 4. Variables de entorno: inyectar PORT para Node/Python si no está definido
    let effEnvs = deployEnvCheck.value;
    if ((template === 'node' || template === 'python') && effContainerPort && !/^\s*PORT\s*=/m.test(effEnvs)) {
      effEnvs = (effEnvs ? effEnvs + '\n' : '') + `PORT=${effContainerPort}`;
    }

    // 5. Crear y arrancar el contenedor
    if (jobCancelled(jobId)) { log('\n✖ Despliegue cancelado por el usuario.\n'); return finish(1); }
    log('\n▶ Creando y arrancando el contenedor...\n');
    const config = buildContainerConfig({ image: imageTag, envs: effEnvs, hostPort, containerPort: effContainerPort, volumeBind, proxyDomain });
    const deployed = await dockerService.createAndStartContainer(name, config);
    if (deployed.create.statusCode >= 400) { log('✖ Error al crear el contenedor: ' + deployed.create.body.toString() + '\n'); return finish(1); }
    if (deployed.start.statusCode >= 400) { log('✖ Contenedor creado pero falló al arrancar: ' + deployed.start.body.toString() + '\n'); return finish(1); }
    const containerId = deployed.containerId;
    dockerJobs.updateJob(jobId, { containerId });
    log('✓ Contenedor arrancado.\n');

    // 6. Red: firewall + dominio + HTTPS (best-effort)
    await applyDockerNetworking(log, { proxyDomain, hostPort, wantSsl });

    audit(req.user.username, clientIp(req), 'docker.deploy', `${name} (${tpl.label})`);
    log('\n✅ Despliegue completado con éxito.\n');
    finish(0);
  } catch (e) {
    log('\n[error] ' + (e.message || e) + '\n');
    finish(1);
  }
}));

// Paso 3 (Asistente Git): clonar repositorio desde GitHub/Git, compilar Dockerfile/plantilla
// (logs en vivo con diagnóstico detallado), crear y arrancar contenedor y aplicar red.
// Handler del despliegue Git, extraído para que /redeploy lo invoque directamente
// (evita el hack de rebuscar en router.stack).
const deployGitHandler = wrap(async (req, res) => {
  const {
    name, gitRepo, gitToken, gitBranch, dockerfilePath, subDir, template = 'dockerfile',
    hostPort: hostPortRaw, containerPort, domain, ssl, volumeName, volumePath, envs
  } = req.body || {};

  // ── Validaciones previas ──
  if (!RE_APP_NAME.test(name || '')) return fail(res, 400, 'Nombre inválido (letras, números, - y _).');

  // Puerto host (1-65535) si se indica; null si se deja vacío.
  const hpChk = dockerDeploy.validatePort(hostPortRaw);
  if (!hpChk.ok) return fail(res, 400, 'Puerto Host inválido (debe ser un número entre 1 y 65535).');
  const hostPort = hpChk.port;
  const envCheck = dockerDeploy.normalizeEnvLines(envs);
  if (!envCheck.ok) return fail(res, 400, envCheck.error);
  if (!gitRepo || typeof gitRepo !== 'string' || !gitRepo.trim()) {
    return fail(res, 400, 'Se requiere la URL del repositorio Git / GitHub.');
  }

  const rawRepoUrl = gitRepo.trim();
  if (!/^https?:\/\/|^git@/i.test(rawRepoUrl)) {
    return fail(res, 400, 'La URL del repositorio debe comenzar por http://, https:// o git@');
  }

  const branch = (gitBranch && typeof gitBranch === 'string' && gitBranch.trim()) ? gitBranch.trim() : 'main';
  const token = (gitToken && typeof gitToken === 'string') ? gitToken.trim() : '';
  const tpl = DEPLOY_TEMPLATES[template] || DEPLOY_TEMPLATES.dockerfile;

  // Volumen persistente (opcional)
  const volChk = dockerDeploy.parseVolumeBind(volumeName, volumePath);
  if (!volChk.ok) return fail(res, 400, volChk.error);
  const volumeBind = volChk.bind;

  // Puerto interno efectivo según la plantilla
  let effContainerPort;
  if (tpl.fixedPort) {
    effContainerPort = tpl.containerPort;
  } else if (containerPort) {
    effContainerPort = parseInt(containerPort, 10);
    if (!Number.isInteger(effContainerPort) || effContainerPort < 1 || effContainerPort > 65535) {
      return fail(res, 400, 'Puerto Contenedor inválido (debe ser un número entre 1 y 65535).');
    }
  } else {
    effContainerPort = tpl.containerPort;
  }

  // Dominio (opcional)
  let proxyDomain = null;
  const wantSsl = ssl === true || ssl === 'true';
  if (domain) {
    const d = String(domain).trim();
    if (!isValidDomain(d)) return fail(res, 400, 'Dominio inválido.');
    if (!hostPort) return fail(res, 400, 'Para usar un dominio necesitas indicar un Puerto Host.');
    proxyDomain = d;
  }
  if (hostPort && !effContainerPort) {
    return fail(res, 400, 'Indica el puerto interno de tu app (Puerto Contenedor).');
  }

  const dir = path.join(DOCKER_BUILDS_DIR, name);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    return fail(res, 500, 'No se pudo preparar el directorio de build');
  }

  const jobId = dockerJobs.createJob({ kind: 'git', containerName: name, userName: req.user.username });

  // ── Transmisión en vivo ──
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('X-TXPL-Job-Id', jobId);
  res.flushHeaders?.();
  const log = (s) => { res.write(s); dockerJobs.appendLog(jobId, s); };
  const finish = (code, cleanup = true) => {
    if (cleanup) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
    dockerJobs.finishJob(jobId, code === 0 ? 'success' : 'failed'); // finishJob marca 'cancelled' si se pidió cancelar
    res.end('\n__TXPL_DONE__' + code);
  };

  // Ejecuta un proceso con salida en vivo y timeout máximo: evita que un build o
  // un "compose up" colgado deje la petición abierta para siempre. Devuelve
  // { code, enoent }: code 124 si se abortó por timeout; enoent true si el binario no existe.
  const MAX_BUILD_MS = 30 * 60 * 1000; // 30 min
  const spawnLive = (cmd, args, cwd) => new Promise((resolve) => {
    let child, enoent = false, timedOut = false;
    try {
      child = spawn(cmd, args, { cwd, env: COMMAND_ENV });
      dockerJobs.registerProcess(jobId, child);
    } catch (e) {
      if (e.code === 'ENOENT') enoent = true; else log('[error] ' + e.message + '\n');
      return resolve({ code: 1, enoent });
    }
    const to = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch (_) {} }, MAX_BUILD_MS);
    child.stdout.on('data', (d) => log(d));
    child.stderr.on('data', (d) => log(d));
    child.on('error', (e) => {
      clearTimeout(to);
      dockerJobs.unregisterProcess(jobId, child);
      if (e.code === 'ENOENT') enoent = true; else log('\n[error] ' + e.message + '\n');
      resolve({ code: 1, enoent });
    });
    child.on('close', (c) => {
      dockerJobs.unregisterProcess(jobId, child);
      clearTimeout(to);
      if (timedOut) { res.write('\n[error] Timeout: el proceso superó los 30 minutos y fue abortado.\n'); return resolve({ code: 124, enoent }); }
      resolve({ code: c === null ? 1 : c, enoent });
    });
  });

  const gitOpts = { cwd: dir, timeout: 300_000, maxBuffer: 16 * 1024 * 1024, env: dockerDeploy.buildCommandEnv({ GIT_TERMINAL_PROMPT: '0' }) };

  // Autenticación sin exponer el token (cabecera vía GIT_CONFIG_*, no en argv ni
  // en .git/config) y URL saneada para mostrar en logs. Ver lib/dockerDeploy.
  const sanitizedUrl = dockerDeploy.sanitizeRepoUrl(rawRepoUrl);
  const authEnv = dockerDeploy.buildGitAuthEnv(token, rawRepoUrl);

  // Jaula: una ruta derivada del repo (subdirectorio, Dockerfile) nunca debe salir de `dir`.
  const insideBuild = (p) => dockerDeploy.isInsideBase(dir, p);

  try {
    log('=================================================================\n');
    log(`▶ INICIANDO DESPLIEGUE DESDE GIT: ${name}\n`);
    log(`▶ Repositorio: ${sanitizedUrl}\n`);
    log(`▶ Rama objetivo: ${branch}\n`);
    if (token) {
      const masked = token.length > 8 ? `${token.substring(0, 4)}...${token.substring(token.length - 4)}` : '****';
      log(`▶ Autenticación: Token detectado (${masked}, ${token.length} caracteres)\n`);
    } else {
      log(`▶ Autenticación: Sin token (modo público)\n`);
    }
    log('=================================================================\n\n');

    // Helper para intentar clonar
    async function attemptClone(targetBranch, isAuthed) {
      const repoUrlToUse = (isAuthed && token) ? dockerDeploy.buildAuthedRepoUrl(token, rawRepoUrl) : rawRepoUrl;
      const args = ['clone', '--depth=1'];
      if (targetBranch) args.push('-b', targetBranch);
      args.push(repoUrlToUse, '.');

      const modeStr = (isAuthed ? 'autenticado' : 'público') + (targetBranch ? ` [rama: ${targetBranch}]` : ' [rama por defecto]');
      log(`[Git] Intentando clonar (${modeStr})...\n`);

      const opts = isAuthed ? { ...gitOpts, env: { ...gitOpts.env, ...authEnv } } : gitOpts;
      const r = await runSafe('git', args, opts);
      if (r.ok) {
        try { await runSafe('git', ['remote', 'set-url', 'origin', sanitizedUrl], { cwd: dir }); } catch (_) {}
        return { ok: true, output: r.stdout };
      }

      const cleanErr = (r.stderr || r.stdout || 'Sin detalles de error')
        .replace(/(https?:\/\/)[^@]+@/g, '$1')
        .trim();
      log(`[Git] Aviso/Detalle de clonado (${modeStr}):\n${cleanErr}\n\n`);
      return { ok: false, error: cleanErr };
    }

    let cloneSuccess = false;
    const cleanDir = () => { try { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); } catch (_) {} };

    if (token) {
      let r = await attemptClone(branch, true);
      if (r.ok) cloneSuccess = true;
      else {
        cleanDir();
        r = await attemptClone(null, true);
        if (r.ok) cloneSuccess = true;
        else {
          log(`⚠ Falló la autenticación con token. Reintentando sin token por si el repositorio es público...\n\n`);
          cleanDir();
          r = await attemptClone(branch, false);
          if (r.ok) cloneSuccess = true;
          else {
            cleanDir();
            r = await attemptClone(null, false);
            if (r.ok) cloneSuccess = true;
          }
        }
      }
    } else {
      let r = await attemptClone(branch, false);
      if (r.ok) cloneSuccess = true;
      else {
        cleanDir();
        r = await attemptClone(null, false);
        if (r.ok) cloneSuccess = true;
      }
    }

    if (!cloneSuccess) {
      log('✖ ERROR CRÍTICO: No se pudo clonar el repositorio Git tras todos los intentos.\n');
      log('  Verifica que:\n');
      log('  1. La URL sea correcta y el servidor tenga acceso a internet.\n');
      log('  2. Si es un repositorio privado, que el Token de acceso tenga permisos de lectura (repo scope).\n');
      log('  3. La rama especificada exista en el repositorio.\n');
      return finish(1);
    }

    log('✓ Clonado completado con éxito.\n\n');

    // Quitar .git: el build/compose no lo necesita y así no queda ninguna URL de
    // remoto ni historia en el directorio (que en modo compose se conserva).
    try { fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true }); } catch (_) {}
    ensureDockerignore(dir);

    // Normalizar finales de línea (CRLF -> LF) en scripts ejecutables (gradlew, mvnw, *.sh)
    try {
      const fixLfInDir = (targetDir) => {
        if (!fs.existsSync(targetDir)) return;
        const entries = fs.readdirSync(targetDir, { withFileTypes: true });
        for (const e of entries) {
          const fullPath = path.join(targetDir, e.name);
          if (e.isFile() && (e.name === 'gradlew' || e.name === 'mvnw' || e.name.endsWith('.sh'))) {
            const content = fs.readFileSync(fullPath, 'utf8');
            if (content.includes('\r')) {
              fs.writeFileSync(fullPath, content.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
              log(`✓ Finales de línea corregidos (CRLF -> LF) en ${path.relative(dir, fullPath)}\n`);
            }
          }
        }
      };
      fixLfInDir(dir);
      fixLfInDir(path.join(dir, 'backend'));
    } catch (_) {}

    // 2. Determinar si se usa Docker Compose o Dockerfile individual
    const hasComposeFile = fs.existsSync(path.join(dir, 'docker-compose.yml')) || fs.existsSync(path.join(dir, 'docker-compose.yaml'));
    const isComposeMode = template === 'compose' || (template === 'auto' && hasComposeFile);

    let keepDir = false;

    if (isComposeMode) {
      if (!hasComposeFile && template === 'compose') {
        log('✖ Se solicitó el modo Docker Compose pero no se encontró docker-compose.yml en la raíz del proyecto.\n');
        return finish(1);
      }

      log('✓ Detectado archivo docker-compose.yml. Desplegando pila multicontenedor con Docker Compose...\n');
      keepDir = true;

      // Escribir archivo .env con las variables de entorno si se especificaron
      let effEnvs = typeof envs === 'string' ? envs : '';
      if (proxyDomain && !/^\s*DOMAIN\s*=/m.test(effEnvs)) {
        effEnvs = (effEnvs ? effEnvs + '\n' : '') + `DOMAIN=${proxyDomain}`;
      }
      if (effEnvs.trim()) {
        fs.writeFileSync(path.join(dir, '.env'), effEnvs);
        log('✓ Archivo .env generado correctamente en la raíz del proyecto.\n');
      }

      // Heartbeat de 10s para mantener la conexión viva durante la descarga/compilación de servicios
      const keepAliveTimer = setInterval(() => {
        try { res.write(' '); } catch (_) {}
      }, 10_000);

      log('\n▶ Ejecutando: docker compose up -d --build --remove-orphans...\n\n');
      let { code: composeCode, enoent: composeEnoent } = await spawnLive('docker', ['compose', 'up', '-d', '--build', '--remove-orphans'], dir);

      if (composeEnoent) {
        log('\n⚠ Comando "docker compose" no encontrado. Reintentando con el comando legacy docker-compose...\n');
        ({ code: composeCode } = await spawnLive('docker-compose', ['up', '-d', '--build', '--remove-orphans'], dir));
      }

      clearInterval(keepAliveTimer);

      if (composeCode !== 0) {
        log(`\n✖ Falló la compilación/arranque de Docker Compose (código de salida ${composeCode}).\n`);
        log('💡 Consejo: Si tu docker-compose.yml requiere variables de entorno (como DOMAIN), agrégalas en el área "Variables de entorno (opcional)" del formulario de despliegue.\n');
        return finish(1, false);
      }

      log('\n✓ Servicios de Docker Compose construidos y arrancados correctamente.\n');

      // Red opcional para el puerto host y proxy del dominio
      await applyDockerNetworking(log, { proxyDomain, hostPort, wantSsl });

      audit(req.user.username, clientIp(req), 'docker.deploy_git_compose', `${name} (${sanitizedUrl})`);
      log('\n✅ DESPLIEGUE MULTICONTENEDOR DESDE GIT COMPLETADO CON ÉXITO.\n');
      return finish(0, false);
    }

    // 3. Determinar contexto de build y Dockerfile (Modo contenedor individual)
    let buildCwd = dir;
    if (subDir && typeof subDir === 'string' && subDir.trim()) {
      const cleanSub = subDir.trim().replace(/^\/+|\/+$/g, '');
      const candidateSub = path.join(dir, cleanSub);
      if (!insideBuild(candidateSub)) {
        log('✖ Subdirectorio inválido: la ruta sale del repositorio.\n');
        return finish(1);
      }
      if (fs.existsSync(candidateSub) && fs.statSync(candidateSub).isDirectory()) {
        buildCwd = candidateSub;
        log(`✓ Subdirectorio de trabajo configurado: ${cleanSub}\n`);
      } else {
        log(`⚠ Subdirectorio "${cleanSub}" no encontrado en el repo. Se usará la raíz del proyecto.\n`);
      }
    }

    // Ruta del Dockerfile
    let buildDockerfilePath = null;
    if (dockerfilePath && typeof dockerfilePath === 'string' && dockerfilePath.trim()) {
      const relPath = dockerfilePath.trim().replace(/^\/+/g, '');
      const c1 = path.join(buildCwd, relPath);
      const c2 = path.join(dir, relPath);
      if ((fs.existsSync(c1) && !insideBuild(c1)) || (fs.existsSync(c2) && !insideBuild(c2))) {
        log('✖ Ruta de Dockerfile inválida: sale del repositorio.\n');
        return finish(1);
      }
      if (fs.existsSync(c1)) {
        buildDockerfilePath = c1;
      } else if (fs.existsSync(c2)) {
        buildDockerfilePath = c2;
      }
    }

    // Auto-detectar si no se especificó o no se encontró
    if (!buildDockerfilePath) {
      if (fs.existsSync(path.join(buildCwd, 'Dockerfile'))) {
        buildDockerfilePath = path.join(buildCwd, 'Dockerfile');
      } else if (fs.existsSync(path.join(dir, 'Dockerfile'))) {
        buildDockerfilePath = path.join(dir, 'Dockerfile');
      } else if (fs.existsSync(path.join(dir, 'backend', 'Dockerfile'))) {
        buildDockerfilePath = path.join(dir, 'backend', 'Dockerfile');
      }
    }

    if (template === 'dockerfile' || (!template && buildDockerfilePath)) {
      if (!buildDockerfilePath) {
        log('✖ No se encontró ningún Dockerfile en el repositorio ni en la ruta especificada.\n');
        return finish(1);
      }
      log(`✓ Usando Dockerfile: ${path.relative(dir, buildDockerfilePath)}\n`);
    } else if (buildDockerfilePath) {
      log(`✓ Se encontró un Dockerfile en ${path.relative(dir, buildDockerfilePath)}: se usará este archivo.\n`);
    } else {
      buildDockerfilePath = path.join(buildCwd, 'Dockerfile');
      fs.writeFileSync(buildDockerfilePath, tpl.gen(effContainerPort));
      log(`✓ Dockerfile generado automáticamente con la plantilla "${tpl.label}".\n`);
    }

    // 4. Construir la imagen (salida en vivo con heartbeat anti-timeout)
    const imageTag = `txpl-app-${name}`;
    log(`\n▶ Construyendo la imagen Docker: ${imageTag}...\n`);
    dockerJobs.updateJob(jobId, { imageTag });
    log(`  Contexto: ${path.relative(dir, buildCwd) || '.'}\n`);
    log(`  Dockerfile: ${path.relative(dir, buildDockerfilePath)}\n\n`);

    const buildArgs = ['build', '--no-cache', '-t', imageTag, '-f', buildDockerfilePath, '.'];

    // Heartbeat de 10s para evitar timeout de Nginx/proxy (proxy_read_timeout 60s) durante compilaciones largas (Gradle/Kotlin)
    const keepAliveTimer = setInterval(() => {
      try { res.write(' '); } catch (_) {}
    }, 10_000);

    const { code: buildCode } = await spawnLive('docker', buildArgs, buildCwd);
    clearInterval(keepAliveTimer);
    if (buildCode !== 0) { log(`\n✖ Falló la compilación de la imagen Docker (código de salida ${buildCode}).\n`); return finish(1); }
    log('\n✓ Imagen compilada correctamente.\n');

    // 5. Variables de entorno: inyectar PORT para Node/Python si no está definido
    let effEnvs = envCheck.value;
    if ((template === 'node' || template === 'python') && effContainerPort && !/^\s*PORT\s*=/m.test(effEnvs)) {
      effEnvs = (effEnvs ? effEnvs + '\n' : '') + `PORT=${effContainerPort}`;
    }

    // 6. Crear y arrancar el contenedor (elimina contenedor previo con el mismo nombre si existía)
    if (jobCancelled(jobId)) { log('\n✖ Despliegue cancelado por el usuario.\n'); return finish(1); }
    log('\n▶ Creando y arrancando contenedor en Docker socket...\n');
    if (name) {
      try {
        await dockerService.removeContainer(name.trim());
      } catch (_) {}
    }
    const config = buildContainerConfig({ image: imageTag, envs: effEnvs, hostPort, containerPort: effContainerPort, volumeBind, proxyDomain });
    const deployed = await dockerService.createAndStartContainer(name, config);
    if (deployed.create.statusCode >= 400) { log('✖ Error al crear el contenedor: ' + deployed.create.body.toString() + '\n'); return finish(1); }
    if (deployed.start.statusCode >= 400) { log('✖ Contenedor creado pero falló al arrancar: ' + deployed.start.body.toString() + '\n'); return finish(1); }
    const containerId = deployed.containerId;
    dockerJobs.updateJob(jobId, { containerId });
    log(`✓ Contenedor ${name} arrancado con ID ${containerId.substring(0, 12)}.\n`);

    // 7. Red: firewall + dominio + HTTPS (best-effort)
    await applyDockerNetworking(log, { proxyDomain, hostPort, wantSsl });

    // 8. Guardar metadatos del despliegue en la BD para futuras actualizaciones automáticas
    try {
      queries.saveDockerDeploy.run({
        container_name: name,
        raw_repo_url: rawRepoUrl,
        git_branch: branch,
        git_token_enc: token ? encryptText(token) : null,
        template: template || 'dockerfile',
        container_port: effContainerPort || null,
        host_port: hostPort ? parseInt(hostPort, 10) : null,
        domain: proxyDomain || null,
        ssl: wantSsl ? 1 : 0,
        volume_name: volumeName || null,
        volume_path: volumePath || null,
        envs: envs ? encryptText(envs) : null,
        sub_dir: (typeof subDir === 'string' && subDir.trim()) ? subDir.trim() : null,
        dockerfile_path: (typeof dockerfilePath === 'string' && dockerfilePath.trim()) ? dockerfilePath.trim() : null
      });
      log('✓ Configuración del despliegue guardada para actualizaciones automáticas futuras.\n');
    } catch (dbErr) {
      log('⚠ No se pudo guardar la configuración en la BD: ' + dbErr.message + '\n');
    }

    audit(req.user.username, clientIp(req), 'docker.deploy_git', `${name} (${sanitizedUrl})`);
    log('\n✅ DESPLIEGUE DESDE GIT COMPLETADO CON ÉXITO.\n');
    finish(0);
  } catch (e) {
    log('\n[error] Excepción en el servidor: ' + (e.message || e) + '\n');
    finish(1);
  }
});

router.post('/deploy/git', deployGitHandler);

// POST /api/docker/containers/:name/redeploy - Re-ejecuta el despliegue Git desde la config guardada en la BD.
router.post('/containers/:name/redeploy', wrap(async (req, res, next) => {
  const { name } = req.params;
  const deploy = queries.getDockerDeploy.get(name);
  if (!deploy) {
    return fail(res, 404, `No se encontró una configuración de despliegue Git guardada para "${name}".`);
  }

  const gitToken = deploy.git_token_enc ? decryptText(deploy.git_token_enc) : '';

  // Reconstruir el body que espera /deploy/git a partir de la fila guardada.
  // Clave `gitRepo` (el handler lo lee así, no `rawRepoUrl`). subDir/dockerfilePath
  // se restauran para reproducir despliegues no estándar tal cual el original.
  req.body = {
    name: deploy.container_name,
    gitRepo: deploy.raw_repo_url,
    gitBranch: deploy.git_branch,
    gitToken: gitToken || '',
    template: deploy.template,
    containerPort: deploy.container_port,
    hostPort: deploy.host_port,
    domain: deploy.domain,
    ssl: deploy.ssl === 1,
    volumeName: deploy.volume_name,
    volumePath: deploy.volume_path,
    envs: decryptText(deploy.envs) || deploy.envs,
    subDir: deploy.sub_dir || undefined,
    dockerfilePath: deploy.dockerfile_path || undefined,
  };

  return deployGitHandler(req, res, next);
}));

// Helper para inspeccionar los detalles reales de un contenedor existente en la API de Docker.
async function getContainerDetails(name) {
  let image = 'nginx:alpine';
  let envs = [];
  let exposedPorts = [];
  let portMappings = [];
  let cmd = null;
  let workDir = null;

  try {
    const insp = await dockerRequest('GET', `/containers/${encodeURIComponent(name)}/json`);
    if (insp.statusCode < 400) {
      const info = JSON.parse(insp.body.toString());
      if (info.Config) {
        if (info.Config.Image) image = info.Config.Image;
        if (Array.isArray(info.Config.Env)) {
          envs = info.Config.Env.filter((e) => !e.startsWith('PATH=') && !e.startsWith('HOME='));
        }
        if (info.Config.ExposedPorts) {
          exposedPorts = Object.keys(info.Config.ExposedPorts).map((p) => p.split('/')[0]);
        }
        if (info.Config.Cmd) cmd = info.Config.Cmd;
        if (info.Config.WorkingDir) workDir = info.Config.WorkingDir;
      }
      if (info.HostConfig && info.HostConfig.PortBindings) {
        for (const [cPort, binds] of Object.entries(info.HostConfig.PortBindings)) {
          const cp = cPort.split('/')[0];
          for (const b of (binds || [])) {
            if (b && b.HostPort) {
              portMappings.push(`${b.HostPort}:${cp}`);
            }
          }
        }
      }
    }
  } catch (_) {}

  return { image, envs, exposedPorts, portMappings, cmd, workDir };
}

// GET /api/docker/containers/:name/file/:type - Obtener Dockerfile o docker-compose.yml de un contenedor específico
router.get('/containers/:name/file/:type', wrap(async (req, res) => {
  const { name, type } = req.params;
  if (!['dockerfile', 'compose'].includes(type)) {
    return fail(res, 400, 'Tipo no válido. Debe ser dockerfile o compose.');
  }
  if (!RE_APP_NAME.test(name)) {
    return fail(res, 400, 'Nombre de contenedor no válido.');
  }

  const dir = path.join(DOCKER_BUILDS_DIR, name);
  let filePath;
  if (type === 'dockerfile') {
    filePath = path.join(dir, 'Dockerfile');
  } else {
    filePath = fs.existsSync(path.join(dir, 'docker-compose.yaml'))
      ? path.join(dir, 'docker-compose.yaml')
      : path.join(dir, 'docker-compose.yml');
  }

  if (fs.existsSync(filePath)) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      return ok(res, { content });
    } catch (e) {
      return fail(res, 500, `Error al leer el archivo: ${e.message}`);
    }
  }

  // Si no hay un archivo guardado en disco, consultar los detalles reales del contenedor
  const details = await getContainerDetails(name);

  if (type === 'dockerfile') {
    let df = `FROM ${details.image}\n`;
    if (details.workDir) df += `WORKDIR ${details.workDir}\n`;
    if (details.envs.length) {
      df += dockerDeploy.redactEnvLines(details.envs).map(e => `ENV ${e}`).join('\n') + '\n';
    }
    if (details.exposedPorts.length) {
      df += details.exposedPorts.map(p => `EXPOSE ${p}`).join('\n') + '\n';
    } else {
      df += `EXPOSE 80\n`;
    }
    if (details.cmd && details.cmd.length) {
      df += `CMD ${JSON.stringify(details.cmd)}\n`;
    }
    return ok(res, { content: df });
  } else {
    let composeStr = `version: "3.8"\nservices:\n  ${name}:\n    image: ${details.image}\n`;
    if (details.portMappings.length) {
      composeStr += `    ports:\n` + details.portMappings.map(pm => `      - "${pm}"`).join('\n') + '\n';
    } else {
      composeStr += `    ports:\n      - "8080:80"\n`;
    }
    if (details.envs.length) {
      composeStr += `    environment:\n` + dockerDeploy.redactEnvLines(details.envs).map(e => `      - ${e}`).join('\n') + '\n';
    }
    return ok(res, { content: composeStr });
  }
}));

// POST /api/docker/containers/:name/file/:type - Guardar y aplicar Dockerfile o docker-compose.yml para un contenedor
router.post('/containers/:name/file/:type', wrap(async (req, res) => {
  const { name, type } = req.params;
  const { content } = req.body || {};

  if (!['dockerfile', 'compose'].includes(type)) {
    return fail(res, 400, 'Tipo no válido. Debe ser dockerfile o compose.');
  }
  if (!RE_APP_NAME.test(name)) {
    return fail(res, 400, 'Nombre de contenedor no válido.');
  }
  if (typeof content !== 'string') {
    return fail(res, 400, 'El contenido del archivo es requerido.');
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_DOCKERFILE_BYTES) {
    return fail(res, 413, 'El contenido supera el límite de 1 MB.');
  }

  const dir = path.join(DOCKER_BUILDS_DIR, name);
  fs.mkdirSync(dir, { recursive: true });

  if (type === 'dockerfile') {
    const dockerfilePath = path.join(dir, 'Dockerfile');
    fs.writeFileSync(dockerfilePath, content, 'utf8');

    const imageTag = `txpl-app-${name}`;
    console.log(`[docker] Recompilando Dockerfile de ${name} (${imageTag})...`);
    const buildRes = await dockerService.buildImage(imageTag, dir);

    if (!buildRes.ok) {
      const errMsg = buildRes.stderr || buildRes.stdout || 'Error al compilar Dockerfile';
      return fail(res, 400, `Error de compilación del Dockerfile:\n${errMsg}`);
    }

    try { await dockerService.removeContainer(name); } catch (_) {}

    let deploy = null;
    try { deploy = queries.getDockerDeploy.get(name); } catch (_) {}

    const hostPort = deploy ? deploy.host_port : undefined;
    const containerPort = deploy ? deploy.container_port : undefined;
    const volChk = dockerDeploy.parseVolumeBind(deploy?.volume_name, deploy?.volume_path);
    const volumeBind = volChk.bind;
    const proxyDomain = deploy ? deploy.domain : undefined;
    const envs = deploy ? (decryptText(deploy.envs) || deploy.envs) : undefined;

    const config = buildContainerConfig({ image: imageTag, envs, hostPort, containerPort, volumeBind, proxyDomain });
    const deployed = await dockerService.createAndStartContainer(name, config);
    if (deployed.create.statusCode >= 400) {
      return fail(res, deployed.create.statusCode, `Imagen compilada pero falló al crear el contenedor: ${deployed.create.body.toString()}`);
    }
    if (deployed.start.statusCode >= 400) {
      return fail(res, deployed.start.statusCode, `Contenedor creado pero falló al arrancar: ${deployed.start.body.toString()}`);
    }

    if (hostPort) await runSafe('ufw', ['allow', `${hostPort}/tcp`]);

    audit(req.user.username, clientIp(req), 'docker.update_dockerfile', name);
    ok(res, { success: true, output: buildRes.stdout || 'Contenedor recompilado y arrancado con éxito.' });
  } else {
    // compose mode
    const composePath = path.join(dir, 'docker-compose.yml');
    fs.writeFileSync(composePath, content, 'utf8');

    console.log(`[docker] Ejecutando docker compose up para ${name}...`);
    const composeRes = await dockerService.composeUp(dir, { build: true });

    if (!composeRes.ok) {
      const errMsg = composeRes.stderr || composeRes.stdout || 'Error de Docker Compose';
      return fail(res, 400, `Error de Docker Compose:\n${errMsg}`);
    }

    audit(req.user.username, clientIp(req), 'docker.update_compose', name);
    ok(res, { success: true, output: composeRes.stdout || 'Servicios de Docker Compose actualizados con éxito.' });
  }
}));

// Define global paths
const TXPL_DIR = process.env.TXPL_DIR || '/opt/txpl';
const DATA_DIR = path.join(TXPL_DIR, 'data');
const DOCKERFILE_PATH = path.join(DATA_DIR, 'Dockerfile');
const DOCKER_COMPOSE_PATH = path.join(DATA_DIR, 'docker-compose.yml');

// GET /api/docker/dockerfile - get default global Dockerfile
router.get('/dockerfile', wrap(async (req, res) => {
  try {
    let content = 'FROM nginx:alpine\nCOPY . /usr/share/nginx/html/\nEXPOSE 80\n';
    if (fs.existsSync(DOCKERFILE_PATH)) {
      content = fs.readFileSync(DOCKERFILE_PATH, 'utf8');
    }
    ok(res, { content });
  } catch (err) {
    fail(res, 500, err.message || 'No se pudo leer el Dockerfile');
  }
}));

// POST /api/docker/dockerfile - save and build global Dockerfile
router.post('/dockerfile', wrap(async (req, res) => {
  const { content } = req.body || {};
  if (typeof content !== 'string') {
    return fail(res, 400, 'El contenido del Dockerfile es requerido.');
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_DOCKERFILE_BYTES) {
    return fail(res, 413, 'El Dockerfile supera el límite de 1 MB.');
  }

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DOCKERFILE_PATH, content, 'utf8');

    console.log('[docker] Compilando Dockerfile global...');
    const buildRes = await dockerService.buildImage('txpl-global-image', DATA_DIR);

    if (!buildRes.ok) {
      const errMsg = buildRes.stderr || buildRes.stdout || 'Error de compilación';
      return fail(res, 400, `Error de compilación:\n${errMsg}`);
    }

    audit(req.user.username, clientIp(req), 'docker.build_global', 'txpl-global-image');
    ok(res, { success: true, output: buildRes.stdout || 'Imagen compilada con éxito' });
  } catch (err) {
    fail(res, 500, err.message || 'Error al guardar/compilar Dockerfile');
  }
}));

// GET /api/docker/compose - get global docker-compose.yml
router.get('/compose', wrap(async (req, res) => {
  try {
    let content = 'version: "3.8"\nservices:\n  web:\n    image: nginx:alpine\n    ports:\n      - "8080:80"\n';
    if (fs.existsSync(DOCKER_COMPOSE_PATH)) {
      content = fs.readFileSync(DOCKER_COMPOSE_PATH, 'utf8');
    }
    ok(res, { content });
  } catch (err) {
    fail(res, 500, err.message || 'No se pudo leer docker-compose.yml');
  }
}));

// POST /api/docker/compose - save and run docker compose up -d
router.post('/compose', wrap(async (req, res) => {
  const { content } = req.body || {};
  if (typeof content !== 'string') {
    return fail(res, 400, 'El contenido de docker-compose.yml es requerido.');
  }

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DOCKER_COMPOSE_PATH, content, 'utf8');

    console.log('[docker] Ejecutando docker compose up -d...');
    const composeRes = await dockerService.composeUp(DATA_DIR);

    if (!composeRes.ok) {
      const errMsg = composeRes.stderr || composeRes.stdout || 'Error de Docker Compose';
      return fail(res, 400, `Error de Docker Compose:\n${errMsg}`);
    }

    audit(req.user.username, clientIp(req), 'docker.compose_up', null);
    ok(res, { success: true, output: composeRes.stdout || 'Servicios levantados con éxito' });
  } catch (err) {
    fail(res, 500, err.message || 'Error al guardar/ejecutar docker-compose.yml');
  }
}));

module.exports = router;
