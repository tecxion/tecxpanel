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

module.exports = { MAIL_CONTAINER, MAIL_IMAGE, MAIL_TAG, MAIL_PORTS, MAIL_VOLUMES, buildMailContainerConfig };
