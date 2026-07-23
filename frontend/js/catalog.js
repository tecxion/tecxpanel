// TecXPaneL — catalog (apps one-click: WordPress, Ghost, Nextcloud, Vaultwarden, Uptime Kuma)

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

  const hasInstalledApps = data.apps.some(a => a.installed);
  let html = '';
  if (!hasInstalledApps && data.apps.length > 0) {
    html = '<div class="card" style="text-align:center;padding:3rem"><div class="empty-state">' + emptyState('apps-off', 'Sin aplicaciones instaladas desde el catálogo') + '</div><p style="margin-top:2rem;color:var(--text-secondary)">Explora el catálogo abajo para instalar aplicaciones.</p></div><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1rem;margin-top:1.5rem">';
  } else {
    html = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:1rem">`;
  }
  html += data.apps.map((a) => {
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
  body.innerHTML = html;
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
        <button class="btn" onclick="closeModal('modal-catalog-install')"><i class="ti ti-x"></i> Cancelar</button>
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
        <button class="btn" onclick="closeModal('modal-catalog-uninstall')"><i class="ti ti-x"></i> Cancelar</button>
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
