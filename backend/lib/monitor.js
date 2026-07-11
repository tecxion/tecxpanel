'use strict';

// ─────────────────────────────────────────────────────────────────
//  monitor.js — El vigilante de notificaciones.
//  Cada 60 s comprueba disco, servicios systemd y contenedores
//  txpl-*, pasa los estados por la lógica pura de transiciones
//  (applyTick) y despacha los eventos por el executor.
//  Corre dentro del proceso del panel (PM2 lo mantiene vivo);
//  el tick de stats del WebSocket NO sirve porque solo corre con
//  el dashboard abierto.
// ─────────────────────────────────────────────────────────────────

const os = require('os');
const http = require('http');
const { queries } = require('../database');
const { runSafe } = require('./helpers');
const { applyTick, resourceKey, buildStatusEvent } = require('./notifications');
const { dispatch } = require('./notifyExecutor');

const TICK_MS = 60_000;
const WATCHED_SERVICES = ['nginx', 'mysql', 'postgresql', 'redis', 'ssh'];
const DOCKER_SOCK = '/var/run/docker.sock';

let busy = false; // guard anti-solapamiento: nunca dos ticks a la vez

// GET al socket de Docker (mismo patrón mínimo que docker.js / n8n.js).
// Devuelve null en cualquier error (Docker no instalado, socket caído…).
function dockerGet(path) {
  return new Promise((resolve) => {
    const req = http.request({ socketPath: DOCKER_SOCK, path, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (_) { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(5000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// % de uso de la partición raíz (mismo df que routes/system.js).
// Devuelve [] si df no está disponible (Windows/dev) o no hay raíz.
async function checkDisk(threshold) {
  const r = await runSafe('df', ['-PB1', '-x', 'tmpfs', '-x', 'devtmpfs']);
  const out = (r.stdout || '').trim();
  if (!r.ok || !out) return [];
  const root = out.split('\n').slice(1)
    .map((l) => l.trim().split(/\s+/))
    .find((c) => c[5] === '/');
  if (!root) return [];
  const percent = parseInt(root[4], 10);
  if (!Number.isInteger(percent)) return [];
  return [{
    key: resourceKey.disk(),
    status: percent >= threshold ? 'down' : 'ok',
    detail: `Uso: ${percent}% (umbral ${threshold}%)`,
  }];
}

// Servicios systemd de la lista del dashboard. Si systemctl no existe
// (Windows/dev) o no devuelve nada, se omite ese servicio sin romper.
// Nota: un servicio nunca instalado se adopta como 'down' en silencio
// (primer avistamiento sin notificar) y no vuelve a molestar.
async function checkServices() {
  const result = [];
  for (const name of WATCHED_SERVICES) {
    const r = await runSafe('systemctl', ['is-active', name]);
    const out = (r.stdout || '').trim();
    if (!out) continue;
    result.push({
      key: resourceKey.service(name),
      status: out === 'active' ? 'ok' : 'down',
      detail: null,
    });
  }
  return result;
}

// Contenedores gestionados por el panel (txpl-*): n8n, mail…
async function checkContainers() {
  const list = await dockerGet('/containers/json?all=1');
  if (!Array.isArray(list)) return [];
  const result = [];
  for (const c of list) {
    const name = (c.Names?.[0] || '').replace(/^\//, '');
    if (!name.startsWith('txpl-')) continue;
    result.push({
      key: resourceKey.container(name),
      status: c.State === 'running' ? 'ok' : 'down',
      detail: null,
    });
  }
  return result;
}

// Un tick completo: recoger → transicionar → despachar → persistir.
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const cfg = queries.getNotifyConfig.get();
    if (!cfg || (!cfg.telegram_enabled && !cfg.smtp_enabled)) return; // coste cero sin config
    const hostname = os.hostname();
    const now = new Date().toISOString();

    const checks = [];
    if (cfg.ev_disk_enabled) checks.push(...await checkDisk(cfg.ev_disk_threshold));
    if (cfg.ev_services_enabled) {
      checks.push(...await checkServices());
      checks.push(...await checkContainers());
    }

    for (const c of checks) {
      const prev = queries.getNotifyState.get(c.key) || null;
      const { next, event } = applyTick(prev, c.status, now);
      let notified = next.notified;
      if (event) {
        const ev = buildStatusEvent({ key: c.key, event, hostname, since: next.since, detail: c.detail });
        notified = (await dispatch(ev)) ? 1 : 0; // si nadie entrega, se reintenta al tick siguiente
      }
      queries.upsertNotifyState.run({
        key: c.key,
        status: next.status,
        pending_status: next.pending_status,
        pending_count: next.pending_count,
        since: next.since,
        notified,
      });
    }
  } catch (e) {
    console.error('[monitor]', e.message);
  } finally {
    busy = false;
  }
}

// Arranca el vigilante. unref(): el interval no impide el apagado limpio.
function startMonitor() {
  setInterval(tick, TICK_MS).unref();
  console.log('[txpl] Monitor de notificaciones activo (cada 60 s)');
}

module.exports = { startMonitor, tick };
