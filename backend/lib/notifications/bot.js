'use strict';

// ─────────────────────────────────────────────────────────────────
//  bot.js — Bot INTERACTIVO de Telegram (menú de consulta).
//  A diferencia del executor (solo envía alertas), este escucha
//  comandos con long-polling (getUpdates, sin webhook ni infra) y
//  responde con el estado del VPS: servicios, recursos, contenedores,
//  SSL, errores activos y conexiones.
//
//  SOLO LECTURA: nunca ejecuta acciones destructivas (reiniciar,
//  parar, borrar). Solo consulta estado. Así un Telegram comprometido
//  no puede tocar el servidor.
//
//  Autorización: solo responde al chat_id configurado en notify_config.
//  Cualquier otro chat se ignora en silencio (no ser un oráculo público).
// ─────────────────────────────────────────────────────────────────

const os = require('os');
const http = require('http');
const { queries } = require('../../database');
const { runSafe } = require('../common/run');
const { cpuPercent, memInfo } = require('../websocket');
const { parseCertbotCertificates } = require('../ssl');
const { loadConfig } = require('./executor');

const POLL_TIMEOUT = 50;              // long-poll en segundos (getUpdates)
const IDLE_MS = 30_000;              // reintento cuando no hay token/chat
const WATCHED_SERVICES = ['nginx', 'mysql', 'postgresql', 'redis', 'ssh'];
const DOCKER_SOCK = '/var/run/docker.sock';

let offset = 0;   // última update_id procesada + 1
let running = false;

// ── Helpers de formato ───────────────────────────────────────────
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(n) / Math.log(1024));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

function fmtUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return [d && `${d}d`, h && `${h}h`, `${m}m`].filter(Boolean).join(' ');
}

// GET al socket de Docker (mismo patrón mínimo que monitor.js).
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

// ── Recolectores (cada uno devuelve texto HTML listo para Telegram) ─
async function reportServices() {
  const lines = [];
  for (const name of WATCHED_SERVICES) {
    const r = await runSafe('systemctl', ['is-active', name]);
    const out = (r.stdout || '').trim();
    if (!out) continue; // no instalado / no disponible
    lines.push(`${out === 'active' ? '🟢' : '🔴'} ${esc(name)}: ${esc(out)}`);
  }
  return `<b>Servicios</b>\n${lines.join('\n') || 'Sin servicios detectados (¿entorno sin systemd?).'}`;
}

async function reportResources() {
  const [cpu, r] = await Promise.all([cpuPercent(), runSafe('df', ['-PB1', '-x', 'tmpfs', '-x', 'devtmpfs'])]);
  const mem = memInfo();
  const load = os.loadavg().map((n) => n.toFixed(2)).join(' ');
  let diskLine = 'disco: n/d';
  const root = (r.stdout || '').trim().split('\n').slice(1)
    .map((l) => l.trim().split(/\s+/)).find((c) => c[5] === '/');
  if (root) diskLine = `disco /: ${root[4]} (${fmtBytes(+root[2])} / ${fmtBytes(+root[1])})`;
  return `<b>Recursos</b>\n`
    + `🖥️ CPU: ${cpu}%   carga: ${esc(load)}\n`
    + `🧠 RAM: ${mem.percent}% (${fmtBytes(mem.used)} / ${fmtBytes(mem.total)})\n`
    + `💾 ${esc(diskLine)}\n`
    + `⏱️ uptime: ${fmtUptime(os.uptime())}`;
}

