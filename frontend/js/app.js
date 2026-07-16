// ── Settings ──────────────────────────────────────────────────
// loadSettings: carga la página de Ajustes (datos de cuenta y recuperación).
async function loadSettings() {
  const me = await req('GET', '/auth/me');
  if (!me) return;
  const rows = [
    { label: 'Usuario', value: me.username },
    { label: 'Rol', value: me.role || 'admin' },
  ];
  document.getElementById('settings-account').innerHTML = rows.map(r => `
    <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)">
      <span style="color:var(--text-muted)">${esc(r.label)}</span>
      <span style="font-weight:600">${esc(r.value)}</span>
    </div>`).join('');

  // Precargar los datos de recuperación actuales (email + pregunta)
  const rec = await req('GET', '/auth/recovery');
  if (rec) {
    document.getElementById('set-rec-email').value = rec.email || '';
    document.getElementById('set-rec-question').value = rec.question || '';
  }

  loadNotifyConfig();
}

// saveRecovery: guarda los datos de recuperación (email, pregunta y, opcional,
// nueva respuesta), pidiendo la contraseña actual para confirmar.
async function saveRecovery() {
  const email = document.getElementById('set-rec-email').value.trim();
  const question = document.getElementById('set-rec-question').value.trim();
  const answer = document.getElementById('set-rec-answer').value;
  const password = document.getElementById('set-rec-pass').value;
  if (!email || !question) { toast('El email y la pregunta son obligatorios', 'error'); return; }
  if (!password) { toast('Introduce tu contraseña actual para confirmar', 'error'); return; }
  const r = await req('POST', '/auth/recovery', { password, email, question, answer });
  if (r?.success) {
    toast('Datos de recuperación actualizados', 'success');
    document.getElementById('set-rec-answer').value = '';
    document.getElementById('set-rec-pass').value = '';
  } else toast(r?.error || 'Error al guardar la recuperación', 'error');
}

// changePassword: cambia la contraseña del usuario (pide la actual + la nueva x2).
async function changePassword() {
  const oldPass = document.getElementById('set-pass-old').value;
  const newPass = document.getElementById('set-pass-new').value;
  const newPass2 = document.getElementById('set-pass-new2').value;
  if (!newPass || newPass.length < 8) { toast('La nueva contraseña debe tener al menos 8 caracteres', 'error'); return; }
  if (newPass !== newPass2) { toast('Las contraseñas no coinciden', 'error'); return; }
  const r = await req('POST', '/auth/password', { oldPassword: oldPass, newPassword: newPass });
  if (r?.success) {
    toast('Contraseña actualizada', 'success');
    ['set-pass-old','set-pass-new','set-pass-new2'].forEach(id => document.getElementById(id).value = '');
  } else toast(r?.error || 'Error al cambiar la contraseña', 'error');
}

// ── Notificaciones (Ajustes) ─────────────────────────────────────

// loadNotifyConfig: rellena la tarjeta con la config guardada (sin secretos).
async function loadNotifyConfig() {
  const r = await req('GET', '/notifications/config');
  if (!r?.success || r.configured === false) return;
  document.getElementById('ntf-tg-enabled').checked = !!r.telegram_enabled;
  document.getElementById('ntf-tg-token').placeholder = r.telegram_token_set ? '•••••••• (guardado, escribe para cambiarlo)' : '123456:ABC…';
  document.getElementById('ntf-tg-chat').value = r.telegram_chat_id || '';
  document.getElementById('ntf-smtp-enabled').checked = !!r.smtp_enabled;
  document.getElementById('ntf-smtp-host').value = r.smtp_host || '';
  document.getElementById('ntf-smtp-port').value = r.smtp_port || 587;
  document.getElementById('ntf-smtp-secure').checked = !!r.smtp_secure;
  document.getElementById('ntf-smtp-user').value = r.smtp_user || '';
  document.getElementById('ntf-smtp-pass').placeholder = r.smtp_pass_set ? '•••••••• (guardada, escribe para cambiarla)' : '';
  document.getElementById('ntf-smtp-from').value = r.smtp_from || '';
  document.getElementById('ntf-smtp-to').value = r.smtp_to || '';
  document.getElementById('ntf-ev-disk').checked = !!r.ev_disk_enabled;
  document.getElementById('ntf-ev-disk-th').value = r.ev_disk_threshold || 90;
  document.getElementById('ntf-ev-services').checked = !!r.ev_services_enabled;
  document.getElementById('ntf-ev-security').checked = !!r.ev_security_enabled;
  document.getElementById('ntf-ev-ssl').checked = !!r.ev_ssl_enabled;
}

// collectNotifyForm: lee la tarjeta entera (token/contraseña vacíos = conservar).
function collectNotifyForm() {
  return {
    telegram_enabled: document.getElementById('ntf-tg-enabled').checked,
    telegram_token: document.getElementById('ntf-tg-token').value.trim(),
    telegram_chat_id: document.getElementById('ntf-tg-chat').value.trim(),
    smtp_enabled: document.getElementById('ntf-smtp-enabled').checked,
    smtp_host: document.getElementById('ntf-smtp-host').value.trim(),
    smtp_port: parseInt(document.getElementById('ntf-smtp-port').value, 10) || 587,
    smtp_secure: document.getElementById('ntf-smtp-secure').checked,
    smtp_user: document.getElementById('ntf-smtp-user').value.trim(),
    smtp_pass: document.getElementById('ntf-smtp-pass').value,
    smtp_from: document.getElementById('ntf-smtp-from').value.trim(),
    smtp_to: document.getElementById('ntf-smtp-to').value.trim(),
    ev_disk_enabled: document.getElementById('ntf-ev-disk').checked,
    ev_disk_threshold: parseInt(document.getElementById('ntf-ev-disk-th').value, 10) || 90,
    ev_services_enabled: document.getElementById('ntf-ev-services').checked,
    ev_security_enabled: document.getElementById('ntf-ev-security').checked,
    ev_ssl_enabled: document.getElementById('ntf-ev-ssl').checked,
  };
}

// syncSmtpPort: al marcar/desmarcar "TLS directa", ajusta el puerto al estándar
// que le corresponde (465 con TLS directo, 587 con STARTTLS). Respeta un puerto
// personalizado: solo autoajusta si el actual es uno de los dos estándar o está vacío.
function syncSmtpPort() {
  const secure = document.getElementById('ntf-smtp-secure').checked;
  const portEl = document.getElementById('ntf-smtp-port');
  const cur = parseInt(portEl.value, 10);
  if (!cur || cur === 587 || cur === 465) portEl.value = secure ? 465 : 587;
}

// saveNotifyConfig: guarda y limpia los campos de secretos.
async function saveNotifyConfig() {
  const r = await req('POST', '/notifications/config', collectNotifyForm());
  if (r?.success) {
    toast('Notificaciones guardadas', 'success');
    document.getElementById('ntf-tg-token').value = '';
    document.getElementById('ntf-smtp-pass').value = '';
    loadNotifyConfig();
  } else toast(r?.error || 'Error al guardar las notificaciones', 'error');
}

// testNotify: prueba de envío con lo que hay en el formulario (sin guardar).
async function testNotify(channel) {
  toast('Enviando prueba…', 'info');
  const r = await req('POST', `/notifications/test/${channel}`, collectNotifyForm());
  if (r?.success) toast('Prueba enviada, revisa ' + (channel === 'telegram' ? 'Telegram' : 'tu correo'), 'success');
  else toast(r?.error || 'La prueba falló', 'error');
}

// detectTgChat: autodetecta el chat_id (requiere /start previo en el bot).
async function detectTgChat() {
  const r = await req('POST', '/notifications/telegram/detect-chat', collectNotifyForm());
  if (r?.success && r.chatId) {
    document.getElementById('ntf-tg-chat').value = r.chatId;
    toast('Chat detectado' + (r.name ? ': ' + r.name : ''), 'success');
  } else toast(r?.error || 'No se pudo detectar el chat', 'error');
}

// ── Logs ──────────────────────────────────────────────────────
// Estado de la página de logs: fuente actual, texto crudo y temporizador
// del modo "en vivo" (se para al salir de la página, ver navigate()).
let logsSrc = { type: 'static', key: 'nginx_access' };
let logsRaw = '';
let logsTimer = null;

// loadLogsPage: entra en la página — carga fuentes dinámicas (apps y sitios)
// y muestra la fuente actual sin esperar clics (arregla el "no carga al entrar").
async function loadLogsPage() {
  const s = await req('GET', '/logs/sources');
  if (s) {
    const appSel = document.getElementById('logs-app-select');
    appSel.innerHTML = '<option value="">Apps (PM2)…</option>' +
      (s.apps || []).map(a => `<option value="${a.id}">${esc(a.name)}${a.status !== 'running' ? ' (parada)' : ''}</option>`).join('');
    const siteSel = document.getElementById('logs-site-select');
    siteSel.innerHTML = '<option value="">Sitios web…</option>' +
      (s.sites || []).map(w => `<option value="${esc(w.domain)}">${esc(w.domain)}${w.hasOwnLog ? '' : ' (log global)'}</option>`).join('');
  }
  logsApplySelection();
  logsFetch();
}

// logsSelect: clic en una pestaña estática (nginx/sistema/auditoría).
function logsSelect(el) {
  const src = el.dataset.src;
  logsSrc = src === 'audit' ? { type: 'audit' } : { type: 'static', key: src.split(':')[1] };
  logsApplySelection(el);
  logsFetch();
}

// logsSelectApp / logsSelectSite: fuentes dinámicas de los desplegables.
function logsSelectApp() {
  const id = document.getElementById('logs-app-select').value;
  if (!id) return;
  logsSrc = { type: 'app', id };
  logsApplySelection();
  logsFetch();
}
function logsSelectSite(keepKind) {
  const domain = document.getElementById('logs-site-select').value;
  if (!domain) { document.getElementById('logs-site-kind').style.display = 'none'; return; }
  const kindSel = document.getElementById('logs-site-kind');
  kindSel.style.display = '';
  logsSrc = { type: 'site', domain, kind: kindSel.value };
  logsApplySelection();
  logsFetch();
}

// logsApplySelection: sincroniza pestañas y desplegables con logsSrc.
function logsApplySelection(activeTab) {
  document.querySelectorAll('#logs-tabs .tab').forEach(t => t.classList.remove('active'));
  if (activeTab) activeTab.classList.add('active');
  else if (logsSrc.type === 'static' || logsSrc.type === 'audit') {
    const key = logsSrc.type === 'audit' ? 'audit' : `static:${logsSrc.key}`;
    document.querySelector(`#logs-tabs .tab[data-src="${key}"]`)?.classList.add('active');
  }
  if (logsSrc.type !== 'app') document.getElementById('logs-app-select').value = '';
  if (logsSrc.type !== 'site') {
    document.getElementById('logs-site-select').value = '';
    document.getElementById('logs-site-kind').style.display = 'none';
  }
}

// logsFetch: pide la fuente actual al backend y repinta.
async function logsFetch() {
  const lines = document.getElementById('logs-lines')?.value || '300';
  let r;
  if (logsSrc.type === 'audit') {
    const rows = await req('GET', '/logs/audit/list');
    logsRaw = Array.isArray(rows)
      ? rows.map(a => `[${a.ts}] ${a.user}@${a.ip} — ${a.action}${a.detail ? ' · ' + a.detail : ''}`).join('\n')
      : 'Auditoría no disponible';
  } else if (logsSrc.type === 'app') {
    r = await req('GET', `/apps/${logsSrc.id}/logs`);
    logsRaw = r?.logs || 'Sin logs';
  } else if (logsSrc.type === 'site') {
    r = await req('GET', `/logs/site/${encodeURIComponent(logsSrc.domain)}?kind=${logsSrc.kind}&lines=${lines}`);
    logsRaw = r?.logs || r?.error || 'Log no disponible';
  } else {
    r = await req('GET', `/logs/${logsSrc.key}?lines=${lines}`);
    logsRaw = r?.logs || 'Log no disponible';
  }
  logsRender();
}

