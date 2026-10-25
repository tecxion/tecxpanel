// TecXPaneL — terminal (xterm + WebSocket + node-pty) con pestañas persistentes.
// Cada pestaña = una sesión de shell en el servidor: sobrevive a cambiar de sección
// y a recargar (el servidor guarda el historial y se reengancha por id de sesión).

const TABS_KEY = 'txpl_term_tabs';
let tabs = [];            // { k, id, name, term, fit, pane, ws, status, backoff, timer, closed, noRetry, busyCb }
let activeK = null, tabSeq = 0, nameSeq = 0, xtermLoad = null, termRO = null, initing = false;

const activeTab = () => tabs.find((t) => t.k === activeK);

function saveTabs() {
  try {
    localStorage.setItem(TABS_KEY, JSON.stringify({
      active: tabs.findIndex((t) => t.k === activeK),
      tabs: tabs.map((t) => ({ id: t.id, name: t.name })),
    }));
  } catch (_) {}
}
function loadSavedTabs() {
  try { const s = JSON.parse(localStorage.getItem(TABS_KEY)); return Array.isArray(s?.tabs) && s.tabs.length ? s : null; }
  catch (_) { return null; }
}

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
}
function setTabStatus(t, state, extra) {
  t.status = [state, extra];
  if (t.k === activeK) setTermStatus(state, extra);
}

function renderTabs() {
  const el = document.getElementById('term-tabs');
  if (!el) return;
  el.innerHTML = tabs.map((t) =>
    `<div class="term-tab${t.k === activeK ? ' active' : ''}" onclick="termSelect(${t.k})">` +
    `<i class="ti ti-terminal-2"></i><span>${t.name}</span>` +
    `<button class="term-tab-x" title="Cerrar terminal" onclick="event.stopPropagation();termCloseTab(${t.k})"><i class="ti ti-x"></i></button></div>`
  ).join('') +
    '<button class="term-tab-add" title="Nueva terminal" onclick="termNewTab()"><i class="ti ti-plus"></i></button>';
}

function sendResize(t) {
  t = t || activeTab();
  if (t && t.ws && t.ws.readyState === 1) t.ws.send(JSON.stringify({ type: 'resize', cols: t.term.cols, rows: t.term.rows }));
}
function refit(t) {
  if (!t || !t.pane.offsetWidth) return;      // pestaña/página oculta: no hay tamaño que medir
  try { t.fit.fit(); sendResize(t); } catch (_) {}
}

function termSelect(k) {
  activeK = k;
  tabs.forEach((t) => { t.pane.style.display = t.k === k ? '' : 'none'; });
  renderTabs();
  saveTabs();
  const t = activeTab();
  if (!t) return;
  setTermStatus(...t.status);
  requestAnimationFrame(() => { refit(t); t.term.focus(); });
}