async function reportDocker() {
  const list = await dockerGet('/containers/json?all=1');
  if (!Array.isArray(list)) return '<b>Docker</b>\nNo disponible (Docker no instalado o socket inaccesible).';
  if (!list.length) return '<b>Docker</b>\nSin contenedores.';
  const lines = list.map((c) => {
    const name = (c.Names?.[0] || '').replace(/^\//, '');
    return `${c.State === 'running' ? '🟢' : '⚪'} ${esc(name)}: ${esc(c.State)}`;
  });
  const up = list.filter((c) => c.State === 'running').length;
  return `<b>Docker</b> (${up}/${list.length} activos)\n${lines.join('\n')}`;
}

async function reportSsl() {
  const r = await runSafe('certbot', ['certificates']);
  if (!r.ok) return '<b>SSL</b>\nCertbot no disponible o sin certificados.';
  const certs = parseCertbotCertificates(r.stdout || '');
  if (!certs.length) return '<b>SSL</b>\nSin certificados.';
  const lines = certs.map((c) => {
    const days = c.valid ? c.daysLeft : 0;
    const icon = !c.valid ? '🔴' : days <= 7 ? '🟠' : '🟢';
    return `${icon} ${esc(c.name)}: ${c.valid ? `${days} días` : 'INVÁLIDO/CADUCADO'}`;
  });
  return `<b>Certificados SSL</b>\n${lines.join('\n')}`;
}

// "¿Hubo error en algo?" — recursos en fallo (notify_state) + últimas
// acciones de auditoría marcadas como fallo.
function reportErrors() {
  const down = queries.listNotifyDown.all();
  const lines = down.map((d) => `🔴 ${esc(d.key)}${d.since ? ` (desde ${esc(d.since.replace('T', ' ').slice(0, 16))})` : ''}`);
  const head = lines.length
    ? `<b>Errores activos</b>\n${lines.join('\n')}`
    : '<b>Errores activos</b>\n✅ Todo correcto, sin fallos vigilados.';
  const recent = queries.getAuditLog.all()
    .filter((a) => /fail|error|denied|\.ko$/i.test(a.action)).slice(0, 5)
    .map((a) => `• ${esc(a.action)} — ${esc((a.detail || '').slice(0, 60))}`);
  return recent.length ? `${head}\n\n<b>Auditoría reciente (fallos)</b>\n${recent.join('\n')}` : head;
}

async function reportConnections() {
  const [est, who, listen] = await Promise.all([
    runSafe('ss', ['-tnH', 'state', 'established']),
    runSafe('who', []),
    runSafe('ss', ['-tlnH']),
  ]);
  const estCount = (est.stdout || '').trim() ? est.stdout.trim().split('\n').length : 0;
  const listenCount = (listen.stdout || '').trim() ? listen.stdout.trim().split('\n').length : 0;
  const sessions = (who.stdout || '').trim().split('\n').filter(Boolean)
    .map((l) => { const c = l.split(/\s+/); return `👤 ${esc(c[0])} (${esc(c[1] || '')}) desde ${esc((c[c.length - 1] || '').replace(/[()]/g, ''))}`; });
  return `<b>Conexiones</b>\n`
    + `🔌 TCP establecidas: ${estCount}\n`
    + `👂 puertos a la escucha: ${listenCount}\n`
    + (sessions.length ? `\n<b>Sesiones SSH/TTY</b>\n${sessions.join('\n')}` : '\nSin sesiones interactivas.');
}

async function reportSummary() {
  const [svc, resr] = await Promise.all([reportServices(), reportResources()]);
  return `📊 <b>Resumen — ${esc(os.hostname())}</b>\n\n${resr}\n\n${svc}`;
}

// ── Menú y despacho de acciones ──────────────────────────────────
const MENU_KEYBOARD = {
  inline_keyboard: [
    [{ text: '📊 Resumen', callback_data: 'resumen' }, { text: '⚙️ Servicios', callback_data: 'servicios' }],
    [{ text: '🖥️ Recursos', callback_data: 'recursos' }, { text: '🐳 Docker', callback_data: 'docker' }],
    [{ text: '🔒 SSL', callback_data: 'ssl' }, { text: '🔌 Conexiones', callback_data: 'conexiones' }],
    [{ text: '🚨 Errores', callback_data: 'errores' }, { text: '🔄 Menú', callback_data: 'menu' }],
  ],
};

const ACTIONS = {
  resumen: reportSummary,
  servicios: reportServices,
  estado: reportServices,
  recursos: reportResources,
  docker: reportDocker,
  ssl: reportSsl,
  conexiones: reportConnections,
  errores: async () => reportErrors(),
};

function menuText() {
  return `🤖 <b>TecXPaneL — ${esc(os.hostname())}</b>\n`
    + 'Elige qué quieres consultar, o usa comandos:\n'
    + '/resumen /servicios /recursos /docker /ssl /conexiones /errores';
}

// Resuelve un texto de comando o callback a la clave de acción.
function resolveAction(raw) {
  const cmd = String(raw || '').trim().toLowerCase().replace(/^\//, '').split(/[@\s]/)[0];
  if (!cmd || cmd === 'start' || cmd === 'menu' || cmd === 'ayuda' || cmd === 'help') return 'menu';
  return ACTIONS[cmd] ? cmd : 'menu';
}

// ── Telegram API ─────────────────────────────────────────────────
async function tgCall(token, method, body) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout((POLL_TIMEOUT + 10) * 1000),
    });
    return await res.json().catch(() => ({}));
  } catch (e) {
    console.error(`[bot] ${method}:`, e.message);
    return null;
  }
}

function sendMenu(token, chatId, text) {
  return tgCall(token, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', reply_markup: MENU_KEYBOARD });
}

// Procesa una update (mensaje o pulsación de botón) ya autorizada.
async function handle(token, chatId, action, callbackId) {
  if (callbackId) await tgCall(token, 'answerCallbackQuery', { callback_query_id: callbackId });
  if (action === 'menu') { await sendMenu(token, chatId, menuText()); return; }
  let text;
  try { text = await ACTIONS[action](); }
  catch (e) { text = `⚠️ Error al consultar: ${esc(e.message)}`; }
  await sendMenu(token, chatId, text); // el teclado va siempre, para encadenar consultas
}

// ── Bucle principal ──────────────────────────────────────────────
async function loop() {
  while (running) {
    const cfg = loadConfig();
    if (!cfg || !cfg.telegram_enabled || !cfg.telegram_token || !cfg.telegram_chat_id) {
      await new Promise((r) => setTimeout(r, IDLE_MS)); // sin bot: espera y reintenta
      continue;
    }
    const token = cfg.telegram_token;
    const authorized = String(cfg.telegram_chat_id);

    const data = await tgCall(token, 'getUpdates', {
      offset, timeout: POLL_TIMEOUT, allowed_updates: ['message', 'callback_query'],
    });
    if (!data || !data.ok) { await new Promise((r) => setTimeout(r, 5000)); continue; }

    for (const u of data.result || []) {
      offset = u.update_id + 1;
      const msg = u.message || u.callback_query?.message;
      const fromChat = msg?.chat?.id;
      if (fromChat == null || String(fromChat) !== authorized) continue; // ignora ajenos
      const raw = u.callback_query ? u.callback_query.data : u.message?.text;
      if (raw == null) continue;
      await handle(token, fromChat, resolveAction(raw), u.callback_query?.id);
    }
  }
}

// Arranca el bot en segundo plano. No lanza: si algo peta, se reintenta.
function startBot() {
  if (running) return;
  running = true;
  loop().catch((e) => { console.error('[bot] loop:', e.message); running = false; });
  console.log('[txpl] Bot de Telegram interactivo activo (long-polling)');
}

module.exports = { startBot, resolveAction, reportErrors, menuText };
