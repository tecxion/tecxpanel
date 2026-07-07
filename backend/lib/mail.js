'use strict';

// ============================================================
//  TecXPaneL — Helpers puros de Correo (docker-mailserver)
//
//  Sin estado ni dependencias del servidor: constantes, validación,
//  config del contenedor Docker, constructores de argumentos del
//  script `setup`, parseo de listados y registros DNS.
// ============================================================

const MAIL_CONTAINER = 'txpl-mail';
const MAIL_IMAGE = 'ghcr.io/docker-mailserver/docker-mailserver';
const MAIL_TAG = 'latest';
const MAIL_PORTS = [25, 465, 587, 143, 993];

// Volúmenes persistentes del contenedor (rutas oficiales de docker-mailserver).
const MAIL_VOLUMES = [
  'txpl_mail_data:/var/mail',
  'txpl_mail_state:/var/mail-state',
  'txpl_mail_logs:/var/log/mail',
  'txpl_mail_config:/tmp/docker-mailserver',
];

function isValidEmail(addr) {
  if (typeof addr !== 'string') return false;
  if (/[\s\n\r]/.test(addr)) return false;
  // local@dominio.tld — un solo @, y el dominio con al menos un punto.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr);
}

function isValidMailDomain(d) {
  if (typeof d !== 'string' || /[\s\n\r]/.test(d)) return false;
  // Etiquetas alfanuméricas separadas por puntos; sin empezar/terminar en guion.
  return /^(?=.{1,253}$)(?:(?!-)[A-Za-z0-9-]{1,63}(?<!-)\.)+[A-Za-z]{2,63}$/.test(d);
}

function isValidMailPassword(p) {
  return typeof p === 'string' && p.length >= 6 && !/[\s\n\r]/.test(p);
}

// Config para la Docker API /containers/create. TLS por Let's Encrypt: se monta
// /etc/letsencrypt en solo lectura y docker-mailserver lo consume (SSL_TYPE).
function buildMailContainerConfig({ hostname, letsencryptDir = '/etc/letsencrypt' } = {}) {
  const exposed = {};
  const bindings = {};
  for (const p of MAIL_PORTS) {
    const key = `${p}/tcp`;
    exposed[key] = {};
    bindings[key] = [{ HostPort: String(p) }];
  }
  return {
    Image: `${MAIL_IMAGE}:${MAIL_TAG}`,
    Hostname: hostname,
    Env: [
      'SSL_TYPE=letsencrypt',
      'PERMIT_DOCKER=none',
      'ENABLE_RSPAMD=1',
      'ENABLE_OPENDKIM=0',
      'ENABLE_CLAMAV=0',
      'ENABLE_FAIL2BAN=0',
      'ONE_DIR=1',
    ],
    ExposedPorts: exposed,
    HostConfig: {
      RestartPolicy: { Name: 'unless-stopped' },
      PortBindings: bindings,
      Binds: [...MAIL_VOLUMES, `${letsencryptDir}:/etc/letsencrypt:ro`],
    },
  };
}

module.exports = {
  MAIL_CONTAINER, MAIL_IMAGE, MAIL_TAG, MAIL_PORTS, MAIL_VOLUMES,
  isValidEmail, isValidMailDomain, isValidMailPassword, buildMailContainerConfig,
};
