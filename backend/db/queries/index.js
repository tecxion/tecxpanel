'use strict';

// ============================================================
//  TecXPaneL — queries/index.js
//
//  Agrega todos los módulos queries/<dominio>.js en un único
//  objeto `queries` con las claves planas que consume el resto
//  del panel. Esto preserva la API pública v1:
//
//      const { queries } = require('../database');  // v1
//      queries.listApps.all(...);                   // v1
//      queries.saveN8nConfig.run(...);               // v1
//
//  Sigue funcionando sin tocar los 27 archivos que importan database.
//  Cuando una feature nueva solo use su dominio, puede importarica
//  directamente:
//      const users = require('../db/queries/users');  // v2 más limpio
// ============================================================

const users     = require('./users');
const websites  = require('./websites');
const apps      = require('./apps');
const databases = require('./databases');
const audit     = require('./audit');
const n8n       = require('./n8n');
const notify    = require('./notify');
const mail      = require('./mail');
const dns       = require('./dns');
const backups   = require('./backups');
const cron      = require('./cron');
const catalog   = require('./catalog');
const docker     = require('./docker');

// Agrupa sin mutar los módulos origen (Object.assign shallow).
const queries = Object.assign(
  {},
  users,
  websites,
  apps,
  databases,
  audit,                // exporta insertAudit y getAuditLog planos (compatibilidad v1)
  { audit: audit },     // sub-namespace audit (v2)
  n8n,
  notify,
  mail,
  dns,
  backups,
  cron,
  catalog,
  docker
);

module.exports = queries;
