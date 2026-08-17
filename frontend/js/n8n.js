// TecXPaneL — n8n (workflows, ejecuciones, ciclo de vida contenedor)
// Carga el estado y pinta la vista adaptativa (instalar / conectar / dashboard).
// URL con la que el NAVEGADOR abre n8n: el dominio si lo hay, o la IP/host con
// el que entraste al panel + el puerto de n8n (no "localhost", que sería tu PC).
function n8nOpenBase(st) {
  return st.domain ? st.base_url : `http://${location.hostname}:${st.host_port}`;
}

let n8nWorkflowsCache = [];

function n8nWorkflowArg(id) { return esc(JSON.stringify(String(id))); }

function n8nFilterWorkflows() {
  renderN8nWorkflows(document.getElementById('n8n-open-url')?.href || '', document.getElementById('n8n-workflow-search')?.value || '');
}

async function loadN8n() {
  const body = document.getElementById('n8n-body');
  body.innerHTML = '<div class="card"><p>Cargando estado de n8n...</p></div>';
  const st = await req('GET', '/n8n/status');
  if (!st) { body.innerHTML = '<div class="n8n-empty card"><i class="ti ti-alert-triangle"></i><strong>No se pudo consultar n8n</strong><span>Comprueba Docker y vuelve a intentarlo.</span><button class="btn btn-primary" onclick="loadN8n()">Reintentar</button></div>'; return; }

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
  body.innerHTML = `<div class="n8n-dashboard">
  <div class="n8n-hero"><div><span class="eyebrow"><i class="ti ti-sitemap"></i> AUTOMATIZACIÓN</span><h2>Workflows en producción</h2><p>Controla el estado de tus automatizaciones y abre el editor completo cuando necesites construir.</p></div><div class="n8n-hero-actions"><a id="n8n-open-url" class="btn btn-primary" href="${esc(openUrl)}" target="_blank" rel="noopener"><i class="ti ti-external-link"></i> Abrir n8n</a>
      <button class="btn" onclick="n8nAction('restart')">Reiniciar</button>
      <button class="btn" onclick="n8nAction('stop')">Detener</button>
      <button class="btn btn-danger" onclick="n8nUninstall()">Desinstalar</button>
    </div></div>
  <div class="n8n-metrics"><div class="n8n-metric"><span class="n8n-metric-icon"><i class="ti ti-sitemap"></i></span><div><small>Total</small><strong id="n8n-total">—</strong></div></div><div class="n8n-metric is-green"><span class="n8n-metric-icon"><i class="ti ti-player-play"></i></span><div><small>Activos</small><strong id="n8n-active">—</strong></div></div><div class="n8n-metric is-blue"><span class="n8n-metric-icon"><i class="ti ti-player-pause"></i></span><div><small>Pausados</small><strong id="n8n-paused">—</strong></div></div><div class="n8n-metric"><span class="n8n-metric-icon"><i class="ti ti-history"></i></span><div><small>Ejecuciones</small><strong id="n8n-execution-count">—</strong></div></div></div>
  <div class="n8n-grid"><div class="card n8n-card"><div class="n8n-card-heading"><div><span class="eyebrow">CATÁLOGO</span><h3>Workflows</h3></div><button class="btn btn-sm" onclick="loadN8n()"><i class="ti ti-refresh"></i> Actualizar</button></div><div class="n8n-search"><i class="ti ti-search"></i><input id="n8n-workflow-search" type="search" placeholder="Buscar por nombre o tag..." oninput="n8nFilterWorkflows()"></div><div id="n8n-workflows">Cargando...</div></div>
  <div class="card n8n-card"><div class="n8n-card-heading"><div><span class="eyebrow">OBSERVABILIDAD</span><h3>Actividad reciente</h3></div><button class="btn btn-sm" onclick="loadN8nExecutions()"><i class="ti ti-refresh"></i></button></div><div id="n8n-executions">Cargando...</div></div></div></div>`;

  loadN8nWorkflows(openUrl);
  loadN8nExecutions();
}

async function loadN8nWorkflows(baseUrl) {
  const el = document.getElementById('n8n-workflows');
  const r = await req('GET', '/n8n/workflows');
  if (!r || !r.workflows) { el.textContent = 'No pude cargar los workflows.'; return; }
  if (r.workflows.length === 0) { n8nWorkflowsCache = []; renderN8nWorkflows(baseUrl); return; }
  n8nWorkflowsCache = r.workflows;
  renderN8nWorkflows(baseUrl);
}

