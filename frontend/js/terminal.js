// TecXPaneL — terminal (xterm + WebSocket + node-pty)

let term = null, fitAddon = null, termWS = null;
let termOnDataDisposer = null;           // IDisposable devuelto por term.onData
let termShouldConnect = false;           // flag para el auto-reconnect
let termBackoffMs = 2000;                // 2s → 30s
let termReconnectTimer = null;

// setTermStatus: badge visual al lado del título (Desconectado/Conectando/Conectado).
function setTermStatus(state, extra) {
  const b = document.getElementById('term-status');
  if (!b) return;
  const map = {
    off:  { text: 'Desconectado', cls: 'badge' },
    wait: { text: 'Conectando…',  cls: 'badge badge-yellow' },
    on:   { text: 'Conectado',    cls: 'badge badge-green' },
    err:  { text: 'Error',        cls: 'badge badge-red' },
  };
  const s = map[state] || map.off;
  b.textContent = extra ? `${s.text} · ${extra}` : s.text;
  b.className = s.cls;
  const c = document.getElementById('term-connect-btn');
  const d = document.getElementById('term-disconnect-btn');
  const connected = state === 'on' || state === 'wait';
  if (c) c.style.display = connected ? 'none' : '';
  if (d) d.style.display = connected ? '' : 'none';
}

function sendResize() {
  if (term && termWS && termWS.readyState === 1) {
    termWS.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  }
}
function termResizeHandler() {
  if (!fitAddon) return;
  try { fitAddon.fit(); sendResize(); } catch (_) {}
}

// termCleanup: cierra la terminal. Si userInitiated=true (botón Desconectar o
// doLogout), desactiva el auto-reconnect para no volver a levantarla sola.
function termCleanup(userInitiated) {
  if (userInitiated) termShouldConnect = false;
  if (termReconnectTimer) { clearTimeout(termReconnectTimer); termReconnectTimer = null; }
  window.removeEventListener('resize', termResizeHandler);
  if (termOnDataDisposer) { try { termOnDataDisposer.dispose(); } catch (_) {} termOnDataDisposer = null; }
  if (termWS) { try { termWS.close(); } catch (_) {} termWS = null; }
  if (term) { try { term.dispose(); } catch (_) {} term = null; fitAddon = null; }
  setTermStatus('off');
}

// Carga xterm.js bajo demanda (no en cada arranque del panel). Se inyecta la
// primera vez que se abre la Terminal; las siguientes reutilizan la promesa.
let xtermLoad = null;
function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('No se pudo cargar ' + src));
    document.head.appendChild(s);
  });
}
function ensureXterm() {
  if (window.Terminal && window.FitAddon) return Promise.resolve();
  if (!xtermLoad) {
    xtermLoad = loadScript('vendor/xterm/xterm.min.js?v=5.5.0')
      .then(() => loadScript('vendor/xterm/addon-fit.min.js?v=0.10.0'))
      .catch((e) => { xtermLoad = null; throw e; });
  }
  return xtermLoad;
}

// initTerminal: abre la terminal SSH. Antes comprueba /system/features para no
// intentar abrir el WS si node-pty no está instalado (mensaje más claro).
async function initTerminal() {
  // Cleanup ligero: destruye recursos pero NO toca termShouldConnect (antes
  // llamábamos a termCleanup(true), que lo ponía en false y provocaba una
  // carrera con el ws.onclose del anterior WebSocket → badge congelado en
  // "Desconectado" aunque la conexión nueva sí funcionase).
  if (termReconnectTimer) { clearTimeout(termReconnectTimer); termReconnectTimer = null; }
  window.removeEventListener('resize', termResizeHandler);
  if (termOnDataDisposer) { try { termOnDataDisposer.dispose(); } catch (_) {} termOnDataDisposer = null; }
  if (termWS) { try { termWS.close(); } catch (_) {} termWS = null; }
  if (term) { try { term.dispose(); } catch (_) {} term = null; fitAddon = null; }

  termShouldConnect = true;
  termBackoffMs = 2000;

  try { await ensureXterm(); } catch (_) {}
  if (!window.Terminal || !window.FitAddon) {
    toast('No se pudo cargar xterm.js', 'error');
    setTermStatus('err');
    return;
  }

  // Chequeo previo — evita el "node-pty no está instalado" con la terminal en
  // negro. Si el endpoint falla (viejo backend), no bloquea el intento.
  try {
    const f = await req('GET', '/system/features');
    if (f && f.terminal === false) {
      toast('La terminal está deshabilitada: node-pty no está instalado en el servidor.', 'error');
      setTermStatus('err', 'node-pty ausente');
      termShouldConnect = false;
      return;
    }
  } catch (_) { /* endpoint nuevo, si no está seguimos igual */ }

  openTerminalWS();
}

function openTerminalWS() {
  if (!termShouldConnect) return;
  setTermStatus('wait');

  const mount = document.getElementById('xterm-mount');
  mount.innerHTML = '';
  term = new Terminal({
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    theme: { background: '#0a0a0a', foreground: '#e0e0e0', cursor: '#e0e0e0' },
  });
  fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(mount);
  fitAddon.fit();
  term.write('\x1b[33mConectando a terminal...\x1b[0m\r\n');

  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  termWS = new WebSocket(`${wsProto}://${location.host}/ws/terminal?token=${encodeURIComponent(TOKEN)}`);
  const ws = termWS;

  // Todos los handlers comprueban `ws !== termWS`: si mientras el WS estaba
  // abriendo el usuario disparó otra conexión, esta se marca como obsoleta y
  // sus eventos NO deben mutar el estado global (badge, reconnect timer).
  ws.onmessage = (e) => {
    if (ws !== termWS) return;
    try {
      const d = JSON.parse(e.data);
      if (d.type === 'output') term.write(d.data);
    } catch (_) {}
  };

  ws.onopen = () => {
    if (ws !== termWS) return;
    setTermStatus('on');
    termBackoffMs = 2000;
    sendResize();
    // Guardar el disposer para evitar el bug del handler doble al reconectar.
    termOnDataDisposer = term.onData((data) => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data }));
    });
    window.addEventListener('resize', termResizeHandler);
    term.focus();
  };

  ws.onclose = () => {
    if (ws !== termWS) return;                  // WS obsoleto → no tocar nada
    if (term) term.write('\r\n\x1b[90mConexión cerrada.\x1b[0m\r\n');
    if (termOnDataDisposer) { try { termOnDataDisposer.dispose(); } catch (_) {} termOnDataDisposer = null; }
    if (!termShouldConnect) { setTermStatus('off'); return; }
    // Auto-reconnect con backoff: 2s → 4 → 8 → 16 → 30s
    setTermStatus('wait', `reintentando en ${Math.round(termBackoffMs / 1000)}s`);
    termReconnectTimer = setTimeout(openTerminalWS, termBackoffMs);
    termBackoffMs = Math.min(termBackoffMs * 2, 30_000);
  };

  ws.onerror = () => {
    if (ws !== termWS) return;
    if (term) term.write('\r\n\x1b[31mError de conexión.\x1b[0m\r\n');
    setTermStatus('err');
  };
}

Object.assign(window, {
  initTerminal, sendResize, termCleanup, termResizeHandler, setTermStatus,
});
