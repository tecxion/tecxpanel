'use strict';

// ============================================================
//  TecXPaneL — Helpers puros del Catálogo de aplicaciones
//
//  Definición DECLARATIVA de las apps instalables con un clic y
//  funciones puras (sin DB, sin efectos) para validar opciones y
//  construir configuraciones. Añadir una app nueva = añadir una
//  entrada a CATALOG + sus tests.
// ============================================================

const { isValidDomain } = require('./validators');

// Cada entrada declara: modos soportados, receta docker (imagen con TAG
// FIJADO — sin tag la Docker API descarga TODAS las etiquetas), receta
// nativa/pm2 y si necesita base de datos MySQL del host.
const CATALOG = [
  {
    id: 'wordpress',
    name: 'WordPress',
    description: 'El CMS más usado del mundo. Blogs, webs corporativas y tiendas (WooCommerce).',
    icon: 'ti-brand-wordpress',
    modes: ['docker', 'native'],
    docker: { image: 'wordpress', tag: '6.8-apache', port: 80, dataPath: '/var/www/html' },
    native: { type: 'php' },
    db: 'mysql',
  },
  {
    id: 'ghost',
    name: 'Ghost',
    description: 'Plataforma de publicación y newsletters, moderna y rápida (Node.js).',
    icon: 'ti-ghost',
    modes: ['docker', 'pm2'],
    docker: { image: 'ghost', tag: '5-alpine', port: 2368, dataPath: '/var/lib/ghost/content' },
    native: { type: 'node' },
    db: 'mysql',
  },
  {
    id: 'nextcloud',
    name: 'Nextcloud',
    description: 'Tu nube privada: archivos, fotos, calendario y contactos. (SQLite interno, válido para uso personal.)',
    icon: 'ti-cloud',
    modes: ['docker'],
    docker: { image: 'nextcloud', tag: '31-apache', port: 80, dataPath: '/var/www/html' },
    native: null,
    db: null,
  },
  {
    id: 'vaultwarden',
    name: 'Vaultwarden',
    description: 'Gestor de contraseñas compatible con Bitwarden, ligero y auto-alojado.',
    icon: 'ti-shield-lock',
    modes: ['docker'],
    docker: { image: 'vaultwarden/server', tag: '1.34.1', port: 80, dataPath: '/data' },
    native: null,
    db: null,
  },
  {
    id: 'uptime-kuma',
    name: 'Uptime Kuma',
    description: 'Monitorización de servicios con avisos: web, TCP, ping, certificados.',
    icon: 'ti-activity-heartbeat',
    modes: ['docker', 'pm2'],
    docker: { image: 'louislam/uptime-kuma', tag: '1', port: 3001, dataPath: '/app/data' },
    native: { type: 'node' },
    db: null,
  },
];

const getEntry = (id) => CATALOG.find((e) => e.id === id) || null;

const containerName = (id) => `txpl-app-${id}`;
const pm2Name = (id) => `txpl-app-${id}`;
const volumeName = (id) => `txpl_${id}_data`;
const nginxConfName = (id) => `txpl-app-${id}`;

// Valida y NORMALIZA las opciones de instalación. Devuelve
// { ok:true, opts:{ mode, domain, ssl } } o { ok:false, error }.
function validateInstallOptions(entry, raw = {}) {
  const mode = String(raw.mode || '');
  if (!entry.modes.includes(mode)) {
    return { ok: false, error: `La app ${entry.name} no soporta el modo "${mode}".` };
  }
  let domain = null;
  const domainRaw = String(raw.domain || '').trim();
  if (domainRaw) {
    if (!isValidDomain(domainRaw)) return { ok: false, error: 'Dominio inválido.' };
    domain = domainRaw;
  }
  // El modo nativo PHP escribe en /var/www/<dominio>: el dominio es obligatorio.
  if (mode === 'native' && !domain) {
    return { ok: false, error: 'El modo nativo requiere un dominio.' };
  }
  const ssl = !!raw.ssl;
  if (ssl && !domain) return { ok: false, error: 'SSL requiere un dominio.' };
  return { ok: true, opts: { mode, domain, ssl } };
}

module.exports = {
  CATALOG, getEntry,
  containerName, pm2Name, volumeName, nginxConfName,
  validateInstallOptions,
};