// logsRender: aplica el filtro y colorea errores/avisos. El texto se escapa
// SIEMPRE con esc() antes de insertar HTML.
function logsRender() {
  const out = document.getElementById('log-output');
  if (!out) return;
  const filter = (document.getElementById('logs-filter')?.value || '').toLowerCase();
  const lines = logsRaw.split('\n').filter(l => !filter || l.toLowerCase().includes(filter));
  out.innerHTML = lines.map(l => {
    const e = esc(l);
    if (/error|crit|alert|emerg|denied|fail/i.test(l)) return `<span style="color:var(--red)">${e}</span>`;
    if (/warn/i.test(l)) return `<span style="color:var(--yellow, #d7a53f)">${e}</span>`;
    return e;
  }).join('\n');
  out.scrollTop = out.scrollHeight;
}

// logsLiveToggle: refresco automático cada 4 s mientras está activado.
function logsLiveToggle() {
  const on = document.getElementById('logs-live')?.checked;
  if (logsTimer) { clearInterval(logsTimer); logsTimer = null; }
  if (on) logsTimer = setInterval(logsFetch, 4000);
}
// logsLiveStop: se llama al salir de la página (desde navigate()).
function logsLiveStop() {
  if (logsTimer) { clearInterval(logsTimer); logsTimer = null; }
  const live = document.getElementById('logs-live');
  if (live) live.checked = false;
}

// logsDownload: descarga el texto mostrado como fichero .log.
function logsDownload() {
  const name = logsSrc.type === 'static' ? logsSrc.key
    : logsSrc.type === 'site' ? `${logsSrc.domain}.${logsSrc.kind}`
    : logsSrc.type === 'app' ? `app-${logsSrc.id}` : 'auditoria';
  const blob = new Blob([logsRaw], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name}.log`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── Terminal (xterm.js) ──────────────────────────────────────
let term = null, fitAddon = null, termWS = null;

// sendResize: informa al servidor del nuevo tamaño de la terminal (filas/columnas).
function sendResize() {
  if (term && termWS && termWS.readyState === 1) {
    termWS.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  }
}
// termResizeHandler: reajusta la terminal cuando cambia el tamaño de la ventana.
function termResizeHandler() {
  if (!fitAddon) return;
  try { fitAddon.fit(); sendResize(); } catch (_) {}
}
// termCleanup: cierra la terminal y libera sus recursos al salir de la página.
function termCleanup() {
  window.removeEventListener('resize', termResizeHandler);
  if (termWS) { try { termWS.close(); } catch (_) {} termWS = null; }
  if (term) { try { term.dispose(); } catch (_) {} term = null; fitAddon = null; }
}

// initTerminal: abre la terminal SSH del navegador (xterm.js + WebSocket /ws/terminal).
function initTerminal() {
  termCleanup();
  if (!window.Terminal || !window.FitAddon) { toast('No se pudo cargar xterm.js (¿sin conexión al CDN?)', 'error'); return; }

  const mount = document.getElementById('xterm-mount');
  mount.innerHTML = '';
  term = new Terminal({
    fontFamily: "'JetBrains Mono', monospace",
    fontSize: 13,
    cursorBlink: true,
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

  ws.onmessage = (e) => {
    try {
      const d = JSON.parse(e.data);
      if (d.type === 'output') term.write(d.data);
    } catch (_) {}
  };

  ws.onopen = () => {
    sendResize();
    term.onData(data => { if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data })); });
    window.addEventListener('resize', termResizeHandler);
    term.focus();
  };

  ws.onclose = () => { if (term) term.write('\r\n\x1b[90mConexión cerrada.\x1b[0m\r\n'); };
  ws.onerror = () => { if (term) term.write('\r\n\x1b[31mError de conexión. Verifica node-pty en el servidor.\x1b[0m\r\n'); };
}

// ── Plugins ──────────────────────────────────────────────────
// loadPlugins: lista los plugins del servidor (Docker, Redis...) y si están instalados.
async function loadPlugins() {
  const data = await req('GET', '/plugins');
  if (!data) return;
  const grid = document.getElementById('plugins-grid');
  const icons = { 'brand-docker':'#2496ED', 'database-cog':'#F89820', 'database-heart':'#DC382D', 'shield-lock':'#4CAF50', 'package':'#F28D1A', 'certificate':'#0E9E6E' };
  grid.innerHTML = data.map(p => `
    <div style="background:var(--bg-card2);border:1px solid var(--border);border-radius:var(--radius);padding:1rem;display:flex;flex-direction:column;gap:0.5rem">
      <div style="display:flex;align-items:center;gap:10px">
        <i class="ti ti-${esc(p.icon)}" style="font-size:24px;color:${icons[p.icon]||'var(--accent)'}"></i>
        <div>
          <div style="font-weight:600;font-size:14px">${esc(p.name)}</div>
          <div style="font-size:11px;color:var(--text-muted)">${esc(p.category)}</div>
        </div>
        <span class="badge ${p.installed ? 'badge-green' : 'badge-red'}" style="margin-left:auto">${p.installed ? '● Instalado' : '○ No instalado'}</span>
      </div>
      <div style="font-size:12px;color:var(--text-secondary)">${esc(p.desc)}</div>
      <div style="margin-top:auto;display:flex;gap:6px">
        ${p.installed
          ? `<button class="btn btn-sm btn-danger" onclick="uninstallPlugin('${esc(p.id)}','${esc(p.name)}')"><i class="ti ti-trash"></i> Desinstalar</button>`
          : `<button class="btn btn-sm btn-primary" onclick="installPlugin('${esc(p.id)}','${esc(p.name)}')"><i class="ti ti-download"></i> Instalar</button>`}
      </div>
    </div>
  `).join('');
}

// installPlugin: instala un plugin (con confirmación) mostrando la salida en vivo.
function installPlugin(id, name) {
  if (!confirm(`¿Instalar ${name}? Esto puede tardar unos minutos.`)) return;
  streamPlugin(id, 'install', name);
}

// uninstallPlugin: desinstala un plugin (con confirmación).
function uninstallPlugin(id, name) {
  if (!confirm(`¿Desinstalar ${name}?`)) return;
  streamPlugin(id, 'uninstall', name);
}

// Ejecuta install/uninstall mostrando la salida en vivo en la consola de plugins.
// streamPlugin: ejecuta install/uninstall de un plugin y muestra la salida en
// directo (lee el stream y detecta el marcador __TXPL_DONE__ del final).
async function streamPlugin(id, action, name) {
  const wrap = document.getElementById('plugin-console');
  const out = document.getElementById('plugin-console-output');
  const titleEl = document.getElementById('plugin-console-title');
  const spinner = document.getElementById('plugin-console-spinner');
  const DONE = '__TXPL_DONE__';

  wrap.style.display = 'block';
  titleEl.textContent = (action === 'install' ? 'Instalando ' : 'Desinstalando ') + name;
  spinner.style.display = 'inline';
  out.textContent = '';
  wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  let exitCode = 1;
  try {
    const r = await fetch(API + `/api/plugins/${id}/${action}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${TOKEN}` },
    });
    if (r.status === 401) { doLogout(); return; }
    if (!r.body) { out.textContent = 'El navegador no soporta streaming.'; return; }

    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
      let display = buffer;
      const idx = buffer.indexOf(DONE);
      if (idx >= 0) { exitCode = parseInt(buffer.slice(idx + DONE.length).trim(), 10) || 0; display = buffer.slice(0, idx); }
      out.textContent = display;
      out.scrollTop = out.scrollHeight;
    }
  } catch (e) {
    out.textContent += '\n✖ Error de conexión: ' + (e?.message || e);
  }

  spinner.style.display = 'none';
  const success = exitCode === 0;
  out.textContent += success ? `\n✅ ${action === 'install' ? 'Instalado' : 'Desinstalado'} correctamente.\n`
    : `\n✖ Terminó con errores (código ${exitCode}).\n`;
  out.scrollTop = out.scrollHeight;
  toast(success ? `${name} ${action === 'install' ? 'instalado' : 'desinstalado'}` : `${name}: terminó con errores`, success ? 'success' : 'error');
  loadPlugins();
}

// ── n8n (Workflows) ───────────────────────────────────────────
// Carga el estado y pinta la vista adaptativa (instalar / conectar / dashboard).
// URL con la que el NAVEGADOR abre n8n: el dominio si lo hay, o la IP/host con
// el que entraste al panel + el puerto de n8n (no "localhost", que sería tu PC).
function n8nOpenBase(st) {
  return st.domain ? st.base_url : `http://${location.hostname}:${st.host_port}`;
}

async function loadN8n() {
  const body = document.getElementById('n8n-body');
  body.innerHTML = '<div class="card"><p>Cargando estado de n8n...</p></div>';
  const st = await req('GET', '/n8n/status');
  if (!st) return;

  if (!st.docker) {
    body.innerHTML = `<div class="card">
      <h3>Docker no está instalado</h3>
      <p>n8n corre en un contenedor Docker. Instala Docker primero desde la sección Plugins.</p>
      <button class="btn" onclick="navigate(document.querySelector('[data-page=plugins]'))">Ir a Plugins</button>
    </div>`;
    return;
  }

  if (st.state === 'not_installed') {
    body.innerHTML = `<div class="card">
      <h3>Instalar n8n</h3>
      <p>Se creará un contenedor con volumen persistente. El dominio y el SSL son opcionales.</p>
      <div class="form-row"><label>Puerto host</label><input id="n8n-port" type="number" value="5678"></div>
      <div class="form-row"><label>Dominio (opcional)</label><input id="n8n-domain" type="text" placeholder="n8n.midominio.com"></div>
      <div class="form-row"><label>Zona horaria</label><input id="n8n-tz" type="text" value="Europe/Madrid"></div>
      <button class="btn btn-primary" onclick="n8nInstall()">Instalar n8n</button>
    </div>`;
    return;
  }

  if (st.state === 'stopped') {
    body.innerHTML = `<div class="card">
      <h3>n8n está parado</h3>
      <button class="btn btn-primary" onclick="n8nAction('start')">Iniciar</button>
      <button class="btn btn-danger" onclick="n8nUninstall()">Desinstalar</button>
    </div>`;
    return;
  }

  if (st.state === 'needs_config') {
    const openUrl = n8nOpenBase(st);
    body.innerHTML = `<div class="card">
      <h3>Conectar con n8n</h3>
      <ol>
        <li>Abre n8n y crea tu cuenta de propietario.</li>
        <li>Ve a <strong>Settings → API</strong> y genera tu API key.</li>
        <li>Pégala aquí abajo.</li>
      </ol>
      <a class="btn" href="${esc(openUrl)}" target="_blank" rel="noopener">Abrir n8n</a>
      <div class="form-row"><label>API key</label><input id="n8n-apikey" type="password" placeholder="n8n_api_..."></div>
      <button class="btn btn-primary" onclick="n8nSaveConfig()">Conectar</button>
    </div>`;
    return;
  }

  // state === 'ready' → dashboard
  const openUrl = n8nOpenBase(st);
  body.innerHTML = `<div class="card">
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <a class="btn" href="${esc(openUrl)}" target="_blank" rel="noopener">Abrir en n8n</a>
      <button class="btn" onclick="n8nAction('restart')">Reiniciar</button>
      <button class="btn" onclick="n8nAction('stop')">Detener</button>
      <button class="btn btn-danger" onclick="n8nUninstall()">Desinstalar</button>
    </div>
  </div>
  <div class="card"><h3>Workflows</h3><div id="n8n-workflows">Cargando...</div></div>
  <div class="card"><h3>Ejecuciones recientes</h3><div id="n8n-executions">Cargando...</div></div>`;

  loadN8nWorkflows(openUrl);
  loadN8nExecutions();
}

