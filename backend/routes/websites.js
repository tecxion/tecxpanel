'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const { ok, fail, clientIp, runSafe, wrap } = require('../lib/helpers');
const { ALLOWED_SITE_TYPES, RE_APP_NAME, isValidDomain } = require('../lib/validators');
const { queries, audit } = require('../database');

const SITES_DIR = path.resolve(process.env.SITES_DIR || '/var/www');
const NGINX_AVAILABLE = '/etc/nginx/sites-available';
const NGINX_ENABLED = '/etc/nginx/sites-enabled';

function buildNginxSite(domain, type, proxyPort, opts = {}) {
  const { listenPort, phpVersion } = opts;
  const root = path.join(SITES_DIR, domain, 'public');
  const listen = listenPort ? `listen ${listenPort}` : 'listen 80';
  const serverName = listenPort ? '' : `\n    server_name ${domain} www.${domain};`;
  const fpmSock = phpVersion ? `/run/php/php${phpVersion}-fpm.sock` : '/run/php/php-fpm.sock';

  if (type === 'nodejs' || type === 'python') {
    return `server {\n    ${listen};${serverName}\n    location / {\n        proxy_pass http://127.0.0.1:${proxyPort};\n        proxy_http_version 1.1;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection "upgrade";\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto $scheme;\n    }\n}\n`;
  }
  return `server {\n    ${listen};${serverName}\n    root ${root};\n    index index.html index.htm${type === 'php' ? ' index.php' : ''};\n    location / { try_files $uri $uri/ ${type === 'react' ? '/index.html' : '=404'}; }\n${type === 'php' ? `    location ~ \\.php$ {\n        include snippets/fastcgi-php.conf;\n        fastcgi_pass unix:${fpmSock};\n    }\n` : ''}}\n`;
}

async function installSsl(domain) {
  const r = await runSafe('certbot', ['--nginx', '-d', domain, '-d', `www.${domain}`,
    '--non-interactive', '--agree-tos', '--redirect', '-m', process.env.SSL_EMAIL || `admin@${domain}`]);
  if (!r.ok) throw new Error(r.stderr.split('\n').slice(-3).join(' ') || 'certbot falló');
}

const router = express.Router();

router.get('/', (req, res) => {
  const rows = queries.listWebsites.all().map((w) => ({
    ...w, ssl: !!w.ssl, php: !!w.php, listen_port: w.listen_port || null, php_version: w.php_version || null,
  }));
  ok(res, rows);
});

router.post('/', wrap(async (req, res) => {
  const { domain, type = 'html', php = false, ssl = false, usePort = false, phpVersion } = req.body || {};
  if (!ALLOWED_SITE_TYPES.includes(type)) return fail(res, 400, 'Tipo de sitio inválido');

  let siteDomain, listenPort = null;
  if (usePort) {
    if (!domain || !RE_APP_NAME.test(domain)) return fail(res, 400, 'Nombre inválido (letras, números, guiones)');
    siteDomain = domain;
    if (queries.getWebsiteByDomain.get(siteDomain)) return fail(res, 409, 'Ya existe un sitio con ese nombre');
    const maxRow = queries.getMaxListenPort.get();
    listenPort = Math.max(8001, (maxRow?.maxPort || 8000) + 1);
  } else {
    if (!isValidDomain(domain)) return fail(res, 400, 'Dominio inválido');
    siteDomain = domain;
    if (queries.getWebsiteByDomain.get(siteDomain)) return fail(res, 409, 'Ese dominio ya existe');
  }

  const root = path.join(SITES_DIR, siteDomain, 'public');
  fs.mkdirSync(root, { recursive: true });
  if (type === 'html' || type === 'react') {
    fs.writeFileSync(path.join(root, 'index.html'),
      `<!doctype html><meta charset="utf-8"><title>${siteDomain}</title><h1>${siteDomain}</h1><p>Servido por TecXPaneL.</p>`);
  }

  const conf = buildNginxSite(siteDomain, type, 3000, { listenPort, phpVersion: phpVersion || null });
  const confPath = path.join(NGINX_AVAILABLE, siteDomain);
  fs.writeFileSync(confPath, conf);
  try { fs.symlinkSync(confPath, path.join(NGINX_ENABLED, siteDomain)); } catch (e) { if (e.code !== 'EEXIST') throw e; }

  const test = await runSafe('nginx', ['-t']);
  if (!test.ok) { fs.rmSync(path.join(NGINX_ENABLED, siteDomain), { force: true }); return fail(res, 500, 'Config nginx inválida: ' + test.stderr.split('\n')[0]); }
  await runSafe('systemctl', ['reload', 'nginx']);
  if (listenPort) await runSafe('ufw', ['allow', `${listenPort}/tcp`]);

  const info = queries.insertWebsite.run({ domain: siteDomain, type, php: php ? 1 : 0, ssl: 0, status: 'active', listen_port: listenPort, php_version: phpVersion || null });
  audit(req.user.username, clientIp(req), 'website.create', siteDomain);
  if (ssl && !usePort) await installSsl(siteDomain).catch(() => {});
  ok(res, { success: true, id: info.lastInsertRowid, port: listenPort });
}));

router.delete('/:id', wrap(async (req, res) => {
  const site = queries.getWebsite.get(+req.params.id);
  if (!site) return fail(res, 404, 'Sitio no encontrado');
  fs.rmSync(path.join(NGINX_ENABLED, site.domain), { force: true });
  fs.rmSync(path.join(NGINX_AVAILABLE, site.domain), { force: true });
  await runSafe('systemctl', ['reload', 'nginx']);
  if (site.listen_port) await runSafe('ufw', ['delete', 'allow', `${site.listen_port}/tcp`]);
  queries.deleteWebsite.run(site.id);
  audit(req.user.username, clientIp(req), 'website.delete', site.domain);
  ok(res);
}));

router.post('/:id/ssl', wrap(async (req, res) => {
  const site = queries.getWebsite.get(+req.params.id);
  if (!site) return fail(res, 404, 'Sitio no encontrado');
  await installSsl(site.domain);
  queries.setWebsiteSsl.run(site.id);
  audit(req.user.username, clientIp(req), 'website.ssl', site.domain);
  ok(res);
}));

module.exports = router;
