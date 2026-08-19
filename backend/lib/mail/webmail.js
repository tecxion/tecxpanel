'use strict';
// ============================================================
//  TecXPaneL — lib/mail/webmail.js — config del contenedor Roundcube
// ============================================================

const WEBMAIL_CONTAINER = 'txpl-webmail';
const WEBMAIL_IMAGE = 'roundcube/roundcubemail';
const WEBMAIL_TAG = process.env.TXPL_WEBMAIL_TAG || '1.6.x-apache'; // rolling última 1.6.x (el tag '1.6-apache' NO existe en Docker Hub)
const WEBMAIL_VOLUME = 'txpl_webmail_data';

function buildWebmailContainerConfig({ hostPort, mailHostname, domain = null } = {}) {
  return {
    Image: `${WEBMAIL_IMAGE}:${WEBMAIL_TAG}`,
    Env: [
      `ROUNDCUBEMAIL_DEFAULT_HOST=ssl://${mailHostname}`,
      'ROUNDCUBEMAIL_DEFAULT_PORT=993',
      `ROUNDCUBEMAIL_SMTP_SERVER=tls://${mailHostname}`,
      'ROUNDCUBEMAIL_SMTP_PORT=587',
    ],
    ExposedPorts: { '80/tcp': {} },
    HostConfig: {
      RestartPolicy: { Name: 'unless-stopped' },
      PortBindings: { '80/tcp': [{ HostIp: '127.0.0.1', HostPort: String(hostPort) }] },
      Binds: [`${WEBMAIL_VOLUME}:/var/roundcube/config`],
    },
    Labels: domain ? { 'txpl.domain': domain } : {},
  };
}

module.exports = { WEBMAIL_CONTAINER, WEBMAIL_IMAGE, WEBMAIL_TAG, WEBMAIL_VOLUME, buildWebmailContainerConfig };