async function loadN8nWorkflows(baseUrl) {
  const el = document.getElementById('n8n-workflows');
  const r = await req('GET', '/n8n/workflows');
  if (!r || !r.workflows) { el.textContent = 'No pude cargar los workflows.'; return; }
  if (r.workflows.length === 0) { el.textContent = 'Aún no hay workflows. Créalos en n8n.'; return; }
  const safeBase = esc(baseUrl);
  el.innerHTML = '<table><thead><tr><th>Nombre</th><th>Tags</th><th>Estado</th><th></th></tr></thead><tbody>'
    + r.workflows.map((w) => {
      const toggle = w.active
        ? `<button class="btn btn-sm" onclick="n8nToggleWorkflow('${esc(w.id)}', true)">Desactivar</button>`
        : `<button class="btn btn-sm btn-primary" onclick="n8nToggleWorkflow('${esc(w.id)}', false)">Activar</button>`;
      const editUrl = `${safeBase}/workflow/${esc(w.id)}`;
      const webhook = w.webhookPath
        ? `<br><small>webhook: <code>${safeBase}/webhook/${esc(w.webhookPath)}</code></small>` : '';
      return `<tr>
        <td>${esc(w.name)}${webhook}</td>
        <td>${w.tags.map(t => esc(t)).join(', ') || '—'}</td>
        <td>${w.active ? '<span class="badge badge-green">activo</span>' : '<span class="badge">inactivo</span>'}</td>
        <td>${toggle} <a class="btn btn-sm" href="${editUrl}" target="_blank" rel="noopener">Abrir en n8n</a></td>
      </tr>`;
    }).join('') + '</tbody></table>';
}

async function loadN8nExecutions() {
  const el = document.getElementById('n8n-executions');
  const r = await req('GET', '/n8n/executions');
  if (!r || !r.executions) { el.textContent = 'No pude cargar las ejecuciones.'; return; }
  if (r.executions.length === 0) { el.textContent = 'Sin ejecuciones todavía.'; return; }
  const icon = (s) => s === 'success' ? '✓' : (s === 'error' ? '✗' : '⏳');
  el.innerHTML = '<table><thead><tr><th>Workflow</th><th>Estado</th><th>Inicio</th></tr></thead><tbody>'
    + r.executions.map((e) => `<tr>
        <td>${esc(e.workflowName)}</td>
        <td>${icon(e.status)} ${esc(e.status)}</td>
        <td>${e.startedAt ? new Date(e.startedAt).toLocaleString() : '—'}</td>
      </tr>`).join('') + '</tbody></table>';
}

// Instalación por streaming (reutiliza el patrón de streamPlugin).
async function n8nInstall() {
  const host_port = document.getElementById('n8n-port').value;
  const domain = document.getElementById('n8n-domain').value.trim();
  const timezone = document.getElementById('n8n-tz').value.trim();
  const wrap = document.getElementById('n8n-console');
  const out = document.getElementById('n8n-console-output');
  const spinner = document.getElementById('n8n-console-spinner');
  const DONE = '__TXPL_DONE__';
  const prog = document.getElementById('n8n-progress');
  const progBar = document.getElementById('n8n-progress-bar');
  const progLabel = document.getElementById('n8n-progress-label');
  prog.style.display = 'none'; progBar.style.width = '0%'; progLabel.textContent = '0%';
  wrap.style.display = 'block'; spinner.style.display = 'inline'; out.textContent = '';
  wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  let exitCode = 1;
  try {
    const r = await fetch(API + '/api/n8n/install', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ host_port, domain, timezone }),
    });
    if (r.status === 401) { doLogout(); return; }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
      let display = buffer;
      const idx = buffer.indexOf(DONE);
      if (idx >= 0) { exitCode = parseInt(buffer.slice(idx + DONE.length).trim(), 10) || 0; display = buffer.slice(0, idx); }
      // Separar las líneas de progreso (__TXPL_PROGRESS__N) del texto de consola.
      const PROG = '__TXPL_PROGRESS__';
      let lastPct = null;
      const textLines = [];
      for (const ln of display.split('\n')) {
        if (ln.startsWith(PROG)) { const n = parseInt(ln.slice(PROG.length), 10); if (!isNaN(n)) lastPct = n; }
        else textLines.push(ln);
      }
      out.textContent = textLines.join('\n'); out.scrollTop = out.scrollHeight;
      if (lastPct !== null) {
        prog.style.display = 'block';
        progBar.style.width = lastPct + '%';
        progLabel.textContent = lastPct + '%';
      }
    }
  } catch (e) {
    out.textContent += '\n✖ Error de conexión: ' + (e?.message || e);
  }
  spinner.style.display = 'none';
  prog.style.display = 'none';
  toast(exitCode === 0 ? 'n8n instalado' : 'La instalación terminó con errores', exitCode === 0 ? 'success' : 'error');
  loadN8n();
}

async function n8nSaveConfig() {
  const api_key = document.getElementById('n8n-apikey').value.trim();
  if (!api_key) { toast('Pega tu API key de n8n', 'error'); return; }
  const r = await req('POST', '/n8n/config', { api_key });
  if (!r) return;
  if (r.error) { toast(r.error, 'error'); return; }
  toast('n8n conectado', 'success');
  loadN8n();
}

async function n8nAction(action) {
  const r = await req('POST', '/n8n/' + action);
  if (!r) return;
  if (r.error) { toast(r.error, 'error'); return; }
  toast('n8n: ' + action, 'success');
  loadN8n();
}

async function n8nToggleWorkflow(id, active) {
  const path = `/n8n/workflows/${id}/${active ? 'deactivate' : 'activate'}`;
  const r = await req('POST', path);
  if (!r) return;
  if (r.error) { toast(r.error, 'error'); return; }
  toast(active ? 'Workflow desactivado' : 'Workflow activado', 'success');
  loadN8n();
}

async function n8nUninstall() {
  if (!confirm('¿Desinstalar n8n? El contenedor se elimina. ¿Borrar también el volumen con tus datos?')) return;
  const removeVolume = confirm('Aceptar = BORRAR también los datos (volumen). Cancelar = conservar los datos.');
  const r = await req('DELETE', '/n8n?volume=' + (removeVolume ? 'true' : 'false'));
  if (!r) return;
  if (r.error) { toast(r.error, 'error'); return; }
  toast('n8n desinstalado', 'success');
  loadN8n();
}

// ── Catálogo de aplicaciones ───────────────────────────────────
// Etiquetas legibles de cada modo de despliegue soportado.
const CATALOG_MODE_LABELS = { docker: 'Docker', native: 'Nativo (PHP)', pm2: 'PM2 (Node)' };

// loadCatalog: pide GET /api/catalog y pinta una tarjeta por app (instalada o no).
async function loadCatalog() {
  const body = document.getElementById('catalog-body');
  body.innerHTML = '<div class="card"><p>Cargando catálogo...</p></div>';
  const data = await req('GET', '/catalog');
  if (!data || !data.apps) { body.innerHTML = '<div class="card"><p>No se pudo cargar el catálogo.</p></div>'; return; }

  window._catalogApps = data.apps;

  body.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1rem">`
    + data.apps.map((a) => {
      const modeBadges = a.modes.map((m) => `<span class="badge">${esc(CATALOG_MODE_LABELS[m] || m)}</span>`).join(' ');
      const dbBadge = a.db ? `<span class="badge badge-amber">${esc(String(a.db).toUpperCase())}</span>` : '';

      let statusBlock = '';
      let actionsBlock = '';
      if (a.installed) {
        const link = a.domain
          ? `<a href="https://${esc(a.domain)}" target="_blank" rel="noopener">${esc(a.domain)}</a>`
          : (a.port ? `puerto ${esc(String(a.port))}` : '—');
        statusBlock = `<p style="margin-top:8px">
          <span class="badge ${a.running ? 'badge-green' : 'badge-red'}">${a.running ? 'En marcha' : 'Parado'}</span>
          <span class="badge">${esc(CATALOG_MODE_LABELS[a.mode] || a.mode)}</span>
        </p>
        <p style="font-size:12px;color:var(--text-secondary)">${link}</p>`;

        const controls = a.mode !== 'native'
          ? `<button class="btn btn-sm" onclick="catalogAction('${esc(a.id)}','${a.running ? 'stop' : 'start'}')">${a.running ? 'Parar' : 'Iniciar'}</button>
             <button class="btn btn-sm" onclick="catalogAction('${esc(a.id)}','restart')">Reiniciar</button>`
          : '';
        actionsBlock = `<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px">
          ${controls}
          <button class="btn btn-sm btn-danger" onclick="catalogUninstallModal('${esc(a.id)}')">Desinstalar</button>
        </div>`;
      } else {
        actionsBlock = `<div style="margin-top:10px">
          <button class="btn btn-primary btn-sm" onclick="catalogInstallModal('${esc(a.id)}')">Instalar</button>
        </div>`;
      }

      return `<div class="card">
        <h3 style="display:flex;align-items:center;gap:8px;margin:0 0 8px"><i class="ti ${esc(a.icon)}" style="color:var(--accent)"></i> ${esc(a.name)}</h3>
        <p style="min-height:40px;font-size:13px;color:var(--text-secondary)">${esc(a.description)}</p>
        <p>${modeBadges} ${dbBadge}</p>
        ${statusBlock}
        ${actionsBlock}
      </div>`;
    }).join('') + `</div>`;
}

