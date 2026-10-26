'use strict';

// ============================================================
//  TecXPaneL — Gestión de SITIOS WEB (vhosts de Nginx)
//
//  Aquí se crean, listan y borran sitios web. Cada sitio es un
//  bloque de configuración de Nginx que sirve archivos (HTML, PHP,
//  React) o hace de proxy hacia una app (Node/Python).
//  Toda la "fontanería" de Nginx (generar el vhost, activarlo,
//  recargar, instalar HTTPS) vive en ../lib/nginx para no repetirla.
// ============================================================

const path = require('path');
const fs = require('fs');
const express = require('express');
const { ok, fail, clientIp, runSafe, wrap } = require('../lib/helpers');
const crypto = require('crypto');
const {
  ALLOWED_SITE_TYPES, RE_APP_NAME, isValidDomain, isPort,
  isValidGitUrl, isValidGitBranch,
} = require('../lib/validators');
const { isValidGitToken, tokenNeedsHttps } = require('../lib/deploy');
const deploy = require('../lib/deploy/engine');
const { encryptSecret, decryptSecret } = require('../lib/crypto');
const nginx = require('../lib/nginx');
const phpEngine = require('../lib/php/engine');
const { queries, audit } = require('../database');

// Carpeta raíz de los sitios (la define lib/nginx a partir de SITES_DIR).
const SITES_DIR = nginx.SITES_DIR;

const router = express.Router();

// Carpeta pública de un sitio: lo ÚNICO que Nginx sirve a internet. Aquí van los
// archivos subidos y el clon de Git. El dominio ya viene validado (isValidDomain /
// RE_APP_NAME), así que no puede salirse de SITES_DIR.
const publicDir = (domain) => path.join(SITES_DIR, domain, 'public');

// GET /api/websites — Lista todos los sitios web guardados en la BD.
// El flag SSL se lee del SISTEMA (Let's Encrypt) y no de la columna ssl de la
// BD, porque el panel no siempre puede actualizarla (emisión desde el módulo
// SSL, --expand desde otro sitio, borrado externo con certbot delete...). Se
// mira si existe /etc/letsencrypt/live/<dominio>/fullchain.pem, que es donde
// certbot guarda el cert por Certificate Name (= primer -d que le pasamos).
router.get('/', (req, res) => {
  const rows = queries.listWebsites.all().map(({ git_token, ...w }) => ({
    ...w, // (el token cifrado nunca sale de la BD)
    ssl: fs.existsSync(`/etc/letsencrypt/live/${w.domain}/fullchain.pem`),
    php: !!w.php,
    listen_port: w.listen_port || null,
    php_version: w.php_version || null,
  }));
  ok(res, rows);
});

// Validador de versión de PHP-FPM: "X.Y" (ej. "8.3"). SEGURIDAD: sin esto,
// un phpVersion malicioso ("../../etc/passwd") acababa interpolado dentro
// del vhost como fastcgi_pass unix:/run/php/php../../etc/passwd-fpm.sock.
const RE_PHP_VER = /^\d+\.\d+$/;

