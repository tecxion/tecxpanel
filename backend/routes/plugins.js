'use strict';

// ============================================================
//  TecXPaneL — Plugins (paquetes del servidor)
//
//  Instala o desinstala software del servidor con un clic: Docker,
//  phpMyAdmin, Adminer, Redis, Fail2Ban, Composer y Certbot.
//  La salida de la instalación se transmite EN VIVO al navegador
//  (streaming), para que el usuario vea el progreso en tiempo real.
// ============================================================

const path = require('path');
const express = require('express');
const { spawn } = require('child_process');
const { ok, fail, clientIp, runSafe, wrap } = require('../lib/helpers');
const { audit } = require('../database');

const SCRIPTS = path.join(__dirname, '..', 'scripts');

const router = express.Router();

// Ejecuta un comando y transmite su salida línea a línea al cliente (streaming).
// En vez de esperar a que termine y mandar todo de golpe, vamos escribiendo en
// la respuesta (res.write) según el proceso produce salida. Al final mandamos
// un marcador "__TXPL_DONE__<código>" para que el frontend sepa que acabó y con
// qué código de salida (0 = éxito).
function streamCommand(res, cmd, args, intro) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no'); // pide a nginx que NO almacene en buffer
  res.flushHeaders?.();
  if (intro) res.write(intro);

  let child;
  try {
    // DEBIAN_FRONTEND=noninteractive evita que apt se quede esperando respuestas.
    child = spawn(cmd, args, { env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } });
  } catch (e) {
    res.write('\n[error] No se pudo iniciar: ' + e.message + '\n');
    return res.end('__TXPL_DONE__1');
  }
  child.stdout.on('data', (d) => res.write(d));
  child.stderr.on('data', (d) => res.write(d));
  child.on('error', (e) => { res.write('\n[error] ' + e.message + '\n'); res.end('__TXPL_DONE__1'); });
  child.on('close', (code) => res.end('\n__TXPL_DONE__' + (code === null ? 1 : code)));
}

// Catálogo de plugins. Para cada uno definimos:
//  - check:     comando para saber si YA está instalado.
//  - install:   comando para instalarlo.
//  - uninstall: comando para desinstalarlo.
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
  adminer: {
    name: 'Adminer', category: 'Base de datos', icon: 'database', desc: 'Gestor web ligero para MySQL y PostgreSQL (puerto 8082)',
    check: ['test', ['-f', '/usr/share/adminer/index.php']],
    install: ['bash', [path.join(SCRIPTS, 'install-adminer.sh')]],
    uninstall: ['bash', [path.join(SCRIPTS, 'uninstall-adminer.sh')]],
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

// GET /api/plugins — Lista los plugins y si están instalados (ejecuta cada "check").
router.get('/', wrap(async (req, res) => {
  const result = [];
  for (const [key, p] of Object.entries(PLUGINS)) {
    const r = await runSafe(p.check[0], p.check[1]);
    result.push({ id: key, name: p.name, category: p.category, icon: p.icon, desc: p.desc, installed: r.ok });
  }
  ok(res, result);
}));

// POST /api/plugins/:id/install — Instala un plugin, transmitiendo la salida.
router.post('/:id/install', (req, res) => {
  const p = PLUGINS[req.params.id];
  if (!p) return fail(res, 404, 'Plugin desconocido');
  audit(req.user.username, clientIp(req), 'plugin.install', req.params.id);
  streamCommand(res, p.install[0], p.install[1], `▶ Instalando ${p.name}...\n\n`);
});

// POST /api/plugins/:id/uninstall — Desinstala un plugin, transmitiendo la salida.
router.post('/:id/uninstall', (req, res) => {
  const p = PLUGINS[req.params.id];
  if (!p) return fail(res, 404, 'Plugin desconocido');
  audit(req.user.username, clientIp(req), 'plugin.uninstall', req.params.id);
  streamCommand(res, p.uninstall[0], p.uninstall[1], `▶ Desinstalando ${p.name}...\n\n`);
});

module.exports = router;