// catalogInstallModal: abre el diálogo de instalación (modo, dominio, SSL) para una app.
function catalogInstallModal(id) {
  const app = (window._catalogApps || []).find((a) => a.id === id);
  if (!app) return;

  const modes = app.modes.map((m, i) => `
    <label style="display:block;margin:4px 0;font-size:13px">
      <input type="radio" name="cat-mode" value="${esc(m)}" ${i === 0 ? 'checked' : ''}> ${esc(CATALOG_MODE_LABELS[m] || m)}
    </label>`).join('');

  const modal = document.createElement('div');
  modal.className = 'modal-overlay open';
  modal.id = 'modal-catalog-install';
  modal.dataset.dynamic = 'true';
  modal.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title"><i class="ti ${esc(app.icon)}" style="color:var(--accent)"></i> Instalar ${esc(app.name)}</div>
        <button class="btn btn-sm" onclick="closeModal('modal-catalog-install')"><i class="ti ti-x"></i></button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label>Modo de despliegue</label>
          ${modes}
        </div>
        <div class="form-group">
          <label>Dominio (opcional salvo modo nativo)</label>
          <input type="text" id="cat-domain" placeholder="app.midominio.com">
        </div>
        <div class="form-group">
          <label><input type="checkbox" id="cat-ssl"> Emitir SSL (requiere DNS apuntando aquí)</label>
        </div>
        ${app.db ? `<p style="font-size:12px;color:var(--text-muted)"><i class="ti ti-info-circle"></i> Se creará una base de datos ${esc(String(app.db).toUpperCase())} gestionada por el panel.</p>` : ''}
      </div>
      <div class="modal-footer">
        <button class="btn" onclick="closeModal('modal-catalog-install')">Cancelar</button>
        <button class="btn btn-primary" onclick="catalogInstall('${esc(app.id)}')">Instalar</button>
      </div>
    </div>
  `;
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal('modal-catalog-install'); });
  document.body.appendChild(modal);
}

// catalogInstall: lee el formulario del modal y lanza la instalación en streaming.
async function catalogInstall(id) {
  const mode = document.querySelector('input[name="cat-mode"]:checked')?.value;
  const domain = document.getElementById('cat-domain').value.trim();
  const ssl = document.getElementById('cat-ssl').checked;
  closeModal('modal-catalog-install');
  await catalogStream(`/catalog/${id}/install`, 'POST', { mode, domain, ssl }, `Instalando ${id}`);
}

// catalogAction: start/stop/restart de una app instalada (respuesta JSON simple, no streaming).
async function catalogAction(id, action) {
  const r = await req('POST', `/catalog/${id}/${action}`);
  if (!r) return;
  if (r.error) { toast(r.error, 'error'); return; }
  toast(`${id}: ${action}`, 'success');
  loadCatalog();
}

// catalogUninstallModal: confirma qué purgar (datos / BD) antes de desinstalar.
function catalogUninstallModal(id) {
  const app = (window._catalogApps || []).find((a) => a.id === id);
  if (!app) return;

  const modal = document.createElement('div');
  modal.className = 'modal-overlay open';
  modal.id = 'modal-catalog-uninstall';
  modal.dataset.dynamic = 'true';
  modal.innerHTML = `
    <div class="modal">
      <div class="modal-header">
        <div class="modal-title"><i class="ti ti-trash" style="color:var(--red)"></i> Desinstalar ${esc(app.name)}</div>
        <button class="btn btn-sm" onclick="closeModal('modal-catalog-uninstall')"><i class="ti ti-x"></i></button>
      </div>
      <div class="modal-body">
        <p>Se parará y retirará la aplicación.</p>
        <div class="form-group">
          <label><input type="checkbox" id="cat-purge-data"> Borrar también los DATOS (volumen/carpeta) — irreversible</label>
        </div>
        ${app.db ? `<div class="form-group"><label><input type="checkbox" id="cat-purge-db"> Borrar también la BASE DE DATOS — irreversible</label></div>` : ''}
      </div>
      <div class="modal-footer">
        <button class="btn" onclick="closeModal('modal-catalog-uninstall')">Cancelar</button>
        <button class="btn btn-danger" onclick="catalogUninstallGo('${esc(app.id)}')">Desinstalar</button>
      </div>
    </div>
  `;
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal('modal-catalog-uninstall'); });
  document.body.appendChild(modal);
}

// catalogUninstallGo: confirma (si hay purga) y lanza el DELETE en streaming.
async function catalogUninstallGo(id) {
  const purgeData = document.getElementById('cat-purge-data')?.checked || false;
  const purgeDbEl = document.getElementById('cat-purge-db');
  const purgeDb = purgeDbEl ? purgeDbEl.checked : false;
  if ((purgeData || purgeDb) && !confirm('¿Seguro? Los datos marcados se borrarán de forma IRREVERSIBLE.')) return;
  closeModal('modal-catalog-uninstall');
  await catalogStream(`/catalog/${id}?purgeData=${purgeData}&purgeDb=${purgeDb}`, 'DELETE', null, `Desinstalando ${id}`);
}

// catalogStream: helper de streaming reutilizable (mismo patrón que n8nInstall/streamPlugin):
// hace fetch con method/body, lee el cuerpo por chunks, separa __TXPL_PROGRESS__N del texto
// de consola y detecta el centinela final __TXPL_DONE__<code>.
async function catalogStream(apiPath, method, body, title) {
  const wrap = document.getElementById('catalog-console');
  const out = document.getElementById('catalog-console-output');
  const titleEl = document.getElementById('catalog-console-title');
  const spinner = document.getElementById('catalog-console-spinner');
  const prog = document.getElementById('catalog-progress');
  const progBar = document.getElementById('catalog-progress-bar');
  const progLabel = document.getElementById('catalog-progress-label');
  const DONE = '__TXPL_DONE__';
  const PROG = '__TXPL_PROGRESS__';

  prog.style.display = 'none'; progBar.style.width = '0%'; progLabel.textContent = '0%';
  wrap.style.display = 'block'; titleEl.textContent = title; spinner.style.display = 'inline'; out.textContent = '';
  wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  let exitCode = 1;
  try {
    const opts = { method, headers: { 'Authorization': `Bearer ${TOKEN}` } };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    const r = await fetch(API + '/api' + apiPath, opts);
    if (r.status === 401) { doLogout(); return; }
    if (!r.body) { out.textContent = 'El navegador no soporta streaming.'; return; }

    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
      let display = buffer;
      const idx = buffer.indexOf(DONE);
      if (idx >= 0) { exitCode = parseInt(buffer.slice(idx + DONE.length).trim(), 10) || 0; display = buffer.slice(0, idx); }

      let lastPct = null;
      const textLines = [];
      for (const ln of display.split('\n')) {
        if (ln.startsWith(PROG)) { const n = parseInt(ln.slice(PROG.length), 10); if (!isNaN(n)) lastPct = n; }
        else textLines.push(ln);
      }
      out.textContent = textLines.join('\n');
      out.scrollTop = out.scrollHeight;
      if (lastPct !== null) {
        prog.style.display = 'block';
        progBar.style.width = lastPct + '%';
        progLabel.textContent = lastPct + '%';
      }
    }
  } catch (e) {
    out.textContent += '\n✖ Error de conexión: ' + (e?.message || e);
  }

  spinner.style.display = 'none';
  prog.style.display = 'none';
  toast(exitCode === 0 ? 'Operación completada' : 'La operación terminó con errores', exitCode === 0 ? 'success' : 'error');
  loadCatalog();
}

// ── Copias de seguridad ───────────────────────────────────────
// loadBackups: carga la programación guardada y la lista de backups disponibles.
async function loadBackups() {
  const data = await req('GET', '/backups');
  if (!data) return;
  const s = data.schedule || {};
  document.getElementById('bk-enabled').checked = !!s.enabled;
  document.getElementById('bk-frequency').value = s.frequency || 'daily';
  document.getElementById('bk-time').value = s.time || '03:00';
  document.getElementById('bk-retention').value = s.retention_days || 7;

  const list = document.getElementById('backups-list');
  if (!data.backups.length) { list.innerHTML = '<p class="muted">Aún no hay copias de seguridad.</p>'; return; }
  list.innerHTML = '<table class="table"><thead><tr><th>Fecha</th><th>Tipo</th><th>Origen</th><th>Tamaño</th><th>Estado</th><th></th></tr></thead><tbody>' +
    data.backups.map((b) => `<tr>
      <td>${esc(b.created_at)}</td>
      <td>${esc(b.kind)}</td>
      <td>${esc(b.origin)}</td>
      <td>${fmtBytes(b.size_bytes)}</td>
      <td>${esc(b.status)}</td>
      <td>
        <button class="btn btn-sm" onclick="backupRestore(${b.id})"><i class="ti ti-restore"></i></button>
        <button class="btn btn-sm" onclick="backupUpload(${b.id})" title="Subir al remoto"><i class="ti ti-cloud-upload"></i></button>
        <button class="btn btn-sm" onclick="backupDownload(${b.id})"><i class="ti ti-download"></i></button>
        <button class="btn btn-sm btn-danger" onclick="backupDelete(${b.id})"><i class="ti ti-trash"></i></button>
      </td></tr>`).join('') + '</tbody></table>';
  loadBackupRemote();
}

// ── Destino remoto de backups (S3/SFTP) ───────────────────────
async function loadBackupRemote() {
  const r = await req('GET', '/backups/remote');
  const s = (r && r.remote) || null;
  document.getElementById('remote-summary').textContent = s
    ? `Configurado: ${s.type.toUpperCase()} → ${s.remote_path || '(raíz)'} · cifrado: ${s.encrypt_enabled ? 'sí' : 'no'} · auto-subida: ${s.auto_upload ? 'sí' : 'no'} · estado: ${s.status}`
    : 'Aún no hay destino remoto configurado.';
  if (s) {
    document.getElementById('rm-type').value = s.type;
    document.getElementById('rm-path').value = s.remote_path || '';
    document.getElementById('rm-encrypt').checked = !!s.encrypt_enabled;
    document.getElementById('rm-auto').checked = !!s.auto_upload;
    document.getElementById('rm-retention').value = s.retention_days || 30;
  }
  backupRemoteTypeChange();
  backupRemoteEncryptToggle();
}

function backupRemoteTypeChange() {
  const t = document.getElementById('rm-type').value;
  document.getElementById('rm-s3').style.display = (t === 's3') ? '' : 'none';
  document.getElementById('rm-sftp').style.display = (t === 'sftp') ? '' : 'none';
}

function backupRemoteEncryptToggle() {
  document.getElementById('rm-cryptpass').style.display = document.getElementById('rm-encrypt').checked ? '' : 'none';
}

async function backupRemoteSave() {
  const t = document.getElementById('rm-type').value;
  const body = {
    type: t,
    remote_path: document.getElementById('rm-path').value.trim(),
    encrypt_enabled: document.getElementById('rm-encrypt').checked,
    crypt_pass: document.getElementById('rm-cryptpass').value,
    auto_upload: document.getElementById('rm-auto').checked,
    retention_days: +document.getElementById('rm-retention').value || 30,
  };
  if (t === 's3') Object.assign(body, {
    endpoint: document.getElementById('rm-endpoint').value.trim(),
    region: document.getElementById('rm-region').value.trim(),
    accessKey: document.getElementById('rm-akey').value.trim(),
    secretKey: document.getElementById('rm-skey').value,
  });
  else Object.assign(body, {
    host: document.getElementById('rm-host').value.trim(),
    port: +document.getElementById('rm-port').value || 22,
    user: document.getElementById('rm-user').value.trim(),
    password: document.getElementById('rm-pass').value,
    keyContent: document.getElementById('rm-key').value,
  });
  const r = await req('POST', '/backups/remote', body);
  if (r && r.error) { alert(r.error); return; }
  alert('Guardado.');
  loadBackupRemote();
}

async function backupRemoteTest() {
  const r = await req('POST', '/backups/remote/test');
  alert(r && r.ok ? '✅ Conexión correcta' : '❌ ' + ((r && (r.message || r.error)) || 'Fallo desconocido'));
}

async function backupRemoteClear() {
  if (!confirm('¿Desconectar el destino remoto? La config remota se borra (los archivos en el remoto NO se tocan).')) return;
  await req('DELETE', '/backups/remote');
  loadBackupRemote();
}

async function backupUpload(id) {
  const r = await req('POST', `/backups/${id}/upload`);
  if (r && r.error) alert(r.error); else alert('Subido al remoto.');
}

async function loadRemoteBackups() {
  const r = await req('GET', '/backups/remote/list');
  const el = document.getElementById('remote-list'); if (!el) return;
  if (!r || r.error) { el.innerHTML = `<p class="muted">${esc((r && r.error) || 'No se pudo listar')}</p>`; return; }
  if (!r.items.length) { el.innerHTML = '<p class="muted">Sin backups en el remoto.</p>'; return; }
  el.innerHTML = '<table class="table"><thead><tr><th>Nombre</th><th>Tamaño</th><th>Modificado</th><th></th></tr></thead><tbody>' +
    r.items.map((it) => `<tr>
      <td><code>${esc(it.name)}</code></td>
      <td>${fmtBytes(it.size)}</td>
      <td>${esc(it.modTime || '')}</td>
      <td style="text-align:right">
        <button class="btn btn-sm" onclick="backupRemoteRestore('${esc(it.name)}')"><i class="ti ti-restore"></i></button>
        <button class="btn btn-sm btn-danger" onclick="backupRemoteDelete('${esc(it.name)}')"><i class="ti ti-trash"></i></button>
      </td></tr>`).join('') + '</tbody></table>';
}

async function backupRemoteRestore(filename) {
  if (!confirm(`Se descargará ${filename}, se creará un snapshot de seguridad y luego se restaurará el backup completo. ¿Continuar?`)) return;
  const con = document.getElementById('backups-console');
  con.style.display = 'block'; con.textContent = '';
  await streamConsole(`/backups/remote/${encodeURIComponent(filename)}/restore`, {}, con);
  loadBackups();
}

async function backupRemoteDelete(filename) {
  if (!confirm(`¿Borrar ${filename} del remoto?`)) return;
  await req('DELETE', `/backups/remote/${encodeURIComponent(filename)}`);
  loadRemoteBackups();
}

async function backupNow(kind) {
  const r = await req('GET', '/backups/resources');
  if (!r) return;
  const all = [...r.databases, ...r.sites, ...r.apps, ...r.panel];
  const con = document.getElementById('backups-console');
  con.style.display = 'block'; con.textContent = '';
  await streamConsole('/backups', { kind, resources: all }, con);
  loadBackups();
}

async function backupRestore(id) {
  const m = await req('GET', `/backups/${id}/manifest`);
  if (!m) return;
  if (!confirm('Se creará un snapshot de seguridad y luego se restaurará el backup completo. ¿Continuar?')) return;
  const con = document.getElementById('backups-console');
  con.style.display = 'block'; con.textContent = '';
  await streamConsole(`/backups/${id}/restore`, { items: m.manifest.items }, con);
  loadBackups();
}

async function backupDownload(id) {
  // El middleware de auth solo acepta el header Authorization: Bearer, así que
  // descargamos con fetch (enviando el token) y forzamos la descarga vía blob.
  const res = await fetch(`${API}/api/backups/${id}/download`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) { alert('No se pudo descargar el backup'); return; }
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') || '';
  const name = (cd.match(/filename="?([^"]+)"?/) || [])[1] || 'backup.tar.gz';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click();
  a.remove(); URL.revokeObjectURL(url);
}

async function backupDelete(id) {
  if (!confirm('¿Borrar esta copia de seguridad?')) return;
  await req('DELETE', `/backups/${id}`);
  loadBackups();
}

async function saveBackupSchedule() {
  const r = await req('GET', '/backups/resources');
  const all = r ? [...r.databases, ...r.sites, ...r.apps, ...r.panel] : [{ class: 'panel', name: 'panel' }];
  const body = {
    enabled: document.getElementById('bk-enabled').checked ? 1 : 0,
    frequency: document.getElementById('bk-frequency').value,
    time: document.getElementById('bk-time').value,
    retention_days: +document.getElementById('bk-retention').value,
    resources: all,
  };
  const res = await req('POST', '/backups/schedule', body);
  if (res) alert('Programación guardada');
}

// ── Correo (docker-mailserver) ─────────────────────────────────
// Streaming reutilizable (mismo patrón que streamConsole de backups).
async function mailStream(path, body, el, method = 'POST') {
  const DONE = '__TXPL_DONE__';
  const r = await fetch(API + '/api' + path, {
    method,
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (r.status === 401) { doLogout(); return 1; }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', code = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let show = buf;
    const idx = buf.indexOf(DONE);
    if (idx >= 0) { code = parseInt(buf.slice(idx + DONE.length).trim(), 10) || 0; show = buf.slice(0, idx); }
    el.textContent = show; el.scrollTop = el.scrollHeight;
  }
  return code;
}

async function loadMail() {
  const st = await req('GET', '/mail/status');
  if (!st) return;
  const body = document.getElementById('mail-body');
  if (!st.docker) {
    body.innerHTML = '<div class="card"><p>El correo necesita <b>Docker</b>. Instálalo desde <a href="#" onclick="navigate(document.querySelector(\'[data-page=plugins]\'));return false">Plugins</a>.</p></div>';
    return;
  }
  if (st.state === 'not_installed') {
    body.innerHTML = `<div class="card">
      <h3>Instalar correo</h3>
      <p class="muted">Instala docker-mailserver (un contenedor). Necesita ~1 GB de RAM y abrirá los puertos 25/465/587/143/993.</p>
      <button class="btn btn-primary" onclick="mailInstall()"><i class="ti ti-download"></i> Instalar correo</button>
    </div>`;
    return;
  }
  if (st.state === 'stopped') {
    body.innerHTML = `<div class="card"><p>El correo está instalado pero parado.</p>
      <button class="btn btn-success" onclick="mailAction('start')"><i class="ti ti-player-play"></i> Arrancar</button>
      <button class="btn btn-danger" onclick="mailUninstall()"><i class="ti ti-trash"></i> Desinstalar</button></div>`;
    return;
  }
  if (st.state === 'needs_config') {
    body.innerHTML = `<div class="card">
      <h3>Configurar el correo</h3>
      <p class="muted">Indica el hostname del correo (ej. <code>mail.tudominio.com</code>). El panel emitirá el certificado TLS con Certbot.</p>
      <div class="form-row"><input type="text" id="mail-hostname" placeholder="mail.tudominio.com" style="width:320px"></div>
      <button class="btn btn-primary" onclick="mailSaveConfig()"><i class="ti ti-device-floppy"></i> Guardar y emitir TLS</button>
    </div>`;
    return;
  }
  // ready
  body.innerHTML = `
    <div class="card">
      <h3><i class="ti ti-settings"></i> Configuración</h3>
      <p>Hostname: <b>${esc(st.hostname)}</b> · Dominio: <b>${esc(st.domain)}</b></p>
      <button class="btn btn-sm" onclick="mailAction('restart')"><i class="ti ti-refresh"></i> Reiniciar</button>
      <button class="btn btn-sm btn-danger" onclick="mailUninstall()"><i class="ti ti-trash"></i> Desinstalar</button>
    </div>
    <div class="card">
      <h3><i class="ti ti-inbox"></i> Buzones</h3>
      <div class="form-row">
        <input type="text" id="mb-addr" placeholder="usuario@${esc(st.domain)}" style="width:240px">
        <input type="password" id="mb-pass" placeholder="Contraseña" style="width:180px">
        <button class="btn btn-primary" onclick="mailAddMailbox()">Crear</button>
      </div>
      <div id="mail-mailboxes">Cargando…</div>
    </div>
    <div class="card">
      <h3><i class="ti ti-arrows-right"></i> Alias</h3>
      <div class="form-row">
        <input type="text" id="al-src" placeholder="info@${esc(st.domain)}" style="width:220px">
        <input type="text" id="al-dst" placeholder="destino@${esc(st.domain)}" style="width:220px">
        <button class="btn btn-primary" onclick="mailAddAlias()">Crear alias</button>
      </div>
      <div id="mail-aliases">Cargando…</div>
    </div>
    <div class="card">
      <h3><i class="ti ti-shield-lock"></i> DKIM y DNS</h3>
      <button class="btn" onclick="mailGenDkim()"><i class="ti ti-key"></i> Generar DKIM</button>
      <button class="btn" onclick="mailLoadDns()"><i class="ti ti-list"></i> Ver registros DNS</button>
      <div id="mail-dns"></div>
      <h3 style="margin-top:1.5rem"><i class="ti ti-inbox"></i> Webmail (Roundcube)</h3>
      <div id="mail-webmail">Cargando…</div>
    </div>`;
  loadMailboxes(); loadAliases(); loadWebmail();
}

async function mailInstall() {
  const con = document.getElementById('mail-console');
  con.style.display = 'block'; con.textContent = '';
  await mailStream('/mail/install', {}, con);
  loadMail();
}

async function mailAction(a) { await req('POST', `/mail/${a}`); loadMail(); }
async function mailUninstall() {
  if (!confirm('¿Desinstalar el correo? Se elimina el contenedor (los datos de correo se conservan en su volumen).')) return;
  await req('DELETE', '/mail'); loadMail();
}

// loadWebmail: pinta la tarjeta según el estado del contenedor Roundcube.
async function loadWebmail() {
  const el = document.getElementById('mail-webmail');
  if (!el) return;
  const st = await req('GET', '/mail/webmail/status');
  if (!st) return;
  if (!st.installed) {
    el.innerHTML = `
      <p class="muted" style="font-size:13px">Interfaz web para leer y enviar correo con los buzones de este servidor.</p>
      <div class="form-row">
        <input type="text" id="webmail-domain" placeholder="webmail.tudominio.com (opcional)" style="width:280px">
        <label style="margin-left:8px"><input type="checkbox" id="webmail-ssl"> SSL</label>
        <button class="btn btn-primary btn-sm" style="margin-left:8px" onclick="webmailInstall()"><i class="ti ti-download"></i> Instalar webmail</button>
      </div>`;
    return;
  }
  const url = st.domain ? `https://${st.domain}` : `http://127.0.0.1:${st.port}`;
  el.innerHTML = `
    <p><span class="badge ${st.running ? 'badge-green' : 'badge-red'}">${st.running ? 'En marcha' : 'Parado'}</span>
       ${st.domain ? `<a href="${esc(url)}" target="_blank">${esc(st.domain)}</a>` : `puerto ${st.port} (loopback)`}</p>
    <div class="form-row">
      <button class="btn btn-sm" onclick="webmailAction('${st.running ? 'stop' : 'start'}')">${st.running ? 'Parar' : 'Iniciar'}</button>
      <button class="btn btn-sm" onclick="webmailAction('restart')">Reiniciar</button>
      <button class="btn btn-sm btn-danger" onclick="webmailUninstall()"><i class="ti ti-trash"></i> Desinstalar</button>
    </div>`;
}

