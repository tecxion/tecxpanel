'use strict';

const express = require('express');
const { ok, fail, clientIp, runSafe, wrap } = require('../lib/helpers');
const { audit } = require('../database');

const router = express.Router();

const PLUGINS = {
  docker: {
    name: 'Docker', category: 'Contenedores', icon: 'brand-docker', desc: 'Motor de contenedores',
    check: ['docker', ['--version']],
    install: ['bash', ['-c', 'curl -fsSL https://get.docker.com | sh']],
    uninstall: ['apt-get', ['remove', '-y', 'docker-ce', 'docker-ce-cli', 'containerd.io']],
  },
  phpmyadmin: {
    name: 'phpMyAdmin', category: 'Base de datos', icon: 'database-cog', desc: 'Administrador web de MySQL',
    check: ['dpkg', ['-s', 'phpmyadmin']],
    install: ['bash', ['-c', 'DEBIAN_FRONTEND=noninteractive apt-get install -y phpmyadmin']],
    uninstall: ['apt-get', ['remove', '-y', 'phpmyadmin']],
  },
  redis: {
    name: 'Redis', category: 'Caché', icon: 'database-heart', desc: 'Almacén clave-valor en memoria',
    check: ['redis-cli', ['ping']],
    install: ['apt-get', ['install', '-y', 'redis-server']],
    uninstall: ['apt-get', ['remove', '-y', 'redis-server']],
  },
  fail2ban: {
    name: 'Fail2Ban', category: 'Seguridad', icon: 'shield-lock', desc: 'Protección contra ataques de fuerza bruta',
    check: ['fail2ban-client', ['status']],
    install: ['apt-get', ['install', '-y', 'fail2ban']],
    uninstall: ['apt-get', ['remove', '-y', 'fail2ban']],
  },
  composer: {
    name: 'Composer', category: 'PHP', icon: 'package', desc: 'Gestor de dependencias PHP',
    check: ['composer', ['--version']],
    install: ['bash', ['-c', 'curl -sS https://getcomposer.org/installer | php -- --install-dir=/usr/local/bin --filename=composer']],
    uninstall: ['rm', ['-f', '/usr/local/bin/composer']],
  },
  certbot: {
    name: 'Certbot', category: 'SSL', icon: 'certificate', desc: 'Certificados SSL Let\'s Encrypt',
    check: ['certbot', ['--version']],
    install: ['apt-get', ['install', '-y', 'certbot', 'python3-certbot-nginx']],
    uninstall: ['apt-get', ['remove', '-y', 'certbot', 'python3-certbot-nginx']],
  },
};

router.get('/', wrap(async (req, res) => {
  const result = [];
  for (const [key, p] of Object.entries(PLUGINS)) {
    const r = await runSafe(p.check[0], p.check[1]);
    result.push({ id: key, name: p.name, category: p.category, icon: p.icon, desc: p.desc, installed: r.ok });
  }
  ok(res, result);
}));

router.post('/:id/install', wrap(async (req, res) => {
  const p = PLUGINS[req.params.id];
  if (!p) return fail(res, 404, 'Plugin desconocido');
  const r = await runSafe(p.install[0], p.install[1]);
  if (!r.ok) return fail(res, 500, r.stderr.split('\n').slice(-2).join(' ') || 'Error instalando');
  audit(req.user.username, clientIp(req), 'plugin.install', req.params.id);
  ok(res);
}));

router.post('/:id/uninstall', wrap(async (req, res) => {
  const p = PLUGINS[req.params.id];
  if (!p) return fail(res, 404, 'Plugin desconocido');
  const r = await runSafe(p.uninstall[0], p.uninstall[1]);
  if (!r.ok) return fail(res, 500, r.stderr.split('\n').slice(-2).join(' ') || 'Error desinstalando');
  audit(req.user.username, clientIp(req), 'plugin.uninstall', req.params.id);
  ok(res);
}));

module.exports = router;