// POST /api/websites — Crea un sitio web nuevo.
// Admite dos modos: por dominio (ejemplo.com) o por IP:puerto (sin dominio).
router.post('/', wrap(async (req, res) => {
  const { domain, type = 'html', ssl = false, usePort = false, phpVersion, proxyPort,
    git_repo, git_branch, git_token } = req.body || {};
  if (!ALLOWED_SITE_TYPES.includes(type)) return fail(res, 400, 'Tipo de sitio inválido');
  const proxyPortNum = type === 'proxy' ? parseInt(proxyPort, 10) : null;
  if (type === 'proxy' && !isPort(proxyPortNum)) return fail(res, 400, 'Indica el puerto local al que reenviar (1-65535)');

  // Origen Git opcional (no aplica a proxy: no hay archivos que servir).
  const gitRepo = type !== 'proxy' && git_repo ? String(git_repo).trim() : null;
  const gitBranch = gitRepo ? String(git_branch || 'main').trim() : null;
  if (gitRepo) {
    if (!isValidGitUrl(gitRepo)) return fail(res, 400, 'URL de repositorio Git inválida (usa https://… o git@host:usuario/repo.git)');
    if (!isValidGitBranch(gitBranch)) return fail(res, 400, 'Nombre de rama inválido');
    if (git_token && !isValidGitToken(git_token)) return fail(res, 400, 'Token de acceso inválido');
    if (tokenNeedsHttps(gitRepo, git_token)) return fail(res, 400, 'El token solo se puede usar con una URL https://');
  }
  if (phpVersion && !RE_PHP_VER.test(String(phpVersion))) return fail(res, 400, 'Versión de PHP inválida (formato esperado X.Y, ej. 8.3)');

  // php2shell: no crear sitios PHP sobre una versión instalada sin parchear.
  // Con "auto-detectar" se usa la más alta instalada (ver detectPhpFpmSock).
  if (type === 'php') {
    const branches = await phpEngine.check();
    const target = phpVersion
      ? branches.find((b) => b.branch === String(phpVersion))
      : branches.slice().sort((a, b) => parseFloat(b.branch) - parseFloat(a.branch))[0];
    if (!target) return fail(res, 400, phpVersion ? `PHP ${phpVersion} no está instalado.` : 'No hay PHP-FPM instalado.');
    if (!target.patched) return fail(res, 400, `PHP ${target.branch} no tiene el parche de php2shell (CVE-2026-109618/109619). Actualiza PHP (POST /api/php/patch o txpl-update.sh) antes de crear sitios PHP.`);
  }

  let siteDomain, listenPort = null;
  if (usePort) {
    // Modo sin dominio: el sitio se sirve en un puerto propio (8001, 8002, ...).
    if (!domain || !RE_APP_NAME.test(domain)) return fail(res, 400, 'Nombre inválido (letras, números, guiones)');
    siteDomain = domain;
    if (queries.getWebsiteByDomain.get(siteDomain)) return fail(res, 409, 'Ya existe un sitio con ese nombre');
    // Buscamos el puerto más alto usado y asignamos el siguiente libre.
    const maxRow = queries.getMaxListenPort.get();
    listenPort = Math.max(8001, (maxRow?.maxPort || 8000) + 1);
  } else {
    // Modo con dominio: validamos que sea un dominio real.
    if (!isValidDomain(domain)) return fail(res, 400, 'Dominio inválido');
    siteDomain = domain;
    if (queries.getWebsiteByDomain.get(siteDomain)) return fail(res, 409, 'Ese dominio ya existe');
  }

  // Creamos la carpeta pública del sitio y, para HTML/React, una página de bienvenida.
  const root = publicDir(siteDomain);
  if (gitRepo) {
    // Clonamos ANTES de crear el vhost: si el repo/token falla no queda nada a medias.
    fs.mkdirSync(path.dirname(root), { recursive: true });
    const c = await deploy.cloneRepo(root, gitRepo, gitBranch, git_token);
    if (!c.ok) {
      fs.rmSync(path.dirname(root), { recursive: true, force: true });
      return fail(res, 400, `Error al clonar el repositorio: ${c.error}`);
    }
  } else {
    fs.mkdirSync(root, { recursive: true });
    if (type === 'html' || type === 'react') {
      fs.writeFileSync(path.join(root, 'index.html'),
        `<!doctype html><meta charset="utf-8"><title>${siteDomain}</title><h1>${siteDomain}</h1><p>Servido por TecXPaneL.</p>`);
    }
  }

  // Generamos el vhost y lo activamos. enableSite valida la config y revierte
  // automáticamente si Nginx la rechaza, así que un fallo no rompe el servidor.
  const conf = nginx.buildSite(siteDomain, type, proxyPortNum, { listenPort, phpVersion: phpVersion || null });
  try {
    await nginx.enableSite(siteDomain, conf);
  } catch (e) {
    return fail(res, 500, e.message);
  }
  // Si el sitio usa puerto propio, lo abrimos en el firewall.
  if (listenPort) await runSafe('ufw', ['allow', `${listenPort}/tcp`]);

  // Guardamos el sitio en la BD y registramos la acción en la auditoría.
  // php:0 fijo. El flag no lo usa nadie (el vhost se decide por `type='php'`).
  // Se mantiene la columna para no romper el esquema, pero no se expone en la UI.
  const info = queries.insertWebsite.run({
    domain: siteDomain, type, php: 0, ssl: 0, status: 'active', listen_port: listenPort, php_version: phpVersion || null,
    proxy_port: proxyPortNum, git_repo: gitRepo, git_branch: gitBranch,
    git_token: gitRepo && git_token ? encryptSecret(git_token) : null,
    webhook_secret: gitRepo ? crypto.randomBytes(16).toString('hex') : null,
  });
  audit(req.user.username, clientIp(req), 'website.create', siteDomain + (gitRepo ? ' (Git)' : ''));
  // Si se pidió HTTPS (y hay dominio), intentamos instalarlo sin bloquear la respuesta.
  if (ssl && !usePort) await nginx.installSsl(siteDomain).catch(() => {});
  ok(res, { success: true, id: info.lastInsertRowid, port: listenPort });
}));

// DELETE /api/websites/:id — Borra un sitio: quita su vhost, cierra el puerto
// del firewall si lo tenía y lo elimina de la BD.
router.delete('/:id', wrap(async (req, res) => {
  const site = queries.getWebsite.get(+req.params.id);
  if (!site) return fail(res, 404, 'Sitio no encontrado');
  await nginx.removeSite(site.domain);
  if (site.listen_port) await runSafe('ufw', ['delete', 'allow', `${site.listen_port}/tcp`]);
  queries.deleteWebsite.run(site.id);
  audit(req.user.username, clientIp(req), 'website.delete', site.domain);
  ok(res);
}));