function connectTab(t) {
  clearTimeout(t.timer);
  setTabStatus(t, 'wait');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/terminal?token=${encodeURIComponent(TOKEN)}${t.id ? '&session=' + encodeURIComponent(t.id) : ''}`);
  t.ws = ws;
  // Todos los handlers comprueban `ws !== t.ws`: un WS obsoleto no debe tocar el estado.
  ws.onmessage = (e) => {
    if (ws !== t.ws) return;
    let d; try { d = JSON.parse(e.data); } catch (_) { return; }
    if (d.type === 'session') { t.id = d.id; t.term.reset(); saveTabs(); }   // el servidor repinta el historial a continuación
    else if (d.type === 'output') t.term.write(d.data);
    else if (d.type === 'busy') t.busyCb?.(d.busy);
    else if (d.type === 'replaced') t.noRetry = true;
    else if (d.type === 'exit') destroyTab(t, false);                          // el usuario hizo `exit`
  };
  ws.onopen = () => {
    if (ws !== t.ws) return;
    t.backoff = 2000;
    setTabStatus(t, 'on');
    sendResize(t);
  };
  ws.onclose = () => {
    if (ws !== t.ws) return;
    if (t.noRetry) { t.term.write('\r\n\x1b[90mSesión abierta en otra ventana.\x1b[0m\r\n'); setTabStatus(t, 'off'); return; }
    // Auto-reconnect con backoff: 2s → 4 → 8 → 16 → 30s
    setTabStatus(t, 'wait', `reintentando en ${Math.round(t.backoff / 1000)}s`);
    t.timer = setTimeout(() => connectTab(t), t.backoff);
    t.backoff = Math.min(t.backoff * 2, 30_000);
  };
  ws.onerror = () => { if (ws === t.ws) setTabStatus(t, 'err'); };
}

function addTab(saved) {
  const pane = document.createElement('div');
  pane.className = 'term-pane';
  document.getElementById('xterm-mount').appendChild(pane);
  const term = new Terminal({
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 13,
    cursorBlink: true,
    scrollback: 5000,
    theme: { background: '#0a0a0a', foreground: '#e0e0e0', cursor: '#e0e0e0' },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  const t = { k: ++tabSeq, id: saved?.id || null, name: saved?.name || 'Terminal ' + (++nameSeq),
              term, fit, pane, ws: null, status: ['off'], backoff: 2000 };
  term.onData((data) => { if (t.ws && t.ws.readyState === 1) t.ws.send(JSON.stringify({ type: 'input', data })); });
  tabs.push(t);
  termSelect(t.k);          // muestra el panel ANTES de abrir xterm para que mida bien
  term.open(pane);
  connectTab(t);
  return t;
}

function termNewTab() { if (window.Terminal) addTab(); }

function isBusy(t) {
  if (!t.ws || t.ws.readyState !== 1) return Promise.resolve(false);
  return new Promise((res) => {
    const to = setTimeout(() => { t.busyCb = null; res(false); }, 1000);
    t.busyCb = (b) => { clearTimeout(to); t.busyCb = null; res(b); };
    t.ws.send(JSON.stringify({ type: 'busy' }));
  });
}

// destroyTab: quita la pestaña. kill=true además mata la shell en el servidor.
function destroyTab(t, kill) {
  clearTimeout(t.timer);
  const ws = t.ws; t.ws = null;
  if (ws) { try { if (kill && ws.readyState === 1) ws.send(JSON.stringify({ type: 'kill' })); ws.close(); } catch (_) {} }
  try { t.term.dispose(); } catch (_) {}
  t.pane.remove();
  const i = tabs.indexOf(t);
  if (i < 0) return;
  tabs.splice(i, 1);
  if (!tabs.length) addTab();                                  // nunca dejamos el panel sin terminal
  else if (activeK === t.k) termSelect(tabs[Math.min(i, tabs.length - 1)].k);
  else { renderTabs(); saveTabs(); }
}

async function termCloseTab(k) {
  const t = tabs.find((x) => x.k === k);
  if (!t) return;
  if (await isBusy(t) && !confirm(`Hay un proceso en ejecución en «${t.name}». ¿Cerrar la terminal y terminarlo?`)) return;
  destroyTab(t, true);
}

// termCleanup: solo para logout. Cierra WebSockets y pantallas SIN matar las shells
// del servidor (se recuperan al volver a entrar).
function termCleanup() {
  tabs.forEach((t) => {
    clearTimeout(t.timer);
    const ws = t.ws; t.ws = null;
    try { ws?.close(); } catch (_) {}
    try { t.term.dispose(); } catch (_) {}
    t.pane.remove();
  });
  tabs = []; activeK = null;
  setTermStatus('off');
}

// Carga xterm.js bajo demanda (no en cada arranque del panel).
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

// initTerminal: se llama cada vez que se entra en la sección. Si ya hay pestañas
// vivas solo las reenfoca; si no, restaura las guardadas (o abre una nueva).
async function initTerminal() {
  if (tabs.length) { termSelect(activeK); return; }
  if (initing) return;
  initing = true;
  try {
    try { await ensureXterm(); } catch (_) {}
    if (!window.Terminal || !window.FitAddon) {
      toast('No se pudo cargar xterm.js', 'error');
      setTermStatus('err');
      return;
    }
    // Chequeo previo — evita abrir la terminal en negro si node-pty no está instalado.
    try {
      const f = await req('GET', '/system/features');
      if (f && f.terminal === false) {
        toast('La terminal está deshabilitada: node-pty no está instalado en el servidor.', 'error');
        setTermStatus('err', 'node-pty ausente');
        return;
      }
    } catch (_) { /* endpoint nuevo, si no está seguimos igual */ }

    if (!termRO) {
      termRO = new ResizeObserver(() => refit(activeTab()));
      termRO.observe(document.getElementById('xterm-mount'));
    }
    const saved = loadSavedTabs();
    if (saved) {
      nameSeq = Math.max(0, ...saved.tabs.map((s) => parseInt(String(s.name).replace(/\D/g, ''), 10) || 0));
      saved.tabs.forEach((s) => addTab(s));
      if (tabs[saved.active]) termSelect(tabs[saved.active].k);
    } else addTab();
  } finally { initing = false; }
}

Object.assign(window, {
  initTerminal, sendResize, termCleanup, setTermStatus, termSelect, termNewTab, termCloseTab,
});
