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

// ── Parsers y helpers de formato "bonito" ────────────────────────────────
// Objetivo: que un usuario no técnico entienda de un vistazo qué pasa —
// emojis según severidad, color según categoría, columnas alineadas.
// Los parsers devuelven null si no reconocen la línea; entonces cae al
// modo texto simple con colores por palabra clave (el de siempre).

// Nginx access (formato combined):
// 1.2.3.4 - - [07/Aug/2026:18:12:34 +0000] "GET /path HTTP/1.1" 200 1234 "-" "UA"
const RE_ACCESS = /^(\S+)\s+\S+\s+\S+\s+\[([^\]]+)\]\s+"(\S+)\s+(\S+)[^"]*"\s+(\d+)\s+(\d+|-)/;
// Nginx error:
// 2026/08/07 18:12:34 [error] 1234#0: *5 message...
const RE_NERR = /^(\d{4}\/\d{2}\/\d{2}\s\d{2}:\d{2}:\d{2})\s+\[(\w+)\]\s+\d+#\d+:?\s*(?:\*\d+\s*)?(.+)/;
// Syslog:
// Aug  7 18:12:34 host program[pid]: message
const RE_SYSLOG = /^(\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2})\s+(\S+)\s+([^\s:\[]+)(?:\[\d+\])?:\s*(.+)/;
// Auditoría (ya formateada por logsFetch): [when] user@ip — action · detail
const RE_AUDIT = /^\[([^\]]+)\]\s+(\S+)@(\S+)\s+—\s+(\S+)(?:\s+·\s+(.+))?$/;

// Emoji + color según código HTTP.
function httpStyle(code) {
  const n = parseInt(code, 10);
  if (n >= 500) return { emo: '❌', color: 'var(--red)' };
  if (n >= 400) return { emo: '⚠️', color: 'var(--yellow, #d7a53f)' };
  if (n >= 300) return { emo: '↪️', color: 'var(--cyan)' };
  if (n >= 200) return { emo: '✅', color: 'var(--green)' };
  return { emo: '•', color: 'var(--text-muted)' };
}
// Emoji + color según nivel de nginx/syslog.
function levelStyle(level) {
  const l = String(level).toLowerCase();
  if (/(emerg|alert|crit|fatal|error|err)/.test(l)) return { emo: '❌', color: 'var(--red)' };
  if (/warn/.test(l))                                return { emo: '⚠️', color: 'var(--yellow, #d7a53f)' };
  if (/notice|info/.test(l))                          return { emo: 'ℹ️', color: 'var(--cyan)' };
  return { emo: '•', color: 'var(--text-secondary)' };
}
// Emoji por prefijo de acción de auditoría (login.*, website.*, docker.* …).
const AUDIT_EMOJI = {
  login: '🔓', logout: '🚪', password: '🔑', '2fa': '🔐', reset: '🆘',
  recovery: '🆘', website: '🌐', app: '📦', database: '🗄️', docker: '🐳',
  backup: '💾', cron: '⏰', mail: '📧', dns: '🌍', ssl: '🔐',
  firewall: '🛡️', service: '⚙️', terminal: '💻', plugin: '🧩',
  n8n: '🔗', catalog: '📚', notify: '🔔',
};
function auditEmoji(action) {
  const head = String(action).split('.')[0];
  if (action.endsWith('.fail') || action.endsWith('.locked')) return '🚫';
  return AUDIT_EMOJI[head] || '•';
}
// Formatea "1234" a KB/MB si es grande. Devuelve "1.2 KB" o "—".
function fmtSizeShort(n) {
  const b = parseInt(n, 10);
  if (!b || b === 0) return '—';
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / (1024 * 1024)).toFixed(1) + ' MB';
}
// Extrae hora "HH:MM:SS" de un timestamp cualquiera, o devuelve el original.
function shortTime(ts) {
  const m = String(ts).match(/(\d{2}:\d{2}:\d{2})/);
  return m ? m[1] : ts;
}

