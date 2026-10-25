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
const path = require('path');
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

  // Sesiones persistentes: la shell sobrevive al WebSocket (cambio de sección, recarga)
  // y guarda la salida reciente para repintarla al reenganchar la pestaña.
  const sessions = new Map();            // id → { shell, sh, user, buf, ws, timer }
  const BUF_MAX = 200_000;               // caracteres de historial que se reenvían al reconectar
  const MAX_SESSIONS = 10;               // por usuario
  const DETACHED_TTL = 24 * 3600 * 1000; // shell sin pestaña conectada → se mata a las 24 h
  const send = (ws, msg) => { if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };

  function killSession(id) {
    const s = sessions.get(id);
    if (!s) return;
    clearTimeout(s.timer);
    sessions.delete(id);
    try { s.shell.kill(); } catch (_) {}
  }

  wssTerm.on('connection', (ws, req) => {
    if (!pty) {
      send(ws, { type: 'output', data: 'node-pty no está instalado en el servidor.\r\n' });
      ws.close();
      return;
    }
    const user = req.user.username;
    const wanted = new URL(req.url, 'http://localhost').searchParams.get('session');
    let id = wanted;
    let s = sessions.get(wanted);
    if (s && s.user !== user) s = null;            // sesión de otro usuario: se ignora

    if (!s) {
      if ([...sessions.values()].filter((x) => x.user === user).length >= MAX_SESSIONS) {
        send(ws, { type: 'output', data: `Límite de ${MAX_SESSIONS} terminales abiertas. Cierra alguna pestaña.\r\n` });
        ws.close();
        return;
      }
      audit(user, clientIp(req), 'terminal.open', null);
      // Env de la shell: WHITELIST mínima. NO pasar process.env entero — leakearía
      // JWT_SECRET, TXPL_SECRET_KEY, ADMIN_PASS, credenciales de git guardadas
      // en el env del panel al hacer `env` en el shell.
      const parentEnv = process.env;
      const safeEnv = {
        PATH:    parentEnv.PATH  || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        HOME:    parentEnv.HOME  || '/root',
        USER:    parentEnv.USER  || 'root',
        LOGNAME: parentEnv.LOGNAME || parentEnv.USER || 'root',
        SHELL:   parentEnv.SHELL || '/bin/bash',
        LANG:    parentEnv.LANG  || 'C.UTF-8',
        TERM:    'xterm-256color',
        PWD:     parentEnv.HOME  || '/root',
      };
      // Preserva locales LC_* si están puestas (no son secretos y afectan a la UX).
      for (const k of Object.keys(parentEnv)) if (k.startsWith('LC_')) safeEnv[k] = parentEnv[k];

      // pty.spawn puede lanzar (binding nativo incompatible, shell inexistente…).
      // Como este handler corre dentro del emit('connection') del upgrade, una
      // excepción sin capturar tumbaría TODO el proceso del panel: la aislamos.
      let shell;
      try {
        shell = pty.spawn(safeEnv.SHELL, ['-l'], {
          name: 'xterm-256color', cols: 80, rows: 24, cwd: safeEnv.HOME, env: safeEnv,
        });
      } catch (e) {
        send(ws, { type: 'output', data: 'No se pudo iniciar la terminal: ' + e.message + '\r\n' });
        ws.close();
        return;
      }
      id = crypto.randomUUID();
      s = { shell, sh: path.basename(safeEnv.SHELL), user, buf: '', ws: null, timer: null };
      const mine = s;
      shell.onData((data) => {
        mine.buf = (mine.buf + data).slice(-BUF_MAX);
        send(mine.ws, { type: 'output', data });
      });
      shell.onExit(() => {
        clearTimeout(mine.timer);
        if (sessions.get(id) === mine) sessions.delete(id);
        send(mine.ws, { type: 'exit' });           // el cliente cierra la pestaña
        try { mine.ws?.close(); } catch (_) {}
      });
      sessions.set(id, s);
    }

    clearTimeout(s.timer);
    if (s.ws && s.ws !== ws) {                     // otra ventana toma la sesión
      send(s.ws, { type: 'replaced' });
      try { s.ws.close(); } catch (_) {}
    }
    s.ws = ws;
    send(ws, { type: 'session', id });             // el cliente limpia su pantalla…
    if (s.buf) send(ws, { type: 'output', data: s.buf }); // …y recibe el historial

    const sid = id, cur = s;
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'input' && typeof msg.data === 'string') cur.shell.write(msg.data);
        else if (msg.type === 'resize' && msg.cols && msg.rows) cur.shell.resize(msg.cols, msg.rows);
        else if (msg.type === 'busy') send(ws, { type: 'busy', busy: cur.shell.process !== cur.sh });
        else if (msg.type === 'kill') killSession(sid);
      } catch (_) {}
    });
    // Al cerrar el WebSocket NO se mata la shell (así sobrevive a recargas); solo se
    // programa su limpieza por si nadie vuelve.
    ws.on('close', () => {
      if (cur.ws !== ws) return;
      cur.ws = null;
      cur.timer = setTimeout(() => killSession(sid), DETACHED_TTL);
    });
  });

  return { wssStats, wssTerm, cpuPercent, memInfo, readNetSample };
}

module.exports = { setupWebSockets, cpuPercent, memInfo, readNetSample };