function renderN8nWorkflows(baseUrl, query = '') {
  const el = document.getElementById('n8n-workflows');
  if (!el) return;
  const safeBase = esc(String(baseUrl).replace(/\/+$/, '')); // sin barra final: evita // en las URLs
  const normalized = query.trim().toLowerCase();
  const workflows = n8nWorkflowsCache.filter((w) => !normalized || [w.name, ...(w.tags || [])].join(' ').toLowerCase().includes(normalized));
  const active = n8nWorkflowsCache.filter((w) => w.active).length;
  document.getElementById('n8n-total')?.replaceChildren(document.createTextNode(String(n8nWorkflowsCache.length)));
  document.getElementById('n8n-active')?.replaceChildren(document.createTextNode(String(active)));
  document.getElementById('n8n-paused')?.replaceChildren(document.createTextNode(String(n8nWorkflowsCache.length - active)));
  if (!workflows.length) { el.innerHTML = '<div class="n8n-empty"><i class="ti ti-search-off"></i><strong>No hay resultados</strong><span>Prueba con otro nombre o tag.</span></div>'; return; }
  el.innerHTML = '<div class="n8n-workflow-list">'
    + workflows.map((w) => {
      const toggle = w.active
        ? `<button class="btn btn-sm" onclick="n8nToggleWorkflow(${n8nWorkflowArg(w.id)}, true)"><i class="ti ti-player-pause"></i> Pausar</button>`
        : `<button class="btn btn-sm btn-primary" onclick="n8nToggleWorkflow(${n8nWorkflowArg(w.id)}, false)"><i class="ti ti-player-play"></i> Activar</button>`;
      const editUrl = `${safeBase}/workflow/${esc(w.id)}`;
      const webhook = w.webhookPath
        ? `<div class="n8n-webhook"><i class="ti ti-webhook"></i> ${esc(w.webhookPath)}</div>` : '';
      return `<article class="n8n-workflow-item"><div class="n8n-workflow-main"><div class="n8n-workflow-title"><span class="n8n-status-dot ${w.active ? 'is-active' : ''}"></span><strong>${esc(w.name)}</strong><span class="n8n-status-label">${w.active ? 'Activo' : 'Pausado'}</span></div><div class="n8n-tags">${(w.tags || []).map(t => '<span>' + esc(t) + '</span>').join('') || '<span class="is-muted">Sin tags</span>'}</div>${webhook}</div><div class="n8n-workflow-actions">${toggle}<a class="btn btn-sm" href="${editUrl}" target="_blank" rel="noopener"><i class="ti ti-edit"></i> Editar</a></div></article>`;
    }).join('') + '</div>';
}

async function loadN8nExecutions() {
  const el = document.getElementById('n8n-executions');
  const r = await req('GET', '/n8n/executions');
  if (!r || !r.executions) { el.textContent = 'No pude cargar las ejecuciones.'; return; }
  document.getElementById('n8n-execution-count')?.replaceChildren(document.createTextNode(String(r.executions.length)));
  if (r.executions.length === 0) { el.textContent = 'Sin ejecuciones todavía.'; return; }
  const icon = (s) => s === 'success' ? 'ti-check' : (s === 'error' ? 'ti-x' : 'ti-loader-2');
  el.innerHTML = '<div class="n8n-execution-list">'
    + r.executions.map((e) => { const status = String(e.status || 'running').toLowerCase(); return `<article class="n8n-execution-item is-${esc(status)}"><span class="n8n-execution-icon"><i class="ti ${icon(status)}"></i></span><div class="n8n-execution-copy"><strong>${esc(e.workflowName)}</strong><span>${esc(status)} · ${e.startedAt ? new Date(e.startedAt).toLocaleString('es-ES') : 'sin fecha'}</span></div></article>`; }).join('') + '</div>';
}

// Instalación por streaming (reutiliza el patrón de streamPlugin).
async function n8nInstall() {
  const host_port = document.getElementById('n8n-port').value;
  const domain = document.getElementById('n8n-domain').value.trim();
  const timezone = document.getElementById('n8n-tz').value.trim();
  if (!/^\d+$/.test(host_port) || Number(host_port) < 1024 || Number(host_port) > 65535) {
    toast('El puerto debe estar entre 1024 y 65535', 'error'); return;
  }
  if (!timezone || timezone.length > 64 || /[\u0000-\u001f\u007f]/.test(timezone)) {
    toast('Introduce una zona horaria válida', 'error'); return;
  }
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
    if (!r.ok) {
      const errorBody = await r.text();
      let message = 'No se pudo iniciar la instalación';
      try { message = JSON.parse(errorBody).error || message; } catch (_) {}
      out.textContent = '✖ ' + message;
      toast(message, 'error');
      spinner.style.display = 'none';
      return;
    }
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

Object.assign(window, {
  loadN8n, loadN8nExecutions, loadN8nWorkflows, n8nAction, n8nFilterWorkflows, n8nInstall, n8nOpenBase, n8nSaveConfig, n8nToggleWorkflow, n8nUninstall,
});