// GET /api/websites/:id/vhost — Devuelve el contenido del fichero de vhost
// (para debugging). Solo lee ficheros dentro de NGINX_AVAILABLE con el
// nombre = domain del sitio; sin poder pedir rutas arbitrarias.
router.get('/:id/vhost', wrap(async (req, res) => {
  const site = queries.getWebsite.get(+req.params.id);
  if (!site) return fail(res, 404, 'Sitio no encontrado');
  const confPath = path.join(nginx.NGINX_AVAILABLE, site.domain);
  if (!fs.existsSync(confPath)) return fail(res, 404, 'Este sitio no tiene fichero de vhost en Nginx.');
  const content = fs.readFileSync(confPath, 'utf8');
  ok(res, { success: true, path: confPath, content });
}));

// POST /api/websites/:id/rebuild-vhost — Regenera el vhost sin borrar los
// archivos ni perder el SSL. Útil tras cambios en buildSite (autodetección de
// PHP-FPM, ajustes de plantilla). Si el sitio tiene SSL, se re-aplica con
// installSsl (idempotente: --keep-until-expiring no re-emite si sigue vivo).
router.post('/:id/rebuild-vhost', wrap(async (req, res) => {
  const site = queries.getWebsite.get(+req.params.id);
  if (!site) return fail(res, 404, 'Sitio no encontrado');
  const conf = nginx.buildSite(site.domain, site.type, site.proxy_port || 3000, {
    listenPort: site.listen_port || null,
    phpVersion: site.php_version || null,
  });
  try {
    await nginx.enableSite(site.domain, conf);
  } catch (e) {
    return fail(res, 500, e.message);
  }
  const hadSsl = !site.listen_port && fs.existsSync(`/etc/letsencrypt/live/${site.domain}/fullchain.pem`);
  if (hadSsl) await nginx.installSsl(site.domain).catch(() => {});
  audit(req.user.username, clientIp(req), 'website.rebuild', site.domain);
  ok(res);
}));

// POST /api/websites/:id/ssl — Instala HTTPS (Let's Encrypt) en un sitio existente.
router.post('/:id/ssl', wrap(async (req, res) => {
  const site = queries.getWebsite.get(+req.params.id);
  if (!site) return fail(res, 404, 'Sitio no encontrado');
  if (site.listen_port) { const e = new Error('SSL requiere un dominio; este sitio se sirve por IP:puerto.'); e.http = 400; throw e; }
  try {
    await nginx.installSsl(site.domain);
  } catch (err) {
    // Exponemos el motivo real de certbot (DNS que no apunta aquí, puerto 80
    // cerrado, rate-limit de Let's Encrypt...) en vez de un 500 opaco.
    err.http = 502;
    err.message = `Certbot no pudo emitir el certificado: ${err.message}`;
    throw err;
  }
  queries.setWebsiteSsl.run(site.id);
  audit(req.user.username, clientIp(req), 'website.ssl', site.domain);
  ok(res);
}));

// POST /api/websites/:id/extract — Tras subir un .zip/.tar.gz a la carpeta pública,
// lo descomprime ahí mismo (y aplana la carpeta raíz del ZIP si la trae).
router.post('/:id/extract', wrap(async (req, res) => {
  const site = queries.getWebsite.get(+req.params.id);
  if (!site) return fail(res, 404, 'Sitio no encontrado');
  if (site.type === 'proxy') return fail(res, 400, 'Un sitio proxy no tiene archivos');
  const dir = publicDir(site.domain);
  if (!fs.existsSync(dir)) return fail(res, 400, 'La carpeta del sitio no existe');
  const archive = await deploy.extractArchive(dir);
  if (!archive) return fail(res, 400, 'No hay ningún .zip/.tar.gz en la carpeta pública del sitio');
  audit(req.user.username, clientIp(req), 'website.extract', site.domain);
  ok(res, { success: true, archive });
}));

// POST /api/websites/:id/git-pull — Trae lo último del repo a la carpeta pública
// (misma acción que el webhook, pero a mano desde el panel).
router.post('/:id/git-pull', wrap(async (req, res) => {
  const site = queries.getWebsite.get(+req.params.id);
  if (!site) return fail(res, 404, 'Sitio no encontrado');
  if (!site.git_repo) return fail(res, 400, 'Este sitio no está conectado a un repositorio Git');
  const r = await deploy.pullRepo(publicDir(site.domain), site.git_branch || 'main', decryptSecret(site.git_token));
  if (!r.ok) return fail(res, 502, `Error al actualizar desde Git: ${r.error}`);
  audit(req.user.username, clientIp(req), 'website.git-pull', site.domain);
  ok(res);
}));

module.exports = router;
