'use strict';

// ============================================================
//  TecXPaneL — lib/docker/deploy.js
//
//  Flujo de despliegue desde Git (clonar + build).
//  Usa los helpers puros de lib/dockerDeploy.js para sanitizar
//  URLs y construir autenticación GIT_CONFIG_*. La orquestación
//  de efectos (git clone, docker build/compose, nginx, UFW)
//  está aquí.
//
//  Exporta helpers:
//    attemptClone    → intenta clonar con token/branch
//    deployGitWorkflow → orquesta todo el flujo git deploy
// ============================================================

const fs = require('fs');
const path = require('path');
const d = require('./deploy');

const { runSafe, runInput } = require('../common/run');
const dockerDeploy = require('../dockerDeploy');
const { DOCKER_SOCKET, dockerConfName, dockerRequest } = require('./socket');
const { DEPLOY_TEMPLATES, buildContainerConfig } = require('./config');
const { applyDockerNetworking } = require('./networking');

const DOCKER_BUILDS_DIR = path.join(process.env.TXL_DIR || '/opt/txpl', 'data', 'docker-builds');
const TXPL_DIR = process.env.TXPL_DIR || '/opt/txpl';
const DOCKERFILE_PATH = path.join(TXPL_DIR, 'data', 'Dockerfile');
const DOCKER_COMPOSE_PATH = path.join(TXPL_DIR, 'data', 'docker-compose.yml');

// ── Helpers de streaming interno (se pasan como callbacks para que el router decida) ─
// Estos wrappers reciben el objeto `res` (express Response) y facilitan construir el
// streaming de deploy git sin exponer Express en lib/ .

function makeStreamHelpers(res) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders ? res.flushHeaders() : null;
  const log = (s) => res.write(s);
  const finish = (code) => res.end('\n__TXPL_DONE__' + code);
  return { log, finish, res };
}

module.exports = { DOCKER_BUILDS_DIR, DOCKERFILE_PATH, DOCKER_COMPOSE_PATH, streamHelpers };