async function webmailInstall() {
  const domain = document.getElementById('webmail-domain').value.trim();
  const ssl = document.getElementById('webmail-ssl').checked;
  const con = document.getElementById('mail-console');
  con.style.display = 'block'; con.textContent = '';
  await mailStream('/mail/webmail/install', { domain, ssl }, con);
  loadWebmail();
}

async function webmailAction(a) {
  const r = await req('POST', `/mail/webmail/${a}`);
  if (r?.error) toast(r.error, 'error');
  loadWebmail();
}

async function webmailUninstall() {
  const purge = confirm('¿Borrar también la configuración guardada de Roundcube (volumen)? Aceptar = sí, Cancelar = conservar.');
  if (!confirm('¿Desinstalar el webmail?')) return;
  const con = document.getElementById('mail-console');
  con.style.display = 'block'; con.textContent = '';
  await mailStream(`/mail/webmail?volume=${purge}`, null, con, 'DELETE');
  loadWebmail();
}

async function mailSaveConfig() {
  const hostname = document.getElementById('mail-hostname').value.trim();
  const r = await req('POST', '/mail/config', { hostname });
  if (r && r.error) { alert(r.error); return; }
  if (r && r.tls && r.tls !== 'ok') alert('Guardado. TLS ' + r.tls);
  loadMail();
}

async function loadMailboxes() {
  const r = await req('GET', '/mail/mailboxes');
  const el = document.getElementById('mail-mailboxes'); if (!el) return;
  if (!r || r.error) { el.innerHTML = `<p class="muted">${esc((r && r.error) || 'No se pudieron cargar')}</p>`; return; }
  if (!r.mailboxes.length) { el.innerHTML = '<p class="muted">Aún no hay buzones.</p>'; return; }
  el.innerHTML = '<table class="table"><tbody>' + r.mailboxes.map((b) => `<tr>
    <td>${esc(b.address)}</td>
    <td style="text-align:right">
      <button class="btn btn-sm" onclick="mailPassword('${esc(b.address)}')"><i class="ti ti-key"></i></button>
      <button class="btn btn-sm btn-danger" onclick="mailDeleteMailbox('${esc(b.address)}')"><i class="ti ti-trash"></i></button>
    </td></tr>`).join('') + '</tbody></table>';
}

async function mailAddMailbox() {
  const address = document.getElementById('mb-addr').value.trim();
  const password = document.getElementById('mb-pass').value;
  const r = await req('POST', '/mail/mailboxes', { address, password });
  if (r && r.error) { alert(r.error); return; }
  document.getElementById('mb-addr').value = ''; document.getElementById('mb-pass').value = '';
  loadMailboxes();
}

async function mailPassword(addr) {
  const password = prompt(`Nueva contraseña para ${addr} (mínimo 6, sin espacios):`);
  if (!password) return;
  const r = await req('PUT', '/mail/mailboxes', { address: addr, password });
  if (r && r.error) alert(r.error); else alert('Contraseña actualizada.');
}

async function mailDeleteMailbox(addr) {
  if (!confirm(`¿Borrar el buzón ${addr}?`)) return;
  await req('DELETE', '/mail/mailboxes', { address: addr });
  loadMailboxes();
}

async function loadAliases() {
  const r = await req('GET', '/mail/aliases');
  const el = document.getElementById('mail-aliases'); if (!el) return;
  if (!r || r.error) { el.innerHTML = `<p class="muted">${esc((r && r.error) || 'No se pudieron cargar')}</p>`; return; }
  if (!r.aliases.length) { el.innerHTML = '<p class="muted">Aún no hay alias.</p>'; return; }
  el.innerHTML = '<table class="table"><tbody>' + r.aliases.map((a) => `<tr>
    <td>${esc(a.source)} → ${esc(a.destination)}</td>
    <td style="text-align:right"><button class="btn btn-sm btn-danger" onclick="mailDeleteAlias('${esc(a.source)}','${esc(a.destination)}')"><i class="ti ti-trash"></i></button></td>
    </tr>`).join('') + '</tbody></table>';
}

async function mailAddAlias() {
  const source = document.getElementById('al-src').value.trim();
  const destination = document.getElementById('al-dst').value.trim();
  const r = await req('POST', '/mail/aliases', { source, destination });
  if (r && r.error) { alert(r.error); return; }
  document.getElementById('al-src').value = ''; document.getElementById('al-dst').value = '';
  loadAliases();
}

async function mailDeleteAlias(source, destination) {
  if (!confirm(`¿Borrar el alias ${source} → ${destination}?`)) return;
  await req('DELETE', '/mail/aliases', { source, destination });
  loadAliases();
}