// Renderiza una línea a HTML "bonito". Devuelve el HTML o null si no reconoce.
function prettyLine(raw) {
  // Prefijo del feed unificado de Errores: "[nginx] real-line" | "[system] real-line"
  let feedTag = '';
  let line = raw;
  const mFeed = raw.match(/^\[(nginx|system)\]\s+(.+)$/);
  if (mFeed) {
    feedTag = `<span class="badge ${mFeed[1] === 'nginx' ? 'badge-red' : 'badge-yellow'}" style="margin-right:6px">${mFeed[1]}</span>`;
    line = mFeed[2];
  }

  // 1. Auditoría
  let m = line.match(RE_AUDIT);
  if (m) {
    const [, when, user, ip, action, detail] = m;
    const emo = auditEmoji(action);
    const isFail = action.endsWith('.fail') || action.endsWith('.locked');
    const color = isFail ? 'var(--red)' : 'var(--text-primary)';
    return `${feedTag}${emo}  <span style="color:var(--text-muted)">${esc(shortTime(when))}</span>  `
      + `<b>${esc(user)}</b><span style="color:var(--text-muted)">@${esc(ip)}</span>  `
      + `<span style="color:${color}">${esc(action)}</span>`
      + (detail ? `  <span style="color:var(--text-muted)">· ${esc(detail)}</span>` : '');
  }

  // 2. Nginx access (combined)
  m = line.match(RE_ACCESS);
  if (m) {
    const [, ip, ts, method, path, status, bytes] = m;
    const s = httpStyle(status);
    return `${feedTag}${s.emo}  <span style="color:${s.color};font-weight:600">${status}</span>  `
      + `<span style="color:var(--accent)">${esc(method)}</span> <span>${esc(path)}</span>  `
      + `<span style="color:var(--text-muted)">${esc(ip)}</span>  `
      + `<span style="color:var(--text-muted)">${esc(shortTime(ts))}</span>  `
      + `<span style="color:var(--text-muted)">${fmtSizeShort(bytes)}</span>`;
  }

  // 3. Nginx error
  m = line.match(RE_NERR);
  if (m) {
    const [, ts, level, msg] = m;
    const s = levelStyle(level);
    return `${feedTag}${s.emo}  <span style="color:var(--text-muted)">${esc(shortTime(ts))}</span>  `
      + `<span style="color:${s.color};font-weight:600">[${esc(level)}]</span>  `
      + `<span style="color:${s.color}">${esc(msg)}</span>`;
  }

  // 4. Syslog
  m = line.match(RE_SYSLOG);
  if (m) {
    const [, ts, host, prog, msg] = m;
    const s = levelStyle(msg);      // syslog no lleva nivel explícito; adivinamos por el texto
    return `${feedTag}${s.emo}  <span style="color:var(--text-muted)">${esc(shortTime(ts))}</span>  `
      + `<span style="color:var(--accent)">${esc(prog)}</span>  `
      + `<span style="color:${s.color}">${esc(msg)}</span>`;
  }
  return null;
}

// logsRender: aplica filtros y pinta con "modo bonito" (parsers por tipo)
// o cae a "modo crudo" con colores por palabra clave si el toggle está off
// o si el parser no reconoce la línea. Auto-scroll SOLO si el usuario estaba
// ya en el fondo (evita saltos molestos al leer historial en modo live).
function logsRender() {
  const out = document.getElementById('log-output');
  if (!out) return;
  const wasAtBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;

  const filter = (document.getElementById('logs-filter')?.value || '').toLowerCase();
  const isAudit = logsSrc.type === 'audit';
  const fUser = isAudit ? (document.getElementById('logs-audit-user')?.value || '').toLowerCase() : '';
  const fAction = isAudit ? (document.getElementById('logs-audit-action')?.value || '').toLowerCase() : '';
  const pretty = document.getElementById('logs-pretty')?.checked !== false;   // por defecto ON

  const lines = logsRaw.split('\n').filter(l => {
    const lo = l.toLowerCase();
    if (filter && !lo.includes(filter)) return false;
    if (fUser && !lo.includes(fUser)) return false;
    if (fAction && !lo.includes(fAction)) return false;
    return true;
  });

  out.innerHTML = lines.map(l => {
    if (pretty) {
      const html = prettyLine(l);
      if (html) return html;
    }
    // Fallback: modo crudo con colores por palabra clave (comportamiento antiguo).
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
