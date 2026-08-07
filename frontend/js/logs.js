// TecXPaneL — logs (visor multi-fuente, modo en vivo, filtros)

// Estado de la página de logs. logsSrc = fuente actual; logsRaw = texto crudo
// para poder re-filtrar sin volver a pedir al backend; logsTimer = interval
// del modo "en vivo"; logsSourcesTimer = refresco de apps/sitios en background;
// logsErrCounts = últimos contadores del feed de Errores para el badge.
let logsSrc = { type: 'static', key: 'nginx_access' };
let logsRaw = '';
let logsTimer = null;
let logsSourcesTimer = null;
let logsErrCounts = null;

// loadLogsPage: entra en la página — carga fuentes dinámicas y arranca un
// refresco silencioso de sources cada 30 s (por si el usuario crea una app
// o un sitio en otra pestaña). El refresco se para al salir (logsLiveStop).
async function loadLogsPage() {
  await refreshLogsSources();
  logsApplySelection();
  logsFetch();
  if (logsSourcesTimer) clearInterval(logsSourcesTimer);
  logsSourcesTimer = setInterval(refreshLogsSources, 30_000);
}

// refreshLogsSources: rellena los <select> de apps y sitios sin perder la
// selección actual. Silencioso si /logs/sources falla (no interrumpe).
async function refreshLogsSources() {
  const s = await req('GET', '/logs/sources').catch(() => null);
  if (!s) return;
  const appSel = document.getElementById('logs-app-select');
  const siteSel = document.getElementById('logs-site-select');
  const prevApp = appSel?.value;
  const prevSite = siteSel?.value;
  if (appSel) {
    appSel.innerHTML = '<option value="">Apps (PM2)…</option>' +
      (s.apps || []).map(a => `<option value="${a.id}">${esc(a.name)}${a.status !== 'running' ? ' (parada)' : ''}</option>`).join('');
    if (prevApp) appSel.value = prevApp;
  }
  if (siteSel) {
    siteSel.innerHTML = '<option value="">Sitios web…</option>' +
      (s.sites || []).map(w => `<option value="${esc(w.domain)}">${esc(w.domain)}${w.hasOwnLog ? '' : ' (log global)'}</option>`).join('');
    if (prevSite) siteSel.value = prevSite;
  }
}

