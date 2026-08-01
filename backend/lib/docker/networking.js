'use strict';

// ============================================================
//  TecXPaneL — lib/docker/networking.js
//
//  Configura nginx (proxy) + UFW (firewall) + SSL para un
//  contenedor desplegado, según los parámetros opcionales
//  (dominio, puerto host, SSL). Extraído de routes/docker.js
//  v1 (función applyDockerNetworking).
// ============================================================

const nginx = require('../nginx');
const { runSafe } = require('../common/run');
const { dockerConfName } = require('./socket');

async function applyDockerNetworking(log, { proxyDomain, hostPort, wantSsl }) {
  if (hostPort) {
    await runSafe('ufw', ['allow', `${hostPort}/tcp`]);
    log(`✓ Puerto ${hostPort} abierto en el firewall (UFW).\n`);
  }
  if (proxyDomain && hostPort) {
    try {
      await nginx.enableSite(dockerConfName(proxyDomain), nginx.buildProxy(proxyDomain, hostPort, { www: false }));
      log(`✓ Proxy Nginx configurado: ${proxyDomain} → puerto ${hostPort}.\n`);
    } catch (e) {
      log(`⚠ El proxy del dominio falló: ${e.message}\n`);
    }
    if (wantSsl) {
      try {
        await nginx.installSsl(proxyDomain, { www: false });
        log('✓ HTTPS (SSL) instalado.\n');
      } catch (e) {
        log(`⚠ HTTPS no se pudo instalar automáticamente: ${e.message}\n`);
      }
    }
  }
}

module.exports = { applyDockerNetworking };