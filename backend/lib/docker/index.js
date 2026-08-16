'use strict';

// ============================================================
//  TecXPaneL — lib/docker/index.js
//
//  Punto de entrada unificado para el dominio Docker (v2).
//  Reexporta la API pública de socket, config, networking y deploy.
// ============================================================

const socket = require('./socket');
const config = require('./config');
const networking = require('./networking');
const deploy = require('./deploy');
const service = require('./service');

module.exports = {
  ...socket,
  ...config,
  ...networking,
  ...deploy,
  ...service,
};
