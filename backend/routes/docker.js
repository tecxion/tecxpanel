'use strict';

const http = require('http');
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

const router = express.Router();
const DOCKER_SOCKET = '/var/run/docker.sock';
const DOCKER_BUILDS_DIR = path.join(process.env.TXPL_DIR || '/opt/txpl', 'data', 'docker-builds');

// Nombre del vhost de Nginx asociado a un contenedor con dominio. Se usa el
// dominio para poder localizarlo y borrarlo al eliminar el contenedor.
const dockerConfName = (domain) => `txpl-docker-${domain}`;

// Capa de red de un despliegue Docker (best-effort, con salida en vivo via `log`):
// abre el puerto en UFW, publica el proxy Nginx del dominio y, si se pide, instala SSL.
// Reutilizado por los despliegues por streaming (build, git single y git compose).
async function applyDockerNetworking(log, { proxyDomain, hostPort, wantSsl }) {
  if (hostPort) {
    await runSafe('ufw', ['allow', `${hostPort}/tcp`]);
    log(`✓ Puerto ${hostPort} abierto en el firewall (UFW).\n`);
  }
  if (proxyDomain && hostPort) {
    try {
      await nginx.enableSite(dockerConfName(proxyDomain), nginx.buildProxy(proxyDomain, hostPort, { www: false }));
      log(`✓ Proxy Nginx configurado: ${proxyDomain} → puerto ${hostPort}.\n`);
    } catch (e) {
      log(`⚠ El proxy del dominio falló: ${e.message}\n`);
    }
    if (wantSsl) {
      try { await nginx.installSsl(proxyDomain, { www: false }); log('✓ HTTPS (SSL) instalado.\n'); }
      catch (e) { log(`⚠ HTTPS no se pudo instalar automáticamente: ${e.message}\n`); }
    }
  }
}

// Helper to make native HTTP requests to the Docker UNIX socket
function dockerRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    // Check if socket exists (on Linux). On Windows / development, this will reject cleanly.
    if (!fs.existsSync(DOCKER_SOCKET)) {
      return reject(new Error('El socket de Docker no existe o Docker no está instalado.'));
    }

    const options = {
      socketPath: DOCKER_SOCKET,
      path: path,
      method: method,
      headers: {
        'Host': 'localhost'
      }
    };

    if (body) {
      options.headers['Content-Type'] = 'application/json';
    }

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => {
        chunks.push(chunk);
      });
      res.on('end', () => {
        const responseBody = Buffer.concat(chunks);
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: responseBody
        });
      });
    });

    req.on('error', (err) => {
      reject(err);
    });

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// Robust decoder for Docker multiplexed log format
function decodeDockerLogs(buffer) {
  let offset = 0;
  let output = '';
  let isMultiplexed = true;

  // Pre-flight check to verify multiplexed format (8-byte header: type, reserved, size)
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) {
      break;
    }
    const type = buffer.readUInt8(offset);
    // Stream types are 0 (stdin), 1 (stdout), 2 (stderr)
    if (type !== 0 && type !== 1 && type !== 2) {
      isMultiplexed = false;
      break;
    }
    const size = buffer.readUInt32BE(offset + 4);
    if (offset + 8 + size > buffer.length) {
      if (size > 1024 * 1024) { // Suspiciously large frame size
        isMultiplexed = false;
      }
      break;
    }
    offset += 8 + size;
  }

  if (!isMultiplexed || buffer.length === 0) {
    return buffer.toString('utf8');
  }

  // Decode multiplexed stream
  offset = 0;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) {
      output += buffer.slice(offset).toString('utf8');
      break;
    }
    const type = buffer.readUInt8(offset);
    const size = buffer.readUInt32BE(offset + 4);
    offset += 8;

    let end = offset + size;
    if (end > buffer.length) end = buffer.length;

    const text = buffer.slice(offset, end).toString('utf8');
    output += text;
    offset = end;
  }
  return output;
}

