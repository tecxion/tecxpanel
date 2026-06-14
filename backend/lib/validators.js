'use strict';

const ALLOWED_SERVICES = ['nginx', 'mysql', 'mariadb', 'postgresql', 'redis', 'redis-server', 'ssh', 'sshd'];
const ALLOWED_SVC_ACTIONS = ['start', 'stop', 'restart'];
const ALLOWED_APP_ACTIONS = ['start', 'stop', 'restart', 'delete'];
const ALLOWED_SITE_TYPES = ['html', 'php', 'nodejs', 'react', 'python'];
const ALLOWED_APP_TYPES = ['nodejs', 'typescript', 'react', 'python'];
const ALLOWED_DB_TYPES = ['mysql', 'postgresql'];
const LOG_FILES = {
  nginx_access: '/var/log/nginx/access.log',
  nginx_error:  '/var/log/nginx/error.log',
  system:       '/var/log/syslog',
};

const RE_DOMAIN = /^(?=.{1,253}$)(?:(?!-)[A-Za-z0-9-]{1,63}(?<!-)\.)+[A-Za-z]{2,63}$/;
const RE_APP_NAME = /^[a-zA-Z0-9_-]{1,40}$/;
const RE_DB_NAME = /^[a-zA-Z0-9_]{1,32}$/;
const RE_DB_USER = /^[a-zA-Z0-9_]{1,32}$/;
const RE_IP_CIDR = /^(\d{1,3}\.){3}\d{1,3}(\/\d{1,2})?$/;

const isPort = (v) => Number.isInteger(v) && v > 0 && v <= 65535;
const isValidDomain = (d) => typeof d === 'string' && RE_DOMAIN.test(d);

module.exports = {
  ALLOWED_SERVICES, ALLOWED_SVC_ACTIONS, ALLOWED_APP_ACTIONS,
  ALLOWED_SITE_TYPES, ALLOWED_APP_TYPES, ALLOWED_DB_TYPES, LOG_FILES,
  RE_DOMAIN, RE_APP_NAME, RE_DB_NAME, RE_DB_USER, RE_IP_CIDR,
  isPort, isValidDomain,
};
