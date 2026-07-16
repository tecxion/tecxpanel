// TecXPaneL — logs (visor multi-fuente, modo en vivo)

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