// Construye la config que se envía a la Docker API. Reutilizada por la creación
// manual (/containers/create) y por el asistente de despliegue (/deploy/build).
function buildContainerConfig({ image, envs, hostPort, containerPort, volumeBind, proxyDomain }) {
  const config = {
    Image: image,
    Env: [],
    // Reinicio automático: el contenedor vuelve solo tras un reinicio del VPS o una caída.
    HostConfig: { RestartPolicy: { Name: 'unless-stopped' } }
  };
  if (envs && typeof envs === 'string') {
    config.Env = envs.split('\n').map((l) => l.trim()).filter((l) => l && l.includes('='));
  }
  if (hostPort && containerPort) {
    // containerPort puede llegar como número; normalizar a "<puerto>/tcp".
    const cp = String(containerPort);
    const cPort = cp.includes('/') ? cp : `${cp}/tcp`;
    config.ExposedPorts = { [cPort]: {} };
    config.HostConfig.PortBindings = { [cPort]: [{ HostPort: String(hostPort) }] };
  }
  if (volumeBind) config.HostConfig.Binds = [volumeBind];
  if (proxyDomain) config.Labels = { 'txpl.domain': proxyDomain };
  return config;
}

// Si el ZIP se extrajo dentro de una única subcarpeta, sube su contenido a la raíz
// del directorio de build (también limpia la carpeta de metadatos de macOS).
function flattenSingleSubdir(dir) {
  try { fs.rmSync(path.join(dir, '__MACOSX'), { recursive: true, force: true }); } catch (_) {}
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.name !== '__MACOSX');
  if (entries.length === 1 && entries[0].isDirectory()) {
    const sub = path.join(dir, entries[0].name);
    for (const item of fs.readdirSync(sub)) {
      fs.renameSync(path.join(sub, item), path.join(dir, item));
    }
    fs.rmdirSync(sub);
  }
}

// Plantillas de Dockerfile para usuarios sin conocimientos de Docker.
// containerPort = puerto interno por defecto en el que escucha la app.
const DEPLOY_TEMPLATES = {
  static: {
    label: 'Sitio estático', containerPort: 80, fixedPort: true,
    gen: () => 'FROM nginx:alpine\nCOPY . /usr/share/nginx/html/\nEXPOSE 80\n',
  },
  php: {
    label: 'PHP (Apache)', containerPort: 80, fixedPort: true,
    gen: () => 'FROM php:8.3-apache\nCOPY . /var/www/html/\nEXPOSE 80\n',
  },
  node: {
    label: 'Node.js', containerPort: 3000, fixedPort: false,
    gen: (port) => `FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nRUN npm install --omit=dev || true\nEXPOSE ${port}\nCMD ["npm","start"]\n`,
  },
  python: {
    label: 'Python', containerPort: 8000, fixedPort: false,
    gen: (port) => `FROM python:3.12-slim\nWORKDIR /app\nCOPY . .\nRUN pip install --no-cache-dir -r requirements.txt || true\nEXPOSE ${port}\nCMD ["python","app.py"]\n`,
  },
  dockerfile: {
    label: 'Ya tengo Dockerfile', containerPort: null, fixedPort: false,
    gen: null,
  },
};

// ── Endpoints ──────────────────────────────────────────────────

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

      console.log(`[docker] Compilando Dockerfile para la imagen: ${targetImage}...`);
      const buildRes = await runSafe('docker', ['build', '-t', targetImage, '.'], { cwd: buildDir, timeout: 300_000 });

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
      const pullResult = await dockerRequest('POST', `/images/create?fromImage=${encodeURIComponent(targetImage)}`);
      if (pullResult.statusCode >= 400) {
        return fail(res, pullResult.statusCode, `Error al descargar la imagen: ${pullResult.body.toString()}`);
      }
    }

    // 2. Build configuration (helper reutilizado por el asistente de despliegue).
    const config = buildContainerConfig({ image: targetImage, envs, hostPort, containerPort, volumeBind, proxyDomain });

    // 3. Create container
    let createUrl = '/containers/create';
    if (name && name.trim()) {
      createUrl += `?name=${encodeURIComponent(name.trim())}`;
    }

    console.log(`[docker] Creando contenedor con config:`, JSON.stringify(config));
    const createResult = await dockerRequest('POST', createUrl, config);
    if (createResult.statusCode >= 400) {
      return fail(res, createResult.statusCode, `Error al crear contenedor: ${createResult.body.toString()}`);
    }

    const response = JSON.parse(createResult.body.toString());
    const containerId = response.Id;

    // 4. Start container
    console.log(`[docker] Iniciando contenedor: ${containerId}...`);
    const startResult = await dockerRequest('POST', `/containers/${containerId}/start`);
    if (startResult.statusCode >= 400) {
      return fail(res, startResult.statusCode, `Contenedor creado pero falló al iniciar: ${startResult.body.toString()}`);
    }

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
  const abort = (code, msg) => {
    if (failed) return;
    failed = true;
    try { ws.destroy(); } catch (_) {}
    if (!res.headersSent) fail(res, code, msg);
  };
  ws.on('error', () => abort(500, 'Error al escribir el archivo'));
  req.on('error', () => abort(400, 'Error en la transferencia'));
  ws.on('finish', () => { if (!failed && !res.headersSent) ok(res, { success: true }); });
  req.pipe(ws);
});

