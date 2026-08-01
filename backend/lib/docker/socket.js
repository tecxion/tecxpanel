'use strict';

// ============================================================
//  TecXPaneL — lib/docker/socket.js
//
//  Comunicación con el socket de Docker (/var/run/docker.sock)
//  vía HTTP nativo (sin SDK). Centraliza `dockerRequest` y
//  `dockerExec`, que estaban acoplados a routes/docker.js.
//  También define la función auxiliar `dockerConfName` y la
//  constante DOCKER_SOCKET.
// ============================================================

const http = require('http');
const fs = require('fs');

const DOCKER_SOCKET = '/var/run/docker.sock';

function dockerConfName(domain) {
  return `txpl-proxy-${domain}`;
}

// Petición genérica a la API de Docker por el socket UNIX.
// Devuelve { statusCode, headers, body (Buffer) }.
// En Windows o sin socket, rechaza limpiamente.
function dockerRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(DOCKER_SOCKET)) {
      return reject(new Error('El socket de Docker no existe o Docker no está instalado.'));
    }

    const options = {
      socketPath: DOCKER_SOCKET,
      path: path,
      method: method,
      headers: { 'Host': 'localhost' },
    };

    if (body) {
      options.headers['Content-Type'] = 'application/json';
    }

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });

    req.on('error', (err) => reject(err));

    if (body) {
      req.write(JSON.stringify(body));
    }
    req.end();
  });
}

// Ejecuta un comando dentro de un contenedor via el exec API de Docker.
// Devuelve { stdout, exitCode }.
// NOTA: la API de exec de Docker necesita dos llamadas y maneja TTY.
// Esta implementación es la misma de exec.json del original (no se cambió).
async function dockerExec(id, cmd) {
  // Crear exec
  const resCreate = await dockerRequest('POST', `/containers/${id}/exec`, {
    AttachStdout: true,
    AttachStderr: true,
    Tty: true,
    Cmd: cmd,
  });
  if (resCreate.statusCode >= 400) {
    throw new Error(`docker exec create failed: ${resCreate.body.toString()}`);
  }
  const execId = JSON.parse(resCreate.body.toString()).Id;

  // Iniciar exec
  const resStart = await dockerRequest('POST', `/exec/${execId}/start`, {
    Detach: false,
    Tty: true,
  });
  // docker attach devuelve un stream multiplexado; lo tratamos como texto.
  let stdout = '';
  if (resStart.body) stdout = resStart.body.toString('utf8');

  // Leer exit code
  const resInspect = await dockerRequest('GET', `/exec/${execId}/json`);
  if (resInspect.statusCode < 400) {
    const info = JSON.parse(resInspect.body.toString());
    if (info.ExitCode !== 0) {
      throw new Error(stdout || `docker exec exited with code ${info.ExitCode}`);
    }
  }

  return { stdout, exitCode: 0 };
}

// Robust decoder for Docker multiplexed log format.
// Detecta si el buffer viene multiplexado (cabecera 8 bytes: type, 3 reserved,
// size BE uint32) o como texto plano, y devuelve el contenido UTF-8.
function decodeDockerLogs(buffer) {
  let offset = 0;
  let output = '';
  let isMultiplexed = true;

  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) break;
    const type = buffer.readUInt8(offset);
    if (type !== 0 && type !== 1 && type !== 2) { isMultiplexed = false; break; }
    const size = buffer.readUInt32BE(offset + 4);
    if (offset + 8 + size > buffer.length) {
      if (size > 1024 * 1024) isMultiplexed = false;
      break;
    }
    offset += 8 + size;
  }

  if (!isMultiplexed || buffer.length === 0) return buffer.toString('utf8');

  offset = 0;
  while (offset < buffer.length) {
    if (offset + 8 > buffer.length) {
      output += buffer.slice(offset).toString('utf8');
      break;
    }
    const size = buffer.readUInt32BE(offset + 4);
    offset += 8;
    let end = offset + size;
    if (end > buffer.length) end = buffer.length;
    output += buffer.slice(offset, end).toString('utf8');
    offset = end;
  }
  return output;
}

module.exports = { DOCKER_SOCKET, dockerConfName, dockerRequest, dockerExec, decodeDockerLogs };