// logsSelect: clic en una pestaña estática (nginx/sistema/errores/auditoría).
function logsSelect(el) {
  const src = el.dataset.src;
  if (src === 'audit')        logsSrc = { type: 'audit' };
  else if (src === 'errors')  logsSrc = { type: 'errors' };
  else                        logsSrc = { type: 'static', key: src.split(':')[1] };
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
function logsSelectSite() {
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
  else if (logsSrc.type === 'static' || logsSrc.type === 'audit' || logsSrc.type === 'errors') {
    const key = logsSrc.type === 'static' ? `static:${logsSrc.key}` : logsSrc.type;
    document.querySelector(`#logs-tabs .tab[data-src="${key}"]`)?.classList.add('active');
  }
  if (logsSrc.type !== 'app') document.getElementById('logs-app-select').value = '';
  if (logsSrc.type !== 'site') {
    document.getElementById('logs-site-select').value = '';
    document.getElementById('logs-site-kind').style.display = 'none';
  }
  // Muestra el filtro de auditoría solo cuando la pestaña activa lo necesita.
  const auditBar = document.getElementById('logs-audit-filter-bar');
  if (auditBar) auditBar.style.display = logsSrc.type === 'audit' ? '' : 'none';
  // Muestra el contador de errores solo en su pestaña.
  const errBadge = document.getElementById('logs-errors-badge');
  if (errBadge) errBadge.style.display = logsSrc.type === 'errors' ? '' : 'none';
}

// logsFetch: pide la fuente actual al backend y repinta.
async function logsFetch() {
  const lines = document.getElementById('logs-lines')?.value || '300';
  let r;
  if (logsSrc.type === 'audit') {
    const rows = await req('GET', '/logs/audit/list');
    logsRaw = Array.isArray(rows)
      ? rows.map(a => {
          const when = a.ts ? new Date(a.ts).toLocaleString('es-ES') : '';
          return `[${when}] ${a.user || '?'}@${a.ip || '?'} — ${a.action}${a.detail ? ' · ' + a.detail : ''}`;
        }).join('\n')
      : 'Auditoría no disponible';
    // Rellenar datalists de usuario/acción para el filtro de auditoría.
    if (Array.isArray(rows)) fillAuditDatalists(rows);
  } else if (logsSrc.type === 'errors') {
    r = await req('GET', `/logs/errors?lines=${lines}`);
    logsRaw = r?.logs || 'Sin errores recientes.';
    logsErrCounts = r?.counts || null;
    updateErrBadge();
  } else if (logsSrc.type === 'app') {
    r = await req('GET', `/apps/${logsSrc.id}/logs`);
    logsRaw = r?.logs || 'Sin logs';
  } else if (logsSrc.type === 'site') {
    // fallback=global: si el sitio no tiene log propio, cae al log global de nginx.
    r = await req('GET', `/logs/site/${encodeURIComponent(logsSrc.domain)}?kind=${logsSrc.kind}&lines=${lines}&fallback=global`);
    logsRaw = r?.logs || r?.error || 'Log no disponible';
  } else {
    r = await req('GET', `/logs/${logsSrc.key}?lines=${lines}`);
    logsRaw = r?.logs || 'Log no disponible';
  }
  logsRender();
}

function updateErrBadge() {
  const b = document.getElementById('logs-errors-badge');
  if (!b) return;
  if (!logsErrCounts) { b.textContent = ''; return; }
  const n = logsErrCounts.nginx || 0;
  const s = logsErrCounts.system || 0;
  b.innerHTML = `<span class="badge badge-red">nginx: ${n}</span> <span class="badge badge-yellow">sistema: ${s}</span>`;
}

function fillAuditDatalists(rows) {
  const users = [...new Set(rows.map(r => r.user).filter(Boolean))].sort();
  const acts  = [...new Set(rows.map(r => r.action).filter(Boolean))].sort();
  const dlU = document.getElementById('logs-audit-users');
  const dlA = document.getElementById('logs-audit-actions');
  if (dlU) dlU.innerHTML = users.map(u => `<option value="${esc(u)}">`).join('');
  if (dlA) dlA.innerHTML = acts.map(a => `<option value="${esc(a)}">`).join('');
}

// logsRender: aplica filtros y colorea errores/avisos. innerHTML es seguro
// porque esc() escapa cada línea antes de envolverla en span.
// Auto-scroll INTELIGENTE: solo baja al fondo si el usuario ya estaba en el
// fondo (antes saltaba al fondo cada tick, impidiendo leer historial mientras
// el modo live estaba activo).
function logsRender() {
  const out = document.getElementById('log-output');
  if (!out) return;
  const wasAtBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;

  const filter = (document.getElementById('logs-filter')?.value || '').toLowerCase();
  // Filtros extra solo para auditoría.
  const isAudit = logsSrc.type === 'audit';
  const fUser = isAudit ? (document.getElementById('logs-audit-user')?.value || '').toLowerCase() : '';
  const fAction = isAudit ? (document.getElementById('logs-audit-action')?.value || '').toLowerCase() : '';

  const lines = logsRaw.split('\n').filter(l => {
    const lo = l.toLowerCase();
    if (filter && !lo.includes(filter)) return false;
    if (fUser && !lo.includes(fUser)) return false;
    if (fAction && !lo.includes(fAction)) return false;
    return true;
  });
  out.innerHTML = lines.map(l => {
    const e = esc(l);
    if (/error|crit|alert|emerg|denied|fail/i.test(l)) return `<span style="color:var(--red)">${e}</span>`;
    if (/warn/i.test(l)) return `<span style="color:var(--yellow, #d7a53f)">${e}</span>`;
    return e;
  }).join('\n');
  if (wasAtBottom) out.scrollTop = out.scrollHeight;
}

// logsLiveToggle: refresco automático cada 4 s + punto verde pulsante.
function logsLiveToggle() {
  const on = document.getElementById('logs-live')?.checked;
  const dot = document.getElementById('logs-live-dot');
  if (logsTimer) { clearInterval(logsTimer); logsTimer = null; }
  if (dot) dot.style.display = on ? '' : 'none';
  if (on) logsTimer = setInterval(logsFetch, 4000);
}
// logsLiveStop: se llama al salir de la página (desde navigate()).
function logsLiveStop() {
  if (logsTimer) { clearInterval(logsTimer); logsTimer = null; }
  if (logsSourcesTimer) { clearInterval(logsSourcesTimer); logsSourcesTimer = null; }
  const live = document.getElementById('logs-live');
  if (live) live.checked = false;
  const dot = document.getElementById('logs-live-dot');
  if (dot) dot.style.display = 'none';
}

// logsDownload: descarga el texto mostrado como fichero .log.
function logsDownload() {
  const name = logsSrc.type === 'static' ? logsSrc.key
    : logsSrc.type === 'site' ? `${logsSrc.domain}.${logsSrc.kind}`
    : logsSrc.type === 'app' ? `app-${logsSrc.id}`
    : logsSrc.type === 'errors' ? 'errores'
    : 'auditoria';
  const blob = new Blob([logsRaw], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name}.log`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// logsCopy: copia el texto renderizado (con filtro aplicado) al portapapeles.
async function logsCopy() {
  const out = document.getElementById('log-output');
  const text = out?.innerText || logsRaw;
  const okCopy = await copyText(text);
  toast(okCopy ? 'Log copiado' : 'No se pudo copiar', okCopy ? 'success' : 'error');
}

Object.assign(window, {
  loadLogsPage, logsApplySelection, logsCopy, logsDownload, logsFetch,
  logsLiveStop, logsLiveToggle, logsRender, logsSelect, logsSelectApp,
  logsSelectSite, refreshLogsSources,
});
