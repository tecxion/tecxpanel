'use strict';

const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const { audit } = require('../database');

function readCpuSample() {
  try {
    const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
    const p = line.trim().split(/\s+/).slice(1).map(Number);
    const idle = p[3] + (p[4] || 0);
    const total = p.reduce((a, b) => a + b, 0);
    return { idle, total };
  } catch (_) { return null; }
}

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

function memInfo() {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  return { total, used, free, percent: Math.round((used / total) * 100) };
}

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

function clientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() || req.connection?.remoteAddress || '';
}

function setupWebSockets(server, verifyToken) {
  const wssStats = new WebSocketServer({ noServer: true });
  const wssTerm = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const { pathname, searchParams } = new URL(req.url, 'http://localhost');
    const token = searchParams.get('token');
    const payload = token && verifyToken(token);
    if (!payload) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    req.user = payload;

    if (pathname === '/ws/stats') {
      wssStats.handleUpgrade(req, socket, head, (ws) => wssStats.emit('connection', ws, req));
    } else if (pathname === '/ws/terminal') {
      wssTerm.handleUpgrade(req, socket, head, (ws) => wssTerm.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });

  // Stats push
  wssStats.on('connection', (ws) => {
    let prevNet = readNetSample();
    let alive = true;
    ws.on('close', () => { alive = false; });

    const tick = async () => {
      if (!alive || ws.readyState !== ws.OPEN) return;
      const cpu = await cpuPercent();
      const net = readNetSample();
      let rx = 0, tx = 0;
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

  // Terminal (requires node-pty)
  let pty = null;
  try { pty = require('node-pty'); } catch (_) { console.warn('[ws] node-pty no instalado: la terminal estará deshabilitada.'); }

  wssTerm.on('connection', (ws, req) => {
    if (!pty) {
      ws.send(JSON.stringify({ type: 'output', data: 'node-pty no está instalado en el servidor.\r\n' }));
      ws.close();
      return;
    }
    audit(req.user.username, clientIp(req), 'terminal.open', null);
    const shell = pty.spawn(process.env.SHELL || 'bash', [], {
      name: 'xterm-color', cols: 80, rows: 24, cwd: process.env.HOME || '/root', env: process.env,
    });
    shell.onData((data) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'output', data })); });
    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'input' && typeof msg.data === 'string') shell.write(msg.data);
        else if (msg.type === 'resize' && msg.cols && msg.rows) shell.resize(msg.cols, msg.rows);
      } catch (_) {}
    });
    ws.on('close', () => shell.kill());
  });

  return { wssStats, wssTerm, cpuPercent, memInfo, readNetSample };
}

module.exports = { setupWebSockets, cpuPercent, memInfo, readNetSample };
