'use strict';

// ============================================================
//  TecXPaneL — WebSockets (tiempo real)
//
//  Un WebSocket es una conexión que permanece ABIERTA entre el
//  navegador y el servidor, para enviar datos en ambos sentidos
//  al instante (a diferencia de una petición HTTP normal, que es
//  pregunta-respuesta y se cierra).
//
//  Aquí montamos dos:
//   - /ws/stats:    el servidor empuja CPU/RAM/red cada 2 segundos.
//   - /ws/terminal: una consola interactiva real en el navegador.
// ============================================================

const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { audit } = require('../database');

// Lee una muestra del uso de CPU desde /proc/stat (solo Linux).
// Devuelve el tiempo "inactivo" y el "total" acumulados por el sistema.
function readCpuSample() {
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
    const p = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = p[3] + (p[4] || 0);
    const total = p.reduce((a, b) => a + b, 0);
    return { idle, total };
  } catch (_) { return null; }
}

// Calcula el % de CPU usado: toma dos muestras separadas 200 ms y mira cuánto
// del tiempo transcurrido NO estuvo inactivo. (El uso de CPU siempre se mide
// comparando dos instantes, no se puede saber con una sola lectura.)
async function cpuPercent() {
  const a = readCpuSample();
  if (!a) return 0;
  await new Promise((r) => setTimeout(r, 200));
  const b = readCpuSample();
  if (!b) return 0;
  const dTotal = b.total - a.total;
  const dIdle = b.idle - a.idle;
  if (dTotal <= 0) return 0;
  return Math.round((1 - dIdle / dTotal) * 100);
}

// Información de memoria RAM: total, usada, libre y porcentaje usado.
function memInfo() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  return { total, used, free, percent: Math.round((used / total) * 100) };
}

// Lee bytes recibidos (rx) y enviados (tx) de todas las interfaces de red
// (menos "lo", la interfaz local). Se compara entre muestras para sacar la velocidad.
function readNetSample() {
  try {
    const lines = fs.readFileSync('/proc/net/dev', 'utf8').split('\n').slice(2);
    let rx = 0, tx = 0;
    for (const l of lines) {
      const [iface, rest] = l.split(':');
      if (!rest || iface.trim() === 'lo') continue;
      const cols = rest.trim().split(/\s+/).map(Number);
      rx += cols[0]; tx += cols[8];
    }
    return { rx, tx, t: Date.now() };
  } catch (_) { return null; }
}

// IP del cliente del WebSocket (igual que en helpers, pero para conexiones WS).
function clientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() || req.connection?.remoteAddress || '';
}

// Configura los dos WebSockets sobre el servidor HTTP ya existente.
//  - verifyToken: función que valida el token JWT (viene de las rutas de auth).
function setupWebSockets(server, verifyToken) {
  // "noServer: true" = no creamos un servidor aparte; nos enganchamos al HTTP
  // existente y decidimos a mano qué hacer en cada conexión entrante (upgrade).
  const wssStats = new WebSocketServer({ noServer: true });
  const wssTerm = new WebSocketServer({ noServer: true });

  // Cuando un navegador pide "subir" (upgrade) una conexión a WebSocket:
  server.on('upgrade', (req, socket, head) => {
    const { pathname, searchParams } = new URL(req.url, 'http://localhost');
    // El token va en la query (?token=...) porque los WS no usan cabeceras Authorization fácilmente.
    const token = searchParams.get('token');
    const payload = token && verifyToken(token);
    if (!payload) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    req.user = payload;

    // Según la ruta, enviamos la conexión a uno u otro WebSocket.
    if (pathname === '/ws/stats') {
      wssStats.handleUpgrade(req, socket, head, (ws) => wssStats.emit('connection', ws, req));
    } else if (pathname === '/ws/terminal') {
      wssTerm.handleUpgrade(req, socket, head, (ws) => wssTerm.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });

  // ── WebSocket de estadísticas: empuja datos cada 2 s ────────
  wssStats.on('connection', (ws) => {
    let prevNet = readNetSample();
    let alive = true;
    ws.on('close', () => { alive = false; });

    // "tick" se llama a sí mismo cada 2 s mientras la conexión siga viva.
    const tick = async () => {
      if (!alive || ws.readyState !== ws.OPEN) return;
      const cpu = await cpuPercent();
      const net = readNetSample();
      let rx = 0, tx = 0;
      // Velocidad de red = (bytes ahora - bytes antes) / segundos transcurridos.
      if (prevNet && net) {
        const dt = (net.t - prevNet.t) / 1000 || 1;
        rx = Math.max(0, Math.round((net.rx - prevNet.rx) / dt));
        tx = Math.max(0, Math.round((net.tx - prevNet.tx) / dt));
      }
      prevNet = net;
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type: 'stats', cpu, memory: memInfo(), network: { rx, tx } }));
      }
      if (alive) setTimeout(tick, 2000);
    };
    tick();
  });

  // ── WebSocket de terminal: shell interactivo ────────────────
  // Requiere node-pty (un "pseudo-terminal"). Es opcional: si no está instalado,
  // la terminal queda deshabilitada pero el resto del panel funciona.
  let pty = null;
  try { pty = require('node-pty'); } catch (_) { console.warn('[ws] node-pty no instalado: la terminal estará deshabilitada.'); }

  wssTerm.on('connection', (ws, req) => {
    if (!pty) {
      ws.send(JSON.stringify({ type: 'output', data: 'node-pty no está instalado en el servidor.\r\n' }));
      ws.close();
      return;
    }
    audit(req.user.username, clientIp(req), 'terminal.open', null);
    // Lanzamos una shell real (bash) y la conectamos al WebSocket.
    const shell = pty.spawn(process.env.SHELL || 'bash', [], {
      name: 'xterm-color', cols: 80, rows: 24, cwd: process.env.HOME || '/root', env: process.env,
    });
    // Lo que escupe la shell → se envía al navegador.
    shell.onData((data) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'output', data })); });
    // Lo que llega del navegador → se escribe en la shell (o se redimensiona).
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'input' && typeof msg.data === 'string') shell.write(msg.data);
        else if (msg.type === 'resize' && msg.cols && msg.rows) shell.resize(msg.cols, msg.rows);
      } catch (_) {}
    });
    // Al cerrar la pestaña/conexión, matamos la shell para no dejar procesos colgados.
    ws.on('close', () => shell.kill());
  });

  return { wssStats, wssTerm, cpuPercent, memInfo, readNetSample };
}

module.exports = { setupWebSockets, cpuPercent, memInfo, readNetSample };