async function mailGenDkim() {
  const r = await req('POST', '/mail/dkim');
  if (r && r.error) { alert(r.error); return; }
  alert('DKIM generado. Pulsa "Ver registros DNS" para copiar el valor.');
  mailLoadDns();
}

async function mailLoadDns() {
  const r = await req('GET', '/mail/dns');
  const el = document.getElementById('mail-dns'); if (!el) return;
  if (!r || r.error) { el.innerHTML = `<p class="muted">${esc((r && r.error) || 'No disponible')}</p>`; return; }
  el.innerHTML = '<table class="table"><thead><tr><th>Tipo</th><th>Nombre</th><th>Valor</th></tr></thead><tbody>' +
    r.records.map((rec) => `<tr>
      <td>${esc(rec.type)}${rec.priority ? ' (' + rec.priority + ')' : ''}</td>
      <td><code>${esc(rec.name)}</code></td>
      <td><code>${esc(rec.value || '—')}</code>${rec.note ? `<br><span class="muted">${esc(rec.note)}</span>` : ''}</td>
    </tr>`).join('') + '</tbody></table>';
  el.innerHTML += `
    <div style="margin-top:10px">
      <button class="btn btn-sm btn-primary" onclick="mailDnsPreview()"><i class="ti ti-world-upload"></i> Publicar en DNS del panel</button>
      <span class="muted" style="font-size:12px;margin-left:8px">Requiere el DNS del panel instalado y la zona creada.</span>
    </div>`;
}

