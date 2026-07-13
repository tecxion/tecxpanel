'use strict';

// ============================================================
//  TecXPaneL — Helpers puros de Logs
//
//  Construcción segura de rutas de log por sitio y normalización
//  del número de líneas. Sin efectos: la lectura vive en routes/logs.js.
// ============================================================

const { isValidDomain } = require('./validators');

// Tipos de log por sitio permitidos (lista blanca).
const SITE_LOG_KINDS = ['access', 'error'];

// Ruta del log de un sitio: /var/log/nginx/<dominio>.<tipo>.log.
// Devuelve null si el dominio o el tipo no son válidos (anti-traversal).
function siteLogPath(domain, kind) {
  if (!isValidDomain(domain) || !SITE_LOG_KINDS.includes(kind)) return null;
  return `/var/log/nginx/${domain}.${kind}.log`;
}

// Normaliza el nº de líneas a leer: por defecto 300, entre 50 y 2000.
function clampLines(value) {
  const n = parseInt(value, 10);
  if (Number.isNaN(n)) return 300;
  if (n < 50) return 50;
  if (n > 2000) return 2000;
  return n;
}

module.exports = { siteLogPath, clampLines, SITE_LOG_KINDS };
