'use strict';

// ============================================================
//  TecXPaneL — Utilidades de Nginx (capa compartida)
//
//  ¿Por qué existe este archivo?
//  Antes, la lógica para crear configuraciones de Nginx ("vhosts")
//  estaba copiada en cuatro sitios distintos: sitios web, apps,
//  Docker y bases de datos (phpMyAdmin). Eso es frágil: si arreglas
//  algo en uno, los demás se quedan desactualizados.
//
//  Aquí lo unificamos todo en un único lugar:
//    1) GENERADORES: funciones que devuelven el TEXTO de un vhost.
//    2) OPERACIONES: funciones que escriben ese texto en disco,
//       comprueban que Nginx lo acepta y recargan el servicio.
//
//  Un "vhost" (virtual host) es un bloque `server { ... }` que le
//  dice a Nginx cómo atender un dominio o un puerto concreto.
// ============================================================

const path = require('path');
const fs = require('fs');
const { runSafe } = require('./helpers');

// Carpetas estándar de Nginx en Debian/Ubuntu:
//  - sites-available: donde viven TODOS los ficheros de configuración.
//  - sites-enabled:   enlaces simbólicos a los que están ACTIVOS.
// Activar un sitio = crear un symlink de "available" a "enabled".
const NGINX_AVAILABLE = '/etc/nginx/sites-available';
const NGINX_ENABLED = '/etc/nginx/sites-enabled';

// Carpeta raíz donde se alojan los archivos de los sitios web.
// path.resolve normaliza la ruta (quita "..", barras dobles, etc.).
const SITES_DIR = path.resolve(process.env.SITES_DIR || '/var/www');

// ── GENERADORES DE VHOST ──────────────────────────────────────

// Genera el vhost de un SITIO WEB según su tipo.
//  - domain:    el dominio (ej. "ejemplo.com") o un nombre si se sirve por puerto.
//  - type:      'html' | 'php' | 'react' | 'nodejs' | 'python'.
//  - proxyPort: puerto local al que reenviar si es app Node/Python.
//  - opts.listenPort: si se sirve por IP:puerto en vez de por dominio.
//  - opts.phpVersion: versión de PHP-FPM a usar (ej. "8.3").
// Devuelve el texto del bloque `server { ... }` listo para guardar.
function buildSite(domain, type, proxyPort, opts = {}) {
  const { listenPort, phpVersion } = opts;
  // Carpeta pública del sitio (donde están los index.html, etc.).
  const root = path.join(SITES_DIR, domain, 'public');
  // Si hay puerto propio, Nginx escucha en él; si no, en el 80 (HTTP normal).
  const listen = listenPort ? `listen ${listenPort}` : 'listen 80';
  // El server_name solo tiene sentido cuando se accede por dominio.
  const serverName = listenPort ? '' : `\n    server_name ${domain} www.${domain};`;
  // Socket de PHP-FPM: el de la versión indicada o el genérico.
  const fpmSock = phpVersion ? `/run/php/php${phpVersion}-fpm.sock` : '/run/php/php-fpm.sock';

  // Node.js y Python no sirven archivos: se hace de "proxy inverso" hacia
  // el puerto donde corre su proceso.
  if (type === 'nodejs' || type === 'python') {
    return `server {\n    ${listen};${serverName}\n    location / {\n        proxy_pass http://127.0.0.1:${proxyPort};\n        proxy_http_version 1.1;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection "upgrade";\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto $scheme;\n    }\n}\n`;
  }
  // HTML/PHP/React sí sirven archivos desde "root".
  //  - React: si no encuentra el archivo, devuelve index.html (rutas SPA).
  //  - PHP: añade el bloque que pasa los .php a PHP-FPM.
  return `server {\n    ${listen};${serverName}\n    root ${root};\n    index index.html index.htm${type === 'php' ? ' index.php' : ''};\n    location / { try_files $uri $uri/ ${type === 'react' ? '/index.html' : '=404'}; }\n${type === 'php' ? `    location ~ \\.php$ {\n        include snippets/fastcgi-php.conf;\n        fastcgi_pass unix:${fpmSock};\n    }\n` : ''}}\n`;
}

