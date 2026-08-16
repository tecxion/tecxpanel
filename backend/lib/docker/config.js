'use strict';

// ============================================================
//  TecXPaneL — lib/docker/config.js
//
//  Plantillas de Dockerfile + builder de config de contenedor
//  + flattenSingleSubdir (ayuda para ZIPs de folder raíz).
//
//  Estos son helpers PUROS (sin efectos de red ni filesystem
//  protegidos). Usados por routes/docker.js y por deploy.js.
// ============================================================

const fs = require('fs');
const path = require('path');

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
    gen: (port) => `FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nRUN if [ -f package-lock.json ]; then npm ci --omit=dev; elif [ -f package.json ]; then npm install --omit=dev; else echo "No se encontró package.json"; fi\nEXPOSE ${port}\nCMD ["npm","start"]\n`,
  },
  python: {
    label: 'Python', containerPort: 8000, fixedPort: false,
    gen: (port) => `FROM python:3.12-slim\nWORKDIR /app\nCOPY . .\nRUN if [ -f requirements.txt ]; then pip install --no-cache-dir -r requirements.txt; else echo "No se encontró requirements.txt"; fi\nEXPOSE ${port}\nCMD ["python","app.py"]\n`,
  },
  dockerfile: {
    label: 'Ya tengo Dockerfile', containerPort: null, fixedPort: false,
    gen: null,
  },
};

// Construye la config que se envía a la Docker API. Reutilizada por la creación
// manual (/containers/create) y por el asistente de despliegue (/deploy/build).
function buildContainerConfig({ image, envs, hostPort, containerPort, volumeBind, proxyDomain }) {
  const config = {
    Image: image,
    Env: [],
    HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
  };
  if (envs && typeof envs === 'string') {
    config.Env = envs.split('\n').map((l) => l.trim()).filter((l) => l && l.includes('='));
  }
  if (hostPort && containerPort) {
    const cp = String(containerPort);
    const cPort = cp.includes('/') ? cp : `${cp}/tcp`;
    config.ExposedPorts = { [cPort]: {} };
    config.HostConfig.PortBindings = { [cPort]: [{ HostPort: String(hostPort) }] };
  }
  if (volumeBind) config.HostConfig.Binds = [volumeBind];
  if (proxyDomain) config.Labels = { 'txpl.domain': proxyDomain };
  return config;
}

// Después de extraer un ZIP que a veces empaqueta la raíz como si fuera una
// subcarpeta "myapp/", aplana: si hay un único subdirectorio (y no hay otros
// archivos), promueve su contenido a la raíz. También limpia __MACOSX.
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

module.exports = { DEPLOY_TEMPLATES, buildContainerConfig, flattenSingleSubdir };
