'use strict';
// ============================================================
//  TecXPaneL — lib/mail/config.js — constantes + builder de config Docker
// ============================================================

const MAIL_CONTAINER = 'txpl-mail';
const MAIL_IMAGE = process.env.TXPL_MAIL_IMAGE || 'ghcr.io/docker-mailserver/docker-mailserver';
const MAIL_TAG = process.env.TXPL_MAIL_TAG || 'latest';
const MAIL_PORTS = [25, 465, 587, 143, 993];

const MAIL_VOLUMES = [
  'txpl_mail_data:/var/mail',
  'txpl_mail_state:/var/mail-state',
  'txpl_mail_logs:/var/log/mail',
  'txpl_mail_config:/tmp/docker-mailserver',
];

// ssl=true monta docker-mailserver con SSL_TYPE=letsencrypt (requiere que el
// certificado del hostname YA exista en /etc/letsencrypt). Con ssl=false arranca
// sin TLS (útil mientras el hostname aún no está configurado o el cert no se ha
// emitido), evitando un fallo de arranque por certificado ausente.
function buildMailContainerConfig({ hostname, letsencryptDir = '/etc/letsencrypt', ssl = false } = {}) {
  const exposed = {};
  const bindings = {};
  for (const p of MAIL_PORTS) {
    const key = `${p}/tcp`;
    exposed[key] = {};
    bindings[key] = [{ HostPort: String(p) }];
  }
  const env = [
    'PERMIT_DOCKER=none',
    'ENABLE_RSPAMD=1',
    'ENABLE_OPENDKIM=0',
    'ENABLE_CLAMAV=0',
    'ENABLE_FAIL2BAN=0',
    'ONE_DIR=1',
  ];
  if (ssl) env.unshift('SSL_TYPE=letsencrypt');
  return {
    Image: `${MAIL_IMAGE}:${MAIL_TAG}`,
    Hostname: hostname,
    Env: env,
    ExposedPorts: exposed,
    HostConfig: {
      RestartPolicy: { Name: 'unless-stopped' },
      PortBindings: bindings,
      Binds: [...MAIL_VOLUMES, `${letsencryptDir}:/etc/letsencrypt:ro`],
    },
  };
}

module.exports = { MAIL_CONTAINER, MAIL_IMAGE, MAIL_TAG, MAIL_PORTS, MAIL_VOLUMES, buildMailContainerConfig };