// Genera un vhost de PROXY INVERSO: el dominio reenvía todo el tráfico a
// un proceso que escucha en 127.0.0.1:<port> (una app o un contenedor).
//  - opts.www: si true, también responde a "www.<dominio>" (sitios/apps);
//    para subdominios tipo "app.midominio.com" se deja en false (Docker).
function buildProxy(domain, port, opts = {}) {
  const { www = false } = opts;
  const serverName = www ? `${domain} www.${domain}` : `${domain}`;
  return `server {\n    listen 80;\n    server_name ${serverName};\n    location / {\n        proxy_pass http://127.0.0.1:${port};\n        proxy_http_version 1.1;\n        proxy_set_header Upgrade $http_upgrade;\n        proxy_set_header Connection "upgrade";\n        proxy_set_header Host $host;\n        proxy_set_header X-Real-IP $remote_addr;\n        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;\n        proxy_set_header X-Forwarded-Proto $scheme;\n    }\n}\n`;
}

// Genera un vhost para una app PHP servida con PHP-FPM en un PUERTO propio
// (lo usa phpMyAdmin). server_name "_" = "responde a cualquier nombre".
//  - port: puerto en el que escucha (ej. 8081).
//  - root: carpeta con el código PHP (ej. /usr/share/phpmyadmin).
//  - sock: socket de PHP-FPM al que enviar los .php.
function buildPhpFpmSite(port, root, sock) {
  return `server {
    listen ${port};
    server_name _;
    root ${root};
    index index.php index.html;
    location / { try_files $uri $uri/ /index.php?$query_string; }
    location ~ \\.php$ {
        include snippets/fastcgi-php.conf;
        fastcgi_pass unix:${sock};
    }
    location ~ /\\.ht { deny all; }
}
`;
}

// ── OPERACIONES SOBRE NGINX ───────────────────────────────────

// Recarga Nginx para que aplique los cambios sin cortar el servicio.
async function reload() {
  await runSafe('systemctl', ['reload', 'nginx']);
}

// Activa un sitio de forma SEGURA:
//   1) escribe el fichero de configuración,
//   2) crea el enlace simbólico que lo activa,
//   3) ejecuta `nginx -t` para validar la sintaxis,
//   4) si la validación falla, DESHACE el enlace y lanza un error
//      (así nunca dejamos Nginx en un estado roto),
//   5) si todo va bien, recarga Nginx.
//  - name:    nombre del fichero (ej. "ejemplo.com" o "txpl-docker-app").
//  - content: el texto del vhost (lo que devuelven los generadores).
async function enableSite(name, content) {
  const confPath = path.join(NGINX_AVAILABLE, name);
  const linkPath = path.join(NGINX_ENABLED, name);

  fs.writeFileSync(confPath, content);
  try {
    fs.symlinkSync(confPath, linkPath);
  } catch (e) {
    // EEXIST = el enlace ya existía; cualquier otro error sí es un problema.
    if (e.code !== 'EEXIST') throw e;
  }

  const test = await runSafe('nginx', ['-t']);
  if (!test.ok) {
    // Quitamos el enlace para no dejar activa una config inválida.
    fs.rmSync(linkPath, { force: true });
    const detail = test.stderr.split('\n').find((l) => /error|emerg/i.test(l))
      || test.stderr.split('\n')[0] || 'config inválida';
    throw new Error('Config nginx inválida: ' + detail);
  }
  await reload();
}

// Desactiva y borra un sitio: elimina el enlace y el fichero de config.
// Solo recarga si realmente había algo que quitar.
async function removeSite(name) {
  const linkPath = path.join(NGINX_ENABLED, name);
  const confPath = path.join(NGINX_AVAILABLE, name);
  let removed = false;
  try {
    if (fs.existsSync(linkPath)) { fs.rmSync(linkPath, { force: true }); removed = true; }
  } catch (_) {}
  try { fs.rmSync(confPath, { force: true }); } catch (_) {}
  if (removed) await reload();
}

// Instala un certificado HTTPS gratuito (Let's Encrypt) con Certbot y
// fuerza la redirección de HTTP a HTTPS.
//  - opts.www: si true, también pide el certificado para "www.<dominio>"
//    (sitios web); para subdominios se deja en false.
// Lanza un error con el motivo si Certbot falla.
async function installSsl(domain, opts = {}) {
  const { www = true } = opts;
  const args = ['--nginx', '-d', domain];
  if (www) args.push('-d', `www.${domain}`);
  args.push('--non-interactive', '--agree-tos', '--redirect',
    '-m', process.env.SSL_EMAIL || `admin@${domain}`);
  const r = await runSafe('certbot', args);
  if (!r.ok) throw new Error(r.stderr.split('\n').slice(-3).join(' ') || 'certbot falló');
}

module.exports = {
  NGINX_AVAILABLE, NGINX_ENABLED, SITES_DIR,
  buildSite, buildProxy, buildPhpFpmSite,
  reload, enableSite, removeSite, installSsl,
};
