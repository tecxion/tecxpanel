'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { ok, fail, clientIp, runSafe, wrap } = require('../lib/helpers');
const { audit } = require('../database');

const router = express.Router();
const DOCKER_SOCKET = '/var/run/docker.sock';

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

// ── Endpoints ──────────────────────────────────────────────────

// GET /api/docker/containers - List all containers
router.get('/containers', wrap(async (req, res) => {
  try {
    const result = await dockerRequest('GET', '/containers/json?all=1');
    if (result.statusCode >= 400) {
      return fail(res, result.statusCode, `Error de Docker API: ${result.body.toString()}`);
    }
    const containers = JSON.parse(result.body.toString());
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
    // Antes de borrar, leer los puertos publicados para cerrarlos luego en UFW.
    const hostPorts = [];
    try {
      const insp = await dockerRequest('GET', `/containers/${id}/json`);
      if (insp.statusCode < 400) {
        const info = JSON.parse(insp.body.toString());
        const bindings = (info && info.HostConfig && info.HostConfig.PortBindings) || {};
        for (const arr of Object.values(bindings)) {
          for (const b of (arr || [])) {
            if (b && b.HostPort) hostPorts.push(b.HostPort);
          }
        }
      }
    } catch (_) { /* best-effort: si no se puede inspeccionar, seguimos con el borrado */ }

    const result = await dockerRequest('DELETE', `/containers/${id}?v=1&force=1`);
    if (result.statusCode === 204) {
      // Cerrar en el firewall los puertos que habíamos abierto al crear (best-effort).
      for (const p of [...new Set(hostPorts)]) {
        await runSafe('ufw', ['delete', 'allow', `${p}/tcp`]);
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
  const { name, image, hostPort, containerPort, envs, dockerfile, volumeName, volumePath } = req.body || {};

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

    // 2. Build configuration
    const config = {
      Image: targetImage,
      Env: [],
      // Reinicio automático: el contenedor vuelve solo tras un reinicio del VPS o una caída.
      HostConfig: { RestartPolicy: { Name: 'unless-stopped' } }
    };

    if (envs && typeof envs === 'string') {
      config.Env = envs.split('\n')
        .map(line => line.trim())
        .filter(line => line && line.includes('='));
    }

    if (hostPort && containerPort) {
      // containerPort puede llegar como número desde el frontend; normalizar a "<puerto>/tcp".
      const cp = String(containerPort);
      const cPort = cp.includes('/') ? cp : `${cp}/tcp`;
      config.ExposedPorts = { [cPort]: {} };
      config.HostConfig.PortBindings = {
        [cPort]: [{ HostPort: String(hostPort) }]
      };
    }

    // Volumen con nombre para datos persistentes (opcional). Docker lo crea solo si no existe.
    if (volumeBind) {
      config.HostConfig.Binds = [volumeBind];
    }

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

    audit(req.user.username, clientIp(req), 'docker.create', name || targetImage);
    ok(res, { success: true, id: containerId });
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