// mailDnsPreview: pide el resumen y muestra la modal de confirmación.
async function mailDnsPreview() {
  const r = await req('GET', '/mail/dns/preview');
  if (!r || r.error) { toast(r?.error || 'No se pudo calcular el resumen', 'error'); return; }
  const ACTION_BADGE = { crear: 'badge-green', sobrescribir: 'badge-yellow', igual: 'badge' };
  const rows = r.items.map((i) => `
    <tr><td><span class="badge ${ACTION_BADGE[i.action]}">${esc(i.action)}</span></td>
    <td>${esc(i.type)}</td><td>${esc(i.name)}</td>
    <td style="font-family:var(--mono);font-size:11px;word-break:break-all">${esc(i.value)}</td></tr>`).join('');
  const skipped = (r.skipped || []).map((s) => `<p class="muted" style="font-size:12px">⚠ ${esc(s)}</p>`).join('');
  const modal = document.createElement('div');
  modal.className = 'modal-overlay open';
  modal.id = 'modal-mail-dns';
  modal.dataset.dynamic = 'true';
  modal.innerHTML = `
    <div class="modal" style="max-width:720px">
      <div class="modal-header">
        <div class="modal-title"><i class="ti ti-world-upload"></i> Publicar registros en la zona ${esc(r.zone)}</div>
        <button class="btn btn-sm" onclick="closeModal('modal-mail-dns')"><i class="ti ti-x"></i></button>
      </div>
      <div style="padding:1rem;max-height:50vh;overflow:auto">
        <table class="table"><thead><tr><th>Acción</th><th>Tipo</th><th>Nombre</th><th>Valor</th></tr></thead>
        <tbody>${rows}</tbody></table>
        ${skipped}
      </div>
      <div class="modal-footer">
        <button class="btn" onclick="closeModal('modal-mail-dns')">Cancelar</button>
        <button class="btn btn-primary" onclick="mailDnsPublish()"><i class="ti ti-check"></i> Publicar</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

// mailDnsPublish: confirma el upsert.
async function mailDnsPublish() {
  closeModal('modal-mail-dns');
  const r = await req('POST', '/mail/dns/publish');
  if (r?.success) toast(`${r.applied} registros publicados en el DNS`, 'success');
  else toast(r?.error || 'Error al publicar', 'error');
}

// ── DNS (PowerDNS) ──────────────────────────────────────────────
// Streaming reutilizable (mismo patrón que mailStream).
async function dnsStream(path, body, el) {
  const DONE = '__TXPL_DONE__';
  const r = await fetch(API + '/api' + path, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (r.status === 401) { doLogout(); return 1; }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', code = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let show = buf;
    const idx = buf.indexOf(DONE);
    if (idx >= 0) { code = parseInt(buf.slice(idx + DONE.length).trim(), 10) || 0; show = buf.slice(0, idx); }
    el.textContent = show; el.scrollTop = el.scrollHeight;
  }
  return code;
}

async function loadDns() {
  const st = await req('GET', '/dns/status');
  if (!st) return;
  const body = document.getElementById('dns-body');
  if (st.state === 'not_installed') {
    body.innerHTML = `<div class="card">
      <h3>Instalar DNS (PowerDNS)</h3>
      <p class="muted">Convierte este VPS en servidor DNS autoritativo. Abrirá el puerto 53 (TCP/UDP).</p>
      <button class="btn btn-primary" onclick="dnsInstall()"><i class="ti ti-download"></i> Instalar PowerDNS</button>
    </div>`;
    return;
  }
  if (st.state === 'needs_config') {
    body.innerHTML = `<div class="card">
      <h3>Configurar nameservers</h3>
      <p class="muted">Define dos nameservers (ambos apuntando a este servidor) y confirma la IP.</p>
      <div class="form-row"><input type="text" id="dns-ns1" placeholder="ns1.tudominio.com" style="width:240px"></div>
      <div class="form-row"><input type="text" id="dns-ns2" placeholder="ns2.tudominio.com" style="width:240px"></div>
      <div class="form-row"><input type="text" id="dns-ip" placeholder="IP del servidor" value="${esc(st.server_ip || '')}" style="width:180px"></div>
      <button class="btn btn-primary" onclick="dnsSaveConfig()"><i class="ti ti-device-floppy"></i> Guardar</button>
    </div>`;
    return;
  }
  // ready
  body.innerHTML = `
    <div class="card">
      <h3><i class="ti ti-server"></i> Nameservers</h3>
      <p><b>${esc(st.ns1)}</b> y <b>${esc(st.ns2)}</b> → <code>${esc(st.server_ip)}</code></p>
    </div>
    <div class="card">
      <h3><i class="ti ti-list"></i> Zonas (dominios)</h3>
      <div class="form-row">
        <input type="text" id="dns-zone-name" placeholder="tudominio.com" style="width:240px">
        <button class="btn btn-primary" onclick="dnsAddZone()">Añadir dominio</button>
      </div>
      <div id="dns-zones">Cargando…</div>
    </div>
    <div class="card" id="dns-zone-detail" style="display:none">
      <h3><i class="ti ti-list-details"></i> Registros de <span id="dns-current-zone"></span></h3>
      <div class="form-row">
        <input type="text" id="dns-rec-name" placeholder="nombre (ej. www.tudominio.com)" style="width:220px">
        <select id="dns-rec-type" onchange="dnsRecTypeChange()">
          <option>A</option><option>AAAA</option><option>CNAME</option><option>MX</option><option>TXT</option>
        </select>
        <input type="text" id="dns-rec-value" placeholder="valor" style="width:200px">
        <input type="number" id="dns-rec-prio" placeholder="prioridad" value="10" style="width:90px;display:none">
        <input type="number" id="dns-rec-ttl" placeholder="TTL" value="3600" style="width:80px">
        <button class="btn btn-primary" onclick="dnsAddRecord()">Añadir</button>
      </div>
      <div id="dns-records">Cargando…</div>
      <h4 style="margin-top:16px"><i class="ti ti-arrow-guide"></i> Delegación</h4>
      <div id="dns-delegation"></div>
    </div>`;
  loadDnsZones();
}

async function dnsInstall() {
  const con = document.getElementById('dns-console');
  con.style.display = 'block'; con.textContent = '';
  await dnsStream('/dns/install', {}, con);
  loadDns();
}

async function dnsSaveConfig() {
  const body = {
    ns1: document.getElementById('dns-ns1').value.trim(),
    ns2: document.getElementById('dns-ns2').value.trim(),
    server_ip: document.getElementById('dns-ip').value.trim(),
  };
  const r = await req('POST', '/dns/config', body);
  if (r && r.error) { alert(r.error); return; }
  loadDns();
}

async function loadDnsZones() {
  const r = await req('GET', '/dns/zones');
  const el = document.getElementById('dns-zones'); if (!el) return;
  if (!r || r.error) { el.innerHTML = `<p class="muted">${esc((r && r.error) || 'No se pudieron cargar')}</p>`; return; }
  if (!r.zones.length) { el.innerHTML = '<p class="muted">Aún no hay dominios.</p>'; return; }
  el.innerHTML = '<table class="table"><tbody>' + r.zones.map((z) => `<tr>
    <td>${esc(z.name)}</td>
    <td style="text-align:right">
      <button class="btn btn-sm" onclick="dnsOpenZone('${esc(z.name)}')"><i class="ti ti-edit"></i> Registros</button>
      <button class="btn btn-sm btn-danger" onclick="dnsDeleteZone('${esc(z.name)}')"><i class="ti ti-trash"></i></button>
    </td></tr>`).join('') + '</tbody></table>';
}

async function dnsAddZone() {
  const domain = document.getElementById('dns-zone-name').value.trim();
  const r = await req('POST', '/dns/zones', { domain });
  if (r && r.error) { alert(r.error); return; }
  document.getElementById('dns-zone-name').value = '';
  loadDnsZones();
}

async function dnsDeleteZone(zone) {
  if (!confirm(`¿Borrar el dominio ${zone} y todos sus registros?`)) return;
  await req('DELETE', `/dns/zones/${encodeURIComponent(zone)}`);
  document.getElementById('dns-zone-detail').style.display = 'none';
  loadDnsZones();
}

let _dnsZone = null;
function dnsOpenZone(zone) {
  _dnsZone = zone;
  document.getElementById('dns-zone-detail').style.display = 'block';
  document.getElementById('dns-current-zone').textContent = zone;
  document.getElementById('dns-rec-name').value = zone;
  loadDnsRecords(); dnsDelegation();
}

function dnsRecTypeChange() {
  const t = document.getElementById('dns-rec-type').value;
  document.getElementById('dns-rec-prio').style.display = (t === 'MX') ? '' : 'none';
}

async function loadDnsRecords() {
  const r = await req('GET', `/dns/zones/${encodeURIComponent(_dnsZone)}/records`);
  const el = document.getElementById('dns-records'); if (!el) return;
  if (!r || r.error) { el.innerHTML = `<p class="muted">${esc((r && r.error) || 'No se pudieron cargar')}</p>`; return; }
  el.innerHTML = '<table class="table"><thead><tr><th>Nombre</th><th>Tipo</th><th>TTL</th><th>Valor</th><th></th></tr></thead><tbody>' +
    r.records.map((rec) => `<tr>
      <td><code>${esc(rec.name)}</code></td>
      <td>${esc(rec.type)}</td>
      <td>${esc(String(rec.ttl))}</td>
      <td><code>${esc(rec.content)}</code></td>
      <td style="text-align:right">${rec.type === 'SOA' || rec.type === 'NS' ? '' : `<button class="btn btn-sm btn-danger" onclick="dnsDeleteRecord('${esc(rec.name)}','${esc(rec.type)}')"><i class="ti ti-trash"></i></button>`}</td>
    </tr>`).join('') + '</tbody></table>';
}

async function dnsAddRecord() {
  const body = {
    name: document.getElementById('dns-rec-name').value.trim(),
    type: document.getElementById('dns-rec-type').value,
    value: document.getElementById('dns-rec-value').value.trim(),
    ttl: +document.getElementById('dns-rec-ttl').value || 3600,
    priority: +document.getElementById('dns-rec-prio').value || 10,
  };
  const r = await req('POST', `/dns/zones/${encodeURIComponent(_dnsZone)}/records`, body);
  if (r && r.error) { alert(r.error); return; }
  document.getElementById('dns-rec-value').value = '';
  loadDnsRecords();
}

async function dnsDeleteRecord(name, type) {
  if (!confirm(`¿Borrar el registro ${type} ${name}?`)) return;
  await req('DELETE', `/dns/zones/${encodeURIComponent(_dnsZone)}/records`, { name, type });
  loadDnsRecords();
}

async function dnsDelegation() {
  const r = await req('GET', `/dns/zones/${encodeURIComponent(_dnsZone)}/delegation`);
  const el = document.getElementById('dns-delegation'); if (!el) return;
  if (!r || r.error) { el.innerHTML = `<p class="muted">${esc((r && r.error) || 'No disponible')}</p>`; return; }
  const estado = r.delegated
    ? '<span style="color:#16a34a">✅ Delegación activa</span>'
    : '<span style="color:#d97706">⚠️ Pendiente: cambia los NS del dominio en tu registrador</span>';
  el.innerHTML = `<p>${estado}</p>
    <p class="muted">Crea estos <b>glue records</b> en tu registrador y apunta los NS del dominio a ellos:</p>
    <table class="table"><tbody>` +
    r.glue.map((g) => `<tr><td>${esc(g.type)}</td><td><code>${esc(g.name)}</code></td><td><code>${esc(g.value)}</code></td></tr>`).join('') +
    `</tbody></table>` +
    (r.ns_found && r.ns_found.length ? `<p class="muted">NS detectados ahora: ${esc(r.ns_found.join(', '))}</p>` : '');
}

// ── Tareas programadas (cron) ─────────────────────────────────
// Muestra/oculta los campos del constructor guiado según el preset elegido.
function cronPresetChange() {
  const p = document.getElementById('cron-preset').value;
  document.getElementById('cron-time-wrap').style.display = (p === 'day' || p === 'week' || p === 'month') ? '' : 'none';
  document.getElementById('cron-dow-wrap').style.display = (p === 'week') ? '' : 'none';
  document.getElementById('cron-dom-wrap').style.display = (p === 'month') ? '' : 'none';
  document.getElementById('cron-custom-wrap').style.display = (p === 'custom') ? '' : 'none';
}

// Traduce el constructor guiado a los 5 campos cron.
function cronScheduleFromForm() {
  const p = document.getElementById('cron-preset').value;
  if (p === 'custom') {
    return {
      minute: document.getElementById('cron-f-min').value.trim(),
      hour: document.getElementById('cron-f-hour').value.trim(),
      dom: document.getElementById('cron-f-dom').value.trim(),
      month: document.getElementById('cron-f-month').value.trim(),
      dow: document.getElementById('cron-f-dow').value.trim(),
    };
  }
  const [hh, mm] = (document.getElementById('cron-time').value || '03:00').split(':');
  if (p === 'minute') return { minute: '*', hour: '*', dom: '*', month: '*', dow: '*' };
  if (p === 'hour') return { minute: '0', hour: '*', dom: '*', month: '*', dow: '*' };
  if (p === 'day') return { minute: String(+mm), hour: String(+hh), dom: '*', month: '*', dow: '*' };
  if (p === 'week') return { minute: String(+mm), hour: String(+hh), dom: '*', month: '*', dow: document.getElementById('cron-dow-sel').value };
  if (p === 'month') return { minute: String(+mm), hour: String(+hh), dom: document.getElementById('cron-dom-num').value, month: '*', dow: '*' };
  return { minute: '*', hour: '*', dom: '*', month: '*', dow: '*' };
}

function cronResetForm() {
  document.getElementById('cron-id').value = '';
  document.getElementById('cron-name').value = '';
  document.getElementById('cron-command').value = '';
  document.getElementById('cron-preset').value = 'day';
  document.getElementById('cron-time').value = '03:00';
  document.getElementById('cron-form-title').innerHTML = '<i class="ti ti-plus"></i> Nueva tarea';
  cronPresetChange();
}

async function loadCron() {
  cronPresetChange();
  const data = await req('GET', '/cron');
  if (!data) return;
  const list = document.getElementById('cron-list');
  if (!data.jobs.length) { list.innerHTML = '<p class="muted">No hay tareas programadas.</p>'; return; }
  list.innerHTML = '<table class="table"><thead><tr><th>Nombre</th><th>Programación</th><th>Comando</th><th>Estado</th><th></th></tr></thead><tbody>' +
    data.jobs.map((j) => `<tr>
      <td>${esc(j.name)}</td>
      <td><code>${esc(`${j.minute} ${j.hour} ${j.dom} ${j.month} ${j.dow}`)}</code></td>
      <td><code>${esc(j.command)}</code></td>
      <td>${j.enabled ? '🟢 activa' : '⚪ inactiva'}</td>
      <td>
        <button class="btn btn-sm" onclick="cronEdit(${j.id})"><i class="ti ti-edit"></i></button>
        <button class="btn btn-sm" onclick="cronToggle(${j.id})"><i class="ti ti-power"></i></button>
        <button class="btn btn-sm" onclick="cronViewLog(${j.id})"><i class="ti ti-file-text"></i></button>
        <button class="btn btn-sm btn-danger" onclick="cronDelete(${j.id})"><i class="ti ti-trash"></i></button>
      </td></tr>`).join('') + '</tbody></table>';
  window._cronJobs = data.jobs;
}

async function cronSave() {
  const id = document.getElementById('cron-id').value;
  const body = {
    name: document.getElementById('cron-name').value.trim(),
    command: document.getElementById('cron-command').value,
    ...cronScheduleFromForm(),
  };
  if (!body.name || !body.command.trim()) { alert('Nombre y comando son obligatorios'); return; }
  const r = id ? await req('PUT', `/cron/${id}`, body) : await req('POST', '/cron', body);
  if (r && r.error) { alert(r.error); return; }
  cronResetForm();
  loadCron();
}

function cronEdit(id) {
  const j = (window._cronJobs || []).find((x) => x.id === id);
  if (!j) return;
  document.getElementById('cron-id').value = j.id;
  document.getElementById('cron-name').value = j.name;
  document.getElementById('cron-command').value = j.command;
  document.getElementById('cron-preset').value = 'custom';
  cronPresetChange();
  document.getElementById('cron-f-min').value = j.minute;
  document.getElementById('cron-f-hour').value = j.hour;
  document.getElementById('cron-f-dom').value = j.dom;
  document.getElementById('cron-f-month').value = j.month;
  document.getElementById('cron-f-dow').value = j.dow;
  document.getElementById('cron-form-title').innerHTML = '<i class="ti ti-edit"></i> Editar tarea';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function cronToggle(id) {
  const r = await req('POST', `/cron/${id}/toggle`);
  if (r && r.error) toast(r.error, 'error');
  loadCron();
}

async function cronDelete(id) {
  if (!confirm('¿Borrar esta tarea programada?')) return;
  const r = await req('DELETE', `/cron/${id}`);
  if (r && r.error) toast(r.error, 'error');
  loadCron();
}

async function cronViewLog(id) {
  const r = await req('GET', `/cron/${id}/log`);
  if (!r) return;
  document.getElementById('cron-log-card').style.display = 'block';
  document.getElementById('cron-log-output').textContent = r.log || '(sin salida registrada todavía)';
  document.getElementById('cron-log-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── Docker ────────────────────────────────────────────────────
// loadDockerContainers: lista los contenedores Docker en la tabla con sus acciones.
async function loadDockerContainers() {
  const tb = document.getElementById('docker-table');
  tb.innerHTML = '<tr><td colspan="6" class="empty-state"><i class="ti ti-loader-2 ti-spin"></i> Cargando contenedores...</td></tr>';

  const data = await req('GET', '/docker/containers');
  if (!data) {
    tb.innerHTML = '<tr><td colspan="6" class="empty-state">No se pudo cargar la lista de contenedores.</td></tr>';
    return;
  }

  if (data.error) {
    tb.innerHTML = `<tr><td colspan="6" class="empty-state"><i class="ti ti-brand-docker"></i><br>Docker no está activo o no está instalado en este sistema.</td></tr>`;
    return;
  }

  if (!data.length) {
    tb.innerHTML = '<tr><td colspan="6" class="empty-state">No hay contenedores creados en el sistema.</td></tr>';
    return;
  }

  tb.innerHTML = data.map(c => {
    const name = c.Names ? c.Names.map(n => n.replace(/^\//, '')).join(', ') : '—';
    const idShort = c.Id ? c.Id.substring(0, 12) : '—';
    const image = c.Image || '—';
    const state = c.State || '—';
    const status = c.Status || '—';

    let portsStr = '—';
    if (c.Ports && c.Ports.length) {
      portsStr = c.Ports.map(p => {
        if (p.PublicPort) {
          return `${p.IP || ''}:${p.PublicPort}->${p.PrivatePort}/${p.Type || 'tcp'}`;
        }
        return `${p.PrivatePort}/${p.Type || 'tcp'}`;
      }).join('<br>');
    }

    const stateColor = state === 'running' ? 'badge-green' : 'badge-red';

    const controlBtn = state === 'running'
      ? `<button class="btn btn-sm btn-danger" onclick="dockerAction('${c.Id}','stop')" title="Detener"><i class="ti ti-player-stop"></i> Detener</button>
         <button class="btn btn-sm" onclick="dockerAction('${c.Id}','restart')" title="Reiniciar"><i class="ti ti-refresh"></i> Reiniciar</button>`
      : `<button class="btn btn-sm btn-success" onclick="dockerAction('${c.Id}','start')" title="Iniciar"><i class="ti ti-player-play"></i> Iniciar</button>`;

    return `
    <tr>
      <td style="font-weight:600">${esc(name)}</td>
      <td style="font-size:12px;color:var(--text-secondary)">${esc(image)}</td>
      <td style="font-family:var(--mono);font-size:12px">${idShort}</td>
      <td>
        <span class="badge ${stateColor}">${esc(state)}</span>
        <div style="font-size:10px;color:var(--text-muted);margin-top:2px">${esc(status)}</div>
      </td>
      <td style="font-family:var(--mono);font-size:11px;line-height:1.3">${portsStr}</td>
      <td>
        <div style="display:flex;gap:5px;flex-wrap:wrap">
          ${controlBtn}
          <button class="btn btn-sm" onclick="viewDockerLogs('${c.Id}','${esc(name)}')" title="Ver logs"><i class="ti ti-file-text"></i> Logs</button>
          <button class="btn btn-sm btn-danger" onclick="deleteDockerContainer('${c.Id}','${esc(name)}')" title="Eliminar contenedor"><i class="ti ti-trash"></i> Eliminar</button>
        </div>
      </td>
    </tr>
    `;
  }).join('');
}

// dockerAction: arranca/para/reinicia un contenedor y refresca la lista.
async function dockerAction(id, action) {
  toast(`${action === 'stop' ? 'Deteniendo' : action === 'start' ? 'Iniciando' : 'Reiniciando'} contenedor...`, 'info');
  const r = await req('POST', `/docker/containers/${id}/${action}`);
  if (r?.success) {
    toast(`Contenedor ${action === 'stop' ? 'detenido' : action === 'start' ? 'iniciado' : 'reiniciado'}`, 'success');
    loadDockerContainers();
  } else {
    toast(r?.error || 'Error al gestionar contenedor', 'error');
  }
}

// viewDockerLogs: muestra las últimas líneas de log de un contenedor.
async function viewDockerLogs(id, name) {
  document.getElementById('docker-logs-title').textContent = name;
  document.getElementById('docker-logs-output').textContent = 'Cargando logs...';
  openModal('modal-docker-logs');

  const r = await req('GET', `/docker/containers/${id}/logs`);
  document.getElementById('docker-logs-output').textContent = r?.logs || 'Sin logs en las últimas 200 líneas.';
}

let currentDockerTab = 'image';

function switchDockerTab(tab) {
  currentDockerTab = tab;
  document.getElementById('tab-docker-image').classList.toggle('active', tab === 'image');
  document.getElementById('tab-docker-file').classList.toggle('active', tab === 'file');
  document.getElementById('tab-docker-deploy').classList.toggle('active', tab === 'deploy');
  document.getElementById('docker-image-section').style.display = tab === 'image' ? 'block' : 'none';
  document.getElementById('docker-file-section').style.display = tab === 'file' ? 'block' : 'none';
  document.getElementById('docker-deploy-section').style.display = tab === 'deploy' ? 'block' : 'none';
  // El botón cambia de texto según la pestaña
  const btn = document.getElementById('docker-create-btn');
  if (btn) btn.innerHTML = tab === 'deploy'
    ? '<i class="ti ti-rocket"></i> Desplegar'
    : '<i class="ti ti-plus"></i> Crear y Arrancar';
  if (tab !== 'deploy') document.getElementById('docker-deploy-progress').style.display = 'none';
  else onDeployTemplateChange();
}

// Ajusta la ayuda y el puerto interno por defecto según la plantilla elegida.
function onDeployTemplateChange() {
  const t = document.getElementById('docker-deploy-template').value;
  const cport = document.getElementById('docker-create-contport');
  const hints = {
    static: 'Tu sitio se sirve con Nginx en el puerto 80.',
    node: 'Necesita un script "start" en package.json. Se inyecta la variable PORT automáticamente.',
    python: 'Arranca app.py e instala requirements.txt si existe. Se inyecta la variable PORT.',
    php: 'Tu código PHP se sirve con Apache (puerto 80).',
    dockerfile: 'Se usará el Dockerfile incluido en tu .zip. Indica el Puerto Contenedor que expone.'
  };
  document.getElementById('docker-deploy-hint').textContent = hints[t] || '';
  if (t === 'static' || t === 'php') cport.value = '80';
  else if (t === 'node' && !cport.value) cport.value = '3000';
  else if (t === 'python' && !cport.value) cport.value = '8000';
}

// createDockerContainer: crea un contenedor desde imagen o Dockerfile. Si la
// pestaña activa es "Desplegar mi app", delega en deployDockerApp().
async function createDockerContainer() {
  if (currentDockerTab === 'deploy') { deployDockerApp(); return; }
  const name = document.getElementById('docker-create-name').value.trim();
  const hostPort = document.getElementById('docker-create-hostport').value.trim();
  const containerPort = document.getElementById('docker-create-contport').value.trim();
  const envs = document.getElementById('docker-create-envs').value;
  const volumeName = document.getElementById('docker-create-volname').value.trim();
  const volumePath = document.getElementById('docker-create-volpath').value.trim();
  const domain = document.getElementById('docker-create-domain').value.trim();
  const ssl = document.getElementById('docker-create-ssl').checked;

  if ((volumeName && !volumePath) || (!volumeName && volumePath)) {
    toast('Para el volumen, rellena el nombre y la ruta, o deja ambos vacíos', 'error');
    return;
  }
  if (domain && !hostPort) {
    toast('Para usar un dominio indica también el Puerto Host', 'error');
    return;
  }

  const isFile = currentDockerTab === 'file';
  const image = isFile ? '' : document.getElementById('docker-create-image').value.trim();
  const dockerfile = isFile ? document.getElementById('docker-create-file').value : '';

  if (!isFile && !image) {
    toast('La imagen de Docker es obligatoria', 'error');
    return;
  }
  if (isFile && !dockerfile.trim()) {
    toast('El contenido del Dockerfile es obligatorio', 'error');
    return;
  }

  toast(isFile ? 'Compilando y arrancando contenedor (puede tardar unos minutos)...' : 'Creando y arrancando contenedor (puede tardar en descargar la imagen)...', 'info');

  const r = await req('POST', '/docker/containers/create', {
    name: name || undefined,
    image: isFile ? undefined : image,
    dockerfile: isFile ? dockerfile : undefined,
    hostPort: hostPort ? parseInt(hostPort, 10) : undefined,
    containerPort: containerPort ? parseInt(containerPort, 10) : undefined,
    envs: envs || undefined,
    volumeName: volumeName || undefined,
    volumePath: volumePath || undefined,
    domain: domain || undefined,
    ssl: ssl || undefined
  });

  if (r?.success) {
    if (r.warning) toast(r.warning, 'error');
    else toast('Contenedor creado y arrancado con éxito' + (r.message ? '. ' + r.message : ''), 'success');
    closeModal('modal-new-container');
    loadDockerContainers();

    // Reset inputs
    ['docker-create-name', 'docker-create-image', 'docker-create-file', 'docker-create-hostport', 'docker-create-contport', 'docker-create-envs', 'docker-create-volname', 'docker-create-volpath', 'docker-create-domain'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    document.getElementById('docker-create-ssl').checked = false;
    switchDockerTab('image');
  } else {
    if (r?.error && r.error.includes('Error de compilación del Dockerfile')) {
      alert(r.error);
    } else {
      toast(r?.error || 'Error al crear el contenedor', 'error');
    }
  }
}

// Asistente "Despliega tu app": sube el ZIP y construye/arranca con logs en vivo.
async function deployDockerApp() {
  const name = document.getElementById('docker-create-name').value.trim();
  const template = document.getElementById('docker-deploy-template').value;
  const fileInput = document.getElementById('docker-deploy-file');
  const file = fileInput.files && fileInput.files[0];
  const hostPort = document.getElementById('docker-create-hostport').value.trim();
  const containerPort = document.getElementById('docker-create-contport').value.trim();
  const domain = document.getElementById('docker-create-domain').value.trim();
  const ssl = document.getElementById('docker-create-ssl').checked;
  const envs = document.getElementById('docker-create-envs').value;
  const volumeName = document.getElementById('docker-create-volname').value.trim();
  const volumePath = document.getElementById('docker-create-volpath').value.trim();

  if (!name) { toast('Indica un nombre para tu app', 'error'); return; }
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(name)) { toast('Nombre inválido (letras, números, - y _)', 'error'); return; }
  if (!file) { toast('Sube el archivo .zip de tu app', 'error'); return; }
  if ((volumeName && !volumePath) || (!volumeName && volumePath)) { toast('Para el volumen, rellena nombre y ruta o deja ambos vacíos', 'error'); return; }
  if (domain && !hostPort) { toast('Para usar un dominio indica también el Puerto Host', 'error'); return; }

  const progress = document.getElementById('docker-deploy-progress');
  const logEl = document.getElementById('docker-deploy-log');
  const spinner = document.getElementById('docker-deploy-spinner');
  const btn = document.getElementById('docker-create-btn');
  progress.style.display = 'block';
  spinner.style.display = 'inline';
  btn.disabled = true;
  logEl.textContent = 'Subiendo el código al servidor...\n';

  // 1. Subir el ZIP (stream binario)
  try {
    const up = await fetch(API + '/api/docker/deploy/upload?name=' + encodeURIComponent(name), {
      method: 'POST', headers: { 'Authorization': `Bearer ${TOKEN}` }, body: file
    });
    if (up.status === 401) { doLogout(); return; }
    const upJson = await up.json().catch(() => ({}));
    if (!upJson.success) {
      logEl.textContent += '✖ Error al subir: ' + (upJson.error || up.status) + '\n';
      spinner.style.display = 'none'; btn.disabled = false;
      toast('Error al subir el código', 'error');
      return;
    }
  } catch (e) {
    logEl.textContent += '✖ Error de conexión al subir: ' + (e?.message || e) + '\n';
    spinner.style.display = 'none'; btn.disabled = false;
    return;
  }

  // 2. Construir + desplegar (streaming de logs)
  logEl.textContent += 'Código subido. Iniciando despliegue...\n\n';
  const DONE = '__TXPL_DONE__';
  let exitCode = 1;
  try {
    const r = await fetch(API + '/api/docker/deploy/build', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name, template,
        hostPort: hostPort ? parseInt(hostPort, 10) : undefined,
        containerPort: containerPort ? parseInt(containerPort, 10) : undefined,
        domain: domain || undefined,
        ssl: ssl || undefined,
        volumeName: volumeName || undefined,
        volumePath: volumePath || undefined,
        envs: envs || undefined
      })
    });
    if (r.status === 401) { doLogout(); return; }
    if (r.status >= 400) {
      const j = await r.json().catch(() => ({}));
      logEl.textContent += '✖ ' + (j.error || ('Error ' + r.status)) + '\n';
      spinner.style.display = 'none'; btn.disabled = false;
      toast(j.error || 'Error al desplegar', 'error');
      return;
    }
    if (!r.body) { logEl.textContent += 'El navegador no soporta streaming.'; spinner.style.display = 'none'; btn.disabled = false; return; }

    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
      let display = buffer;
      const idx = buffer.indexOf(DONE);
      if (idx >= 0) { exitCode = parseInt(buffer.slice(idx + DONE.length).trim(), 10) || 0; display = buffer.slice(0, idx); }
      logEl.textContent = display;
      logEl.scrollTop = logEl.scrollHeight;
    }
  } catch (e) {
    logEl.textContent += '\n✖ Error de conexión: ' + (e?.message || e) + '\n';
  }

  spinner.style.display = 'none';
  btn.disabled = false;
  const success = exitCode === 0;
  toast(success ? 'App desplegada con éxito' : 'El despliegue terminó con errores', success ? 'success' : 'error');
  loadDockerContainers();
  if (success) {
    fileInput.value = '';
    setTimeout(() => closeModal('modal-new-container'), 2500);
  }
}

// deleteDockerContainer: elimina un contenedor (con confirmación).
async function deleteDockerContainer(id, name) {
  if (!confirm(`¿Estás seguro de que deseas eliminar permanentemente el contenedor "${name}"?`)) return;
  toast('Eliminando contenedor...', 'info');
  const r = await req('DELETE', `/docker/containers/${id}`);
  if (r?.success) {
    toast(`Contenedor "${name}" eliminado`, 'success');
    loadDockerContainers();
  } else {
    toast(r?.error || 'Error al eliminar contenedor', 'error');
  }
}

let currentDockerEditType = 'dockerfile';

// openDockerEditModal: abre el editor del Dockerfile/compose "global" del panel.
async function openDockerEditModal(type) {
  currentDockerEditType = type;
  const titleEl = document.getElementById('docker-edit-title');
  const textarea = document.getElementById('docker-edit-textarea');
  const hintEl = document.getElementById('docker-edit-hint');
  const progress = document.getElementById('docker-edit-progress');
  const log = document.getElementById('docker-edit-log');

  const titleText = type === 'dockerfile' ? 'Dockerfile global' : 'docker-compose.yml global';
  const hintText = type === 'dockerfile' 
    ? 'Este Dockerfile global se guarda en el VPS y al aplicar ejecuta: <strong>docker build -t txpl-global-image .</strong>'
    : 'Este archivo define tus contenedores globales. Al aplicar ejecuta: <strong>docker compose up -d --remove-orphans</strong>';

  titleEl.textContent = titleText;
  hintEl.innerHTML = hintText;
  textarea.value = 'Cargando archivo...';
  
  progress.style.display = 'none';
  log.textContent = '';

  openModal('modal-docker-edit');

  const r = await req('GET', `/docker/${type}`);
  if (r && r.content !== undefined) {
    textarea.value = r.content;
  } else {
    textarea.value = '';
    toast('No se pudo cargar el contenido del archivo', 'error');
  }
}

// saveDockerFile: guarda y aplica el Dockerfile/compose global (build o up -d).
async function saveDockerFile() {
  const content = document.getElementById('docker-edit-textarea').value;
  const progress = document.getElementById('docker-edit-progress');
  const log = document.getElementById('docker-edit-log');
  const saveBtn = document.getElementById('docker-edit-save-btn');
  const cancelBtn = document.getElementById('docker-edit-cancel-btn');

  toast('Guardando y aplicando configuración...', 'info');

  progress.style.display = 'block';
  log.textContent = 'Enviando cambios al servidor...\n';
  log.scrollTop = log.scrollHeight;
  
  saveBtn.disabled = true;
  cancelBtn.disabled = true;

  const r = await req('POST', `/docker/${currentDockerEditType}`, { content });

  if (r?.success) {
    log.textContent += `\n[ÉXITO] Archivo guardado correctamente.\nSalida del comando:\n${r.output || 'Sin salida'}\n`;
    toast('Configuración guardada y aplicada con éxito', 'success');
    loadDockerContainers();
    setTimeout(() => {
      closeModal('modal-docker-edit');
    }, 2500);
  } else {
    log.textContent += `\n[ERROR] Falló la ejecución:\n${r?.error || 'Error desconocido'}\n`;
    toast('Error al aplicar configuración', 'error');
  }
  
  log.scrollTop = log.scrollHeight;
  saveBtn.disabled = false;
  cancelBtn.disabled = false;
}

