'use strict';

// ============================================================
//  TecXPaneL — DNS (PowerDNS autoritativo)
//  Instala PowerDNS nativo (apt) con backend SQLite y API HTTP.
//  El panel gestiona zonas/registros por la API por loopback; la
//  api-key se guarda cifrada. PowerDNS bindea a la IP pública.
// ============================================================

const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const express = require('express');
const { ok, fail, clientIp, runSafe, wrap } = require('../lib/helpers');
const { queries, audit } = require('../database');
const { encryptSecret, decryptSecret } = require('../lib/crypto');
const D = require('../lib/dns');

const router = express.Router();
const PDNS_CONF = '/etc/powerdns/pdns.d/txpl.conf';
const PDNS_DB = '/var/lib/powerdns/pdns.sqlite3';
const PDNS_API = { host: '127.0.0.1', port: 8081 };

// Cliente HTTP a la API de PowerDNS por loopback. path relativo a
// /api/v1/servers/localhost. Devuelve { statusCode, json }.
function pdnsApi(method, path, apiKey, body = null) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      host: PDNS_API.host, port: PDNS_API.port, method,
      path: '/api/v1/servers/localhost' + path,
      headers: { 'X-API-Key': apiKey, 'Accept': 'application/json' },
    };
    if (data) options.headers['Content-Type'] = 'application/json';
    const rq = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const txt = Buffer.concat(chunks).toString();
        let json = null; try { json = txt ? JSON.parse(txt) : null; } catch (_) { json = txt; }
        resolve({ statusCode: res.statusCode, json });
      });
    });
    rq.on('error', reject);
    if (data) rq.write(data);
    rq.end();
  });
}

// Config conectada con la api-key descifrada, o lanza si no está lista.
function getConnectedConfig() {
  const cfg = queries.getDnsConfig.get();
  if (!cfg || !cfg.api_key_enc) { const e = new Error('DNS no está instalado.'); e.http = 400; throw e; }
  return { apiKey: decryptSecret(cfg.api_key_enc), ns1: cfg.ns1, ns2: cfg.ns2, server_ip: cfg.server_ip, cfg };
}

// Ejecuta un comando transmitiendo su salida al cliente; resuelve con el código.
function streamRun(cmd, args, write) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, { env: { ...process.env, DEBIAN_FRONTEND: 'noninteractive' } }); }
    catch (e) { write('[error] ' + e.message + '\n'); return resolve(1); }
    child.stdout.on('data', (d) => write(d));
    child.stderr.on('data', (d) => write(d));
    child.on('error', (e) => { write('[error] ' + e.message + '\n'); resolve(1); });
    child.on('close', (code) => resolve(code === null ? 1 : code));
  });
}

// Contenido de la config de PowerDNS. serverIp: IP pública a la que bindear.
function pdnsConfContent(apiKey, serverIp) {
  return [
    'launch=gsqlite3',
    `gsqlite3-database=${PDNS_DB}`,
    'api=yes',
    `api-key=${apiKey}`,
    'webserver=yes',
    'webserver-address=127.0.0.1',
    'webserver-port=8081',
    'webserver-allow-from=127.0.0.1',
    `local-address=${serverIp}`,
    '',
  ].join('\n');
}

function startStream(res) {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
}

// Detecta la IP pública del servidor (para local-address y glue).
async function detectServerIp() {
  const r = await runSafe('bash', ['-c', "curl -s https://api.ipify.org || hostname -I | awk '{print $1}'"]);
  return (r.stdout || '').trim();
}

function computeState(cfg, installed) {
  if (!installed) return 'not_installed';
  if (!cfg || !cfg.ns1 || !cfg.ns2) return 'needs_config';
  return 'ready';
}

// ¿Está PowerDNS instalado? (dpkg del paquete).
async function pdnsInstalled() {
  const r = await runSafe('dpkg', ['-s', 'pdns-server']);
  return r.ok;
}

// ── Estado ───────────────────────────────────────────────────
router.get('/status', wrap(async (req, res) => {
  const installed = await pdnsInstalled();
  const cfg = queries.getDnsConfig.get();
  ok(res, {
    installed,
    state: computeState(cfg, installed),
    ns1: (cfg && cfg.ns1) || null,
    ns2: (cfg && cfg.ns2) || null,
    server_ip: (cfg && cfg.server_ip) || null,
  });
}));