// Paso 2: extraer, generar/usar Dockerfile, construir la imagen (logs en vivo),
// crear y arrancar el contenedor y aplicar red (firewall + dominio + HTTPS).
router.post('/deploy/build', wrap(async (req, res) => {
  const { name, template, hostPort, containerPort, domain, ssl, volumeName, volumePath, envs } = req.body || {};

  // ── Validaciones previas (responden JSON antes de empezar a transmitir) ──
  if (!RE_APP_NAME.test(name || '')) return fail(res, 400, 'Nombre inválido (letras, números, - y _).');
  const tpl = DEPLOY_TEMPLATES[template];
  if (!tpl) return fail(res, 400, 'Plantilla desconocida.');

  const dir = path.join(DOCKER_BUILDS_DIR, name);
  if (!fs.existsSync(path.join(dir, 'upload.zip'))) return fail(res, 400, 'Primero sube el código de tu app (ZIP).');

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

  // Dominio (opcional) → necesita puerto host y puerto interno conocido
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

  // ── A partir de aquí transmitimos en vivo (igual que los plugins) ──
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const log = (s) => res.write(s);
  const finish = (code) => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    res.end('\n__TXPL_DONE__' + code);
  };

  try {
    // 1. Extraer el ZIP
    log('▶ Extrayendo el código...\n');
    let probe = await runSafe('unzip', ['-v']);
    if (!probe.ok) await runSafe('apt-get', ['install', '-y', 'unzip'], { timeout: 120_000 });
    const ex = await runSafe('unzip', ['-o', path.join(dir, 'upload.zip'), '-d', dir], { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
    if (!ex.ok) { log('✖ Error al extraer el ZIP: ' + (ex.stderr.split('\n').filter(Boolean).slice(-2).join(' ') || 'desconocido') + '\n'); return finish(1); }
    try { fs.unlinkSync(path.join(dir, 'upload.zip')); } catch (_) {}
    flattenSingleSubdir(dir);

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
    log(`\n▶ Construyendo la imagen ${imageTag} (esto puede tardar unos minutos)...\n\n`);
    const buildCode = await new Promise((resolve) => {
      let child;
      try {
        child = spawn('docker', ['build', '-t', imageTag, '.'], { cwd: dir, env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } });
      } catch (e) { res.write('[error] No se pudo iniciar docker build: ' + e.message + '\n'); return resolve(1); }
      child.stdout.on('data', (d) => res.write(d));
      child.stderr.on('data', (d) => res.write(d));
      child.on('error', (e) => { res.write('\n[error] ' + e.message + '\n'); resolve(1); });
      child.on('close', (c) => resolve(c === null ? 1 : c));
    });
    if (buildCode !== 0) { log(`\n✖ Falló la construcción de la imagen (código ${buildCode}).\n`); return finish(1); }
    log('\n✓ Imagen construida correctamente.\n');

    // 4. Variables de entorno: inyectar PORT para Node/Python si no está definido
    let effEnvs = typeof envs === 'string' ? envs : '';
    if ((template === 'node' || template === 'python') && effContainerPort && !/^\s*PORT\s*=/m.test(effEnvs)) {
      effEnvs = (effEnvs ? effEnvs + '\n' : '') + `PORT=${effContainerPort}`;
    }

    // 5. Crear y arrancar el contenedor
    log('\n▶ Creando y arrancando el contenedor...\n');
    const config = buildContainerConfig({ image: imageTag, envs: effEnvs, hostPort, containerPort: effContainerPort, volumeBind, proxyDomain });
    const createRes = await dockerRequest('POST', `/containers/create?name=${encodeURIComponent(name)}`, config);
    if (createRes.statusCode >= 400) { log('✖ Error al crear el contenedor: ' + createRes.body.toString() + '\n'); return finish(1); }
    const containerId = JSON.parse(createRes.body.toString()).Id;
    const startRes = await dockerRequest('POST', `/containers/${containerId}/start`);
    if (startRes.statusCode >= 400) { log('✖ Contenedor creado pero falló al arrancar: ' + startRes.body.toString() + '\n'); return finish(1); }
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

  // ── Transmisión en vivo ──
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  const log = (s) => res.write(s);
  const finish = (code, cleanup = true) => {
    if (cleanup) {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
    res.end('\n__TXPL_DONE__' + code);
  };

  // Ejecuta un proceso con salida en vivo y timeout máximo: evita que un build o
  // un "compose up" colgado deje la petición abierta para siempre. Devuelve
  // { code, enoent }: code 124 si se abortó por timeout; enoent true si el binario no existe.
  const MAX_BUILD_MS = 30 * 60 * 1000; // 30 min
  const spawnLive = (cmd, args, cwd) => new Promise((resolve) => {
    let child, enoent = false, timedOut = false;
    try {
      child = spawn(cmd, args, { cwd, env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } });
    } catch (e) {
      if (e.code === 'ENOENT') enoent = true; else res.write('[error] ' + e.message + '\n');
      return resolve({ code: 1, enoent });
    }
    const to = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch (_) {} }, MAX_BUILD_MS);
    child.stdout.on('data', (d) => res.write(d));
    child.stderr.on('data', (d) => res.write(d));
    child.on('error', (e) => {
      clearTimeout(to);
      if (e.code === 'ENOENT') enoent = true; else res.write('\n[error] ' + e.message + '\n');
      resolve({ code: 1, enoent });
    });
    child.on('close', (c) => {
      clearTimeout(to);
      if (timedOut) { res.write('\n[error] Timeout: el proceso superó los 30 minutos y fue abortado.\n'); return resolve({ code: 124, enoent }); }
      resolve({ code: c === null ? 1 : c, enoent });
    });
  });

  const gitOpts = { cwd: dir, timeout: 300_000, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } };

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
    let effEnvs = typeof envs === 'string' ? envs : '';
    if ((template === 'node' || template === 'python') && effContainerPort && !/^\s*PORT\s*=/m.test(effEnvs)) {
      effEnvs = (effEnvs ? effEnvs + '\n' : '') + `PORT=${effContainerPort}`;
    }

    // 6. Crear y arrancar el contenedor (elimina contenedor previo con el mismo nombre si existía)
    log('\n▶ Creando y arrancando contenedor en Docker socket...\n');
    if (name) {
      try {
        await dockerRequest('DELETE', `/containers/${encodeURIComponent(name.trim())}?v=1&force=1`);
      } catch (_) {}
    }
    const config = buildContainerConfig({ image: imageTag, envs: effEnvs, hostPort, containerPort: effContainerPort, volumeBind, proxyDomain });
    const createRes = await dockerRequest('POST', `/containers/create?name=${encodeURIComponent(name)}`, config);
    if (createRes.statusCode >= 400) { log('✖ Error al crear el contenedor: ' + createRes.body.toString() + '\n'); return finish(1); }
    const containerId = JSON.parse(createRes.body.toString()).Id;
    const startRes = await dockerRequest('POST', `/containers/${containerId}/start`);
    if (startRes.statusCode >= 400) { log('✖ Contenedor creado pero falló al arrancar: ' + startRes.body.toString() + '\n'); return finish(1); }
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
        envs: envs || null,
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
    envs: deploy.envs,
    subDir: deploy.sub_dir || undefined,
    dockerfilePath: deploy.dockerfile_path || undefined,
  };

  return deployGitHandler(req, res, next);
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

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DOCKERFILE_PATH, content, 'utf8');

    console.log('[docker] Compilando Dockerfile global...');
    const buildRes = await runSafe('docker', ['build', '-t', 'txpl-global-image', '.'], { cwd: DATA_DIR, timeout: 300_000 });

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
    let composeRes = await runSafe('docker', ['compose', 'up', '-d', '--remove-orphans'], { cwd: DATA_DIR, timeout: 300_000 });

    if (!composeRes.ok) {
      console.log('[docker] docker compose falló, reintentando con docker-compose...');
      composeRes = await runSafe('docker-compose', ['up', '-d', '--remove-orphans'], { cwd: DATA_DIR, timeout: 300_000 });
    }

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