// ── Instalar (streaming) ─────────────────────────────────────
router.post('/install', wrap(async (req, res) => {
  if (await pdnsInstalled()) return fail(res, 409, 'PowerDNS ya está instalado.');
  audit(req.user?.username || 'system', clientIp(req), 'dns.install', 'powerdns');
  startStream(res);
  const done = (code) => res.end(`\n__TXPL_DONE__${code}`);
  try {
    const apiKey = crypto.randomBytes(32).toString('hex');
    res.write('🌐 Detectando la IP pública del servidor...\n');
    const serverIp = await detectServerIp();
    if (!D.isValidIpv4(serverIp)) { res.write('[error] No se pudo detectar una IPv4 pública.\n'); return done(1); }
    res.write(`   IP: ${serverIp}\n`);

    res.write('📥 Instalando PowerDNS (apt)...\n');
    const aptCode = await streamRun('apt-get', ['install', '-y', 'pdns-server', 'pdns-backend-sqlite3'], (t) => res.write(t));
    if (aptCode !== 0) { res.write('[error] Falló la instalación por apt.\n'); return done(1); }

    res.write('🗄️  Inicializando la base de datos de zonas...\n');
    // Script FIJO (sin datos de usuario): crea el dir, localiza el esquema del
    // paquete e inicializa la DB SQLite si está vacía.
    const initScript = [
      'set -e',
      'mkdir -p /var/lib/powerdns',
      `if [ ! -s ${PDNS_DB} ]; then`,
      "  SCHEMA=$(find /usr/share -name 'schema.sqlite3.sql' 2>/dev/null | head -1)",
      `  [ -n "$SCHEMA" ] && sqlite3 ${PDNS_DB} < "$SCHEMA"`,
      'fi',
      `chown -R pdns:pdns /var/lib/powerdns || true`,
    ].join('\n');
    const initR = await runSafe('bash', ['-c', initScript]);
    if (!initR.ok || !fs.existsSync(PDNS_DB)) { res.write('[error] No se pudo inicializar el esquema: ' + (initR.stderr || '').slice(0, 200) + '\n'); return done(1); }

    res.write('⚙️  Escribiendo la configuración...\n');
    fs.mkdirSync('/etc/powerdns/pdns.d', { recursive: true });
    fs.writeFileSync(PDNS_CONF, pdnsConfContent(apiKey, serverIp));

    res.write('🔥 Abriendo el puerto 53 en el firewall...\n');
    await runSafe('ufw', ['allow', '53/tcp']);
    await runSafe('ufw', ['allow', '53/udp']);

    res.write('▶️  Arrancando PowerDNS...\n');
    const restart = await runSafe('systemctl', ['restart', 'pdns']);
    if (!restart.ok) { res.write('[error] No arrancó el servicio: ' + (restart.stderr || '').slice(0, 200) + '\n'); return done(1); }
    await runSafe('systemctl', ['enable', 'pdns']);

    queries.saveDnsConfig.run({ api_key_enc: encryptSecret(apiKey), ns1: null, ns2: null, server_ip: serverIp, status: 'needs_config' });
    res.write('✅ PowerDNS instalado. Configura tus nameservers (ns1/ns2).\n');
    done(0);
  } catch (e) {
    res.write('[error] ' + e.message + '\n');
    done(1);
  }
}));

// ── Configurar nameservers ───────────────────────────────────
router.post('/config', wrap(async (req, res) => {
  const ns1 = String((req.body && req.body.ns1) || '').trim().toLowerCase();
  const ns2 = String((req.body && req.body.ns2) || '').trim().toLowerCase();
  const serverIp = String((req.body && req.body.server_ip) || '').trim();
  if (!D.isValidDnsDomain(ns1) || !D.isValidDnsDomain(ns2)) return fail(res, 400, 'Nameservers inválidos (ej. ns1.tudominio.com).');
  if (!D.isValidIpv4(serverIp)) return fail(res, 400, 'IP del servidor inválida.');
  const prev = queries.getDnsConfig.get();
  if (!prev || !prev.api_key_enc) return fail(res, 400, 'Instala PowerDNS primero.');

  // Si cambia la IP, reescribir local-address y reiniciar.
  if (prev.server_ip !== serverIp) {
    fs.writeFileSync(PDNS_CONF, pdnsConfContent(decryptSecret(prev.api_key_enc), serverIp));
    await runSafe('systemctl', ['restart', 'pdns']);
  }
  queries.saveDnsConfig.run({ api_key_enc: prev.api_key_enc, ns1, ns2, server_ip: serverIp, status: 'ready' });
  audit(req.user?.username || 'system', clientIp(req), 'dns.config', `${ns1}, ${ns2}`);
  ok(res, { ns1, ns2, server_ip: serverIp });
}));

// Valida que :zone sea un dominio y devuelve su forma canónica para la API.
function zoneId(param) {
  const z = String(param || '').trim().toLowerCase().replace(/\.$/, '');
  if (!D.isValidDnsDomain(z)) { const e = new Error('Zona inválida.'); e.http = 400; throw e; }
  return { z, id: encodeURIComponent(D.canonical(z)) };
}

// ── Zonas ────────────────────────────────────────────────────
router.get('/zones', wrap(async (req, res) => {
  const { apiKey } = getConnectedConfig();
  const r = await pdnsApi('GET', '/zones', apiKey);
  if (r.statusCode >= 400) return fail(res, 502, 'PowerDNS: ' + JSON.stringify(r.json));
  ok(res, { zones: D.parseZones(r.json) });
}));

router.post('/zones', wrap(async (req, res) => {
  const { apiKey, ns1, ns2 } = getConnectedConfig();
  if (!ns1 || !ns2) return fail(res, 400, 'Configura los nameservers primero.');
  const domain = String((req.body && req.body.domain) || '').trim().toLowerCase();
  if (!D.isValidDnsDomain(domain)) return fail(res, 400, 'Dominio inválido.');
  const r = await pdnsApi('POST', '/zones', apiKey, D.buildZonePayload({ domain, ns1, ns2 }));
  if (r.statusCode >= 400) return fail(res, 502, 'PowerDNS: ' + JSON.stringify(r.json));
  audit(req.user?.username || 'system', clientIp(req), 'dns.zone.add', domain);
  ok(res);
}));

router.delete('/zones/:zone', wrap(async (req, res) => {
  const { apiKey } = getConnectedConfig();
  const { z, id } = zoneId(req.params.zone);
  const r = await pdnsApi('DELETE', `/zones/${id}`, apiKey);
  if (r.statusCode >= 400) return fail(res, 502, 'PowerDNS: ' + JSON.stringify(r.json));
  audit(req.user?.username || 'system', clientIp(req), 'dns.zone.del', z);
  ok(res);
}));

// ── Registros ────────────────────────────────────────────────
router.get('/zones/:zone/records', wrap(async (req, res) => {
  const { apiKey } = getConnectedConfig();
  const { id } = zoneId(req.params.zone);
  const r = await pdnsApi('GET', `/zones/${id}`, apiKey);
  if (r.statusCode >= 400) return fail(res, 502, 'PowerDNS: ' + JSON.stringify(r.json));
  ok(res, { records: D.parseRecords(r.json) });
}));

router.post('/zones/:zone/records', wrap(async (req, res) => {
  const { apiKey } = getConnectedConfig();
  const { z, id } = zoneId(req.params.zone);
  const { name, type, value, ttl = 3600, priority = 10 } = req.body || {};
  if (!D.SUPPORTED_TYPES.includes(type)) return fail(res, 400, 'Tipo de registro no soportado.');
  if (!D.isValidDnsDomain(String(name || '').replace(/\.$/, ''))) return fail(res, 400, 'Nombre de registro inválido.');
  if (!D.isValidRecord(type, value)) return fail(res, 400, 'Valor de registro inválido para el tipo ' + type + '.');
  if (type === 'MX' && !D.isValidPriority(+priority)) return fail(res, 400, 'Prioridad MX inválida (0-65535).');
  const content = D.buildRecordContent(type, value, +priority);
  const patch = D.buildRrsetPatch({ name, type, contents: [content], ttl: +ttl || 3600, changetype: 'REPLACE' });
  const r = await pdnsApi('PATCH', `/zones/${id}`, apiKey, patch);
  if (r.statusCode >= 400) return fail(res, 502, 'PowerDNS: ' + JSON.stringify(r.json));
  audit(req.user?.username || 'system', clientIp(req), 'dns.record.add', `${z}: ${type} ${name}`);
  ok(res);
}));

router.delete('/zones/:zone/records', wrap(async (req, res) => {
  const { apiKey } = getConnectedConfig();
  const { z, id } = zoneId(req.params.zone);
  const { name, type } = req.body || {};
  if (!D.SUPPORTED_TYPES.includes(type)) return fail(res, 400, 'Tipo de registro no soportado.');
  if (!D.isValidDnsDomain(String(name || '').replace(/\.$/, ''))) return fail(res, 400, 'Nombre de registro inválido.');
  const patch = D.buildRrsetPatch({ name, type, contents: [], ttl: 3600, changetype: 'DELETE' });
  const r = await pdnsApi('PATCH', `/zones/${id}`, apiKey, patch);
  if (r.statusCode >= 400) return fail(res, 502, 'PowerDNS: ' + JSON.stringify(r.json));
  audit(req.user?.username || 'system', clientIp(req), 'dns.record.del', `${z}: ${type} ${name}`);
  ok(res);
}));

// ── Delegación (glue + verificación por DNS público) ─────────
router.get('/zones/:zone/delegation', wrap(async (req, res) => {
  const { ns1, ns2, server_ip } = getConnectedConfig();
  const { z } = zoneId(req.params.zone);
  const glue = D.buildGlueRecords({ ns1, ns2, serverIp: server_ip });
  // Consulta el DNS público para ver a qué NS está delegado el dominio.
  const dig = await runSafe('dig', ['+short', 'NS', z]);
  const nsFound = (dig.stdout || '').split('\n').map((s) => s.trim().replace(/\.$/, '')).filter(Boolean);
  const delegated = nsFound.includes(ns1) && nsFound.includes(ns2);
  ok(res, { glue, delegated, ns_found: nsFound });
}));

module.exports = router;
