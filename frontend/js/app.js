// ════════════════════════════════════════════════════════════
// TXPL Frontend Logic
// ════════════════════════════════════════════════════════════

const API = window.location.origin;
let TOKEN = localStorage.getItem('txpl_token') || '';
let statsWS = null;
let currentPage = 'dashboard';
let serverIp = '';

// ── Helpers ──────────────────────────────────────────────────
async function req(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${TOKEN}` }
  };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(API + '/api' + path, opts);
  if (r.status === 401) { doLogout(); return; }
  return r.json();
}

function toast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${type} show`;
  setTimeout(() => el.classList.remove('show'), 3500);
}

function fmtBytes(b) {
  if (!b || b === 0) return '0 B';
  const k = 1024, sz = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return (b / Math.pow(k, i)).toFixed(1) + ' ' + sz[i];
}

function fmtDate(d) {
  return d ? new Date(d).toLocaleDateString('es-ES', {day:'2-digit',month:'short',year:'numeric'}) : '—';
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
  ));
}

function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('open');
}
function closeModal(id) {
  const el = document.getElementById(id);
  if (el) {
    el.classList.remove('open');
    if (el.dataset.dynamic) setTimeout(() => el.remove(), 150);
  }
}

document.querySelectorAll('.modal-overlay').forEach(o => {
  o.addEventListener('click', e => { if (e.target === o) o.classList.remove('open') });
});

// ── Auth ──────────────────────────────────────────────────────
async function doLogin() {
  const user = document.getElementById('login-user').value;
  const pass = document.getElementById('login-pass').value;
  const data = await fetch(API + '/api/auth/login', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ username: user, password: pass })
  }).then(r => r.json()).catch(() => ({}));

  if (data.token) {
    TOKEN = data.token;
    localStorage.setItem('txpl_token', TOKEN);
    document.getElementById('user-name').textContent = data.user.username;
    document.getElementById('user-avatar').textContent = data.user.username[0].toUpperCase();
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    document.getElementById('status-badge').style.display = 'flex';
    initApp();
  } else {
    document.getElementById('login-error').style.display = 'block';
  }
}

document.getElementById('login-pass').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});

function doLogout() {
  TOKEN = '';
  localStorage.removeItem('txpl_token');
  if (statsWS) statsWS.close();
  termCleanup();
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
}

async function checkAuth() {
  if (!TOKEN) return;
  const data = await req('GET', '/auth/me');
  if (data && data.username) {
    document.getElementById('user-name').textContent = data.username;
    document.getElementById('user-avatar').textContent = data.username[0].toUpperCase();
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    document.getElementById('status-badge').style.display = 'flex';
    initApp();
  }
}

// ── Navigation ────────────────────────────────────────────────
function navigate(el) {
  const page = typeof el === 'string' ? el : el?.dataset?.page;
  const target = page && document.getElementById('page-' + page);
  if (!target) return;

  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  if (el && el.classList) el.classList.add('active');
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  target.classList.add('active');

  const titles = {
    dashboard: 'Dashboard', terminal: 'Terminal SSH', logs: 'Logs del sistema',
    websites: 'Sitios Web', apps: 'Aplicaciones', databases: 'Bases de Datos',
    files: 'Gestor de Archivos', firewall: 'Firewall UFW', ssl: 'Certificados SSL',
    plugins: 'Plugins', help: 'Manual de uso', settings: 'Ajustes'
  };
  document.getElementById('page-title').textContent = titles[page] || page;
  if (currentPage === 'terminal' && page !== 'terminal') termCleanup();
  currentPage = page;

  if (page === 'websites') loadWebsites();
  if (page === 'apps') loadApps();
  if (page === 'databases') loadDatabases();
  if (page === 'firewall') loadFirewall();
  if (page === 'files') loadFiles();
  if (page === 'ssl') loadSSL();
  if (page === 'plugins') loadPlugins();
  if (page === 'settings') loadSettings();
}

// ── Init ──────────────────────────────────────────────────────
function initApp() {
  loadDashboard();
  connectStatsWS();
  loadServices();
  loadProcesses();
  req('GET', '/system/ip').then(d => { if (d?.ip) serverIp = d.ip; });
}

// ── Stats WebSocket ───────────────────────────────────────────
function connectStatsWS() {
  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = `${wsProto}://${location.host}/ws/stats?token=${TOKEN}`;
  statsWS = new WebSocket(wsUrl);

  statsWS.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.type !== 'stats') return;

    document.getElementById('cpu-val').textContent = d.cpu;
    document.getElementById('cpu-bar').style.width = d.cpu + '%';
    document.getElementById('cpu-bar').style.background = d.cpu > 80 ? 'var(--red)' : d.cpu > 60 ? 'var(--yellow)' : 'var(--accent)';

    document.getElementById('mem-val').textContent = d.memory.percent;
    document.getElementById('mem-bar').style.width = d.memory.percent + '%';
    document.getElementById('mem-detail').textContent = `${fmtBytes(d.memory.used)} / ${fmtBytes(d.memory.total)}`;

    document.getElementById('net-rx').textContent = fmtBytes(d.network.rx) + '/s';
    document.getElementById('net-tx').textContent = fmtBytes(d.network.tx) + '/s';
  };

  statsWS.onclose = () => setTimeout(connectStatsWS, 5000);
}

// ── Dashboard ─────────────────────────────────────────────────
async function loadDashboard() {
  const data = await req('GET', '/system/stats');
  if (!data) return;

  const mainDisk = data.disk.find(d => d.mount === '/') || data.disk[0];
  if (mainDisk) {
    document.getElementById('disk-val').textContent = Math.round(mainDisk.percent);
    document.getElementById('disk-bar').style.width = mainDisk.percent + '%';
    document.getElementById('disk-detail').textContent = `${fmtBytes(mainDisk.used)} / ${fmtBytes(mainDisk.size)}`;
  }

  const os = data.os;
  document.getElementById('server-hostname').textContent = os.hostname;
  document.getElementById('uptime-display').textContent = `↑ ${Math.floor(os.uptime / 3600)}h ${Math.floor((os.uptime % 3600) / 60)}m`;

  const osGrid = document.getElementById('os-info');
  const items = [
    { icon: 'ti-server', label: 'Hostname', value: os.hostname },
    { icon: 'ti-brand-ubuntu', label: 'Sistema', value: `${os.distro} ${os.release}` },
    { icon: 'ti-cpu', label: 'Arquitectura', value: os.arch },
    { icon: 'ti-clock', label: 'Uptime', value: `${Math.floor(os.uptime / 3600)}h ${Math.floor((os.uptime % 3600)/60)}m` },
  ];
  osGrid.innerHTML = items.map(i => `
    <div style="background:var(--bg-card2);border-radius:var(--radius-sm);padding:12px;border:1px solid var(--border)">
      <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;display:flex;align-items:center;gap:6px">
        <i class="ti ${i.icon}" style="font-size:14px;color:var(--accent)"></i>${i.label}
      </div>
      <div style="font-size:14px;font-weight:600">${i.value}</div>
    </div>
  `).join('');
}

// ── Services ──────────────────────────────────────────────────
async function loadServices() {
  const data = await req('GET', '/system/services');
  if (!data) return;
  const list = document.getElementById('services-list');
  const icons = { nginx: 'ti-layout', mysql: 'ti-database', postgresql: 'ti-elephant', redis: 'ti-bolt', ssh: 'ti-key' };
  list.innerHTML = data.map(s => `
    <div class="service-row">
      <div class="service-name">
        <i class="ti ${icons[s.name] || 'ti-server'}" style="color:var(--accent);font-size:16px"></i>
        ${esc(s.name.charAt(0).toUpperCase() + s.name.slice(1))}
      </div>
      <div style="display:flex;align-items:center;gap:8px">
        <span class="badge ${s.status === 'running' ? 'badge-green' : 'badge-red'}">${s.status === 'running' ? 'Activo' : 'Parado'}</span>
        <div class="service-actions">
          ${s.status === 'running'
            ? `<button class="btn btn-sm btn-danger" onclick="svcAction('${s.name}','stop')"><i class="ti ti-player-stop"></i></button>
               <button class="btn btn-sm" onclick="svcAction('${s.name}','restart')"><i class="ti ti-refresh"></i></button>`
            : `<button class="btn btn-sm btn-success" onclick="svcAction('${s.name}','start')"><i class="ti ti-player-play"></i></button>`}
        </div>
      </div>
    </div>
  `).join('');
}

async function svcAction(name, action) {
  toast(`${action} ${name}...`, 'info');
  const r = await req('POST', `/system/service/${name}/${action}`);
  if (r?.success) { toast(`${name} ${action} correcto`, 'success'); loadServices(); }
  else toast(r?.error || 'Error', 'error');
}

// ── Processes ─────────────────────────────────────────────────
async function loadProcesses() {
  const data = await req('GET', '/system/processes');
  if (!data) return;
  const tb = document.getElementById('procs-table');
  tb.innerHTML = data.slice(0,10).map(p => `
    <tr>
      <td style="color:var(--text-muted);font-family:var(--mono)">${p.pid}</td>
      <td style="font-weight:500">${esc(p.name)}</td>
      <td><span style="color:${p.cpu > 50 ? 'var(--red)' : p.cpu > 20 ? 'var(--yellow)' : 'var(--green)'}">${p.cpu.toFixed(1)}%</span></td>
      <td>${p.mem.toFixed(1)}%</td>
    </tr>
  `).join('');
}

// ── Websites ──────────────────────────────────────────────────
async function loadWebsites() {
  const data = await req('GET', '/websites');
  if (!data) return;
  const tb = document.getElementById('websites-table');
  if (!data.length) { tb.innerHTML = '<tr><td colspan="6" class="empty-state"><i class="ti ti-world-off"></i><br>Sin sitios web aún</td></tr>'; return; }
  tb.innerHTML = data.map(s => {
    const isPort = !!s.listen_port;
    const accessUrl = isPort ? `http://${serverIp || location.hostname}:${s.listen_port}` : `http://${s.domain}`;
    const domainLabel = isPort ? `${esc(s.domain)} <span style="font-size:11px;color:var(--cyan)">:${s.listen_port}</span>` : esc(s.domain);
    return `
    <tr>
      <td><span class="domain-pill">${domainLabel}</span></td>
      <td><span class="badge badge-purple">${esc(s.type)}${s.php_version ? ' '+esc(s.php_version) : ''}</span></td>
      <td>${isPort ? '<span class="badge badge-amber">IP:Puerto</span>' : s.ssl ? '<span class="badge badge-green">🔒 SSL</span>' : '<span class="badge badge-yellow">Sin SSL</span>'}</td>
      <td><span class="badge ${s.status === 'active' ? 'badge-green' : 'badge-red'}">${esc(s.status)}</span></td>
      <td style="color:var(--text-muted)">${fmtDate(s.created_at)}</td>
      <td>
        <div style="display:flex;gap:6px">
          <button class="btn btn-sm" onclick="window.open('${accessUrl}','_blank')" title="Abrir sitio"><i class="ti ti-external-link"></i> Abrir</button>
          <button class="btn btn-sm btn-danger" onclick="deleteWebsite(${s.id})" title="Eliminar sitio"><i class="ti ti-trash"></i> Eliminar</button>
        </div>
      </td>
    </tr>`;
  }).join('');

  document.getElementById('ssl-table').innerHTML = data.map(s => `
    <tr>
      <td><span class="domain-pill">${esc(s.domain)}</span></td>
      <td>${s.ssl ? '<span class="badge badge-green">🔒 Activo</span>' : '<span class="badge badge-yellow">Sin SSL</span>'}</td>
      <td>
        ${!s.ssl ? `<button class="btn btn-sm btn-primary" onclick="installSSL(${s.id})"><i class="ti ti-certificate"></i> Instalar SSL</button>` : '<span style="color:var(--text-muted);font-size:12px">Renovación automática</span>'}
      </td>
    </tr>
  `).join('');
}

function toggleSiteMode() {
  const mode = document.getElementById('site-mode').value;
  const label = document.getElementById('site-domain-label');
  const input = document.getElementById('site-domain');
  const hint = document.getElementById('site-domain-hint');
  const sslGroup = document.getElementById('site-ssl-group');
  if (mode === 'port') {
    label.textContent = 'Nombre del sitio';
    input.placeholder = 'mi-web';
    hint.textContent = 'Se asignará un puerto automáticamente. Accederás vía http://tu-ip:puerto';
    sslGroup.style.display = 'none';
  } else {
    label.textContent = 'Dominio';
    input.placeholder = 'ejemplo.com';
    hint.textContent = '';
    sslGroup.style.display = '';
  }
}

function togglePhpVersion() {
  const type = document.getElementById('site-type').value;
  document.getElementById('site-php-version-group').style.display = type === 'php' ? '' : 'none';
}

async function createWebsite() {
  const domain = document.getElementById('site-domain').value.trim();
  if (!domain) { toast('Introduce un dominio o nombre', 'error'); return; }
  const usePort = document.getElementById('site-mode').value === 'port';
  const type = document.getElementById('site-type').value;
  const phpVersion = type === 'php' ? document.getElementById('site-php-version').value : '';
  toast('Creando sitio web...', 'info');
  const r = await req('POST', '/websites', {
    domain, type, usePort, phpVersion: phpVersion || undefined,
    php: document.getElementById('site-php').checked,
    ssl: !usePort && document.getElementById('site-ssl').checked
  });
  if (r?.success) {
    const msg = r.port ? `Sitio creado. Accede en http://tu-ip:${r.port}` : `Sitio ${domain} creado`;
    toast(msg, 'success');
    closeModal('modal-new-site');
    loadWebsites();
  } else toast(r?.error || 'Error al crear sitio', 'error');
}

async function deleteWebsite(id) {
  if (!confirm('¿Eliminar este sitio web?')) return;
  const r = await req('DELETE', `/websites/${id}`);
  if (r?.success) { toast('Sitio eliminado', 'success'); loadWebsites(); }
  else toast(r?.error || 'Error', 'error');
}

async function installSSL(id) {
  toast('Instalando certificado SSL...', 'info');
  const r = await req('POST', `/websites/${id}/ssl`);
  if (r?.success) { toast('SSL instalado correctamente', 'success'); loadWebsites(); }
  else toast(r?.error || 'Error al instalar SSL', 'error');
}

// ── Apps ──────────────────────────────────────────────────────
async function loadApps() {
  const data = await req('GET', '/apps');
  if (!data) return;
  const tb = document.getElementById('apps-table');
  if (!data.length) { tb.innerHTML = '<tr><td colspan="6" class="empty-state"><i class="ti ti-brand-nodejs"></i><br>Sin aplicaciones aún</td></tr>'; return; }

  const typeColors = { nodejs:'badge-green', typescript:'badge-blue', react:'badge-blue', python:'badge-yellow' };
  tb.innerHTML = data.map(a => `
    <tr>
      <td style="font-weight:600">${esc(a.name)}</td>
      <td><span class="badge ${typeColors[a.type]||'badge-purple'}">${esc(a.type)}</span></td>
      <td style="font-family:var(--mono);color:var(--cyan)">${esc(a.port || '—')}</td>
      <td><span class="badge ${a.status==='running'?'badge-green':'badge-red'}">${esc(a.status)}</span></td>
      <td>${a.domain ? `<span class="domain-pill">${esc(a.domain)}</span>` : '—'}</td>
      <td>
        <div style="display:flex;gap:5px;flex-wrap:wrap">
          ${a.status==='running'
            ? `<button class="btn btn-sm btn-danger" onclick="appAction(${a.id},'stop')" title="Parar"><i class="ti ti-player-stop"></i> Parar</button>
               <button class="btn btn-sm" onclick="appAction(${a.id},'restart')" title="Reiniciar"><i class="ti ti-refresh"></i> Reiniciar</button>`
            : `<button class="btn btn-sm btn-success" onclick="appAction(${a.id},'start')" title="Iniciar"><i class="ti ti-player-play"></i> Iniciar</button>`}
          <button class="btn btn-sm" onclick="installApp(${a.id},'${esc(a.name)}')" title="Instalar dependencias"><i class="ti ti-package"></i> Instalar</button>
          <button class="btn btn-sm" onclick="openAppConsole(${a.id},'${esc(a.name)}')" title="Consola en la carpeta"><i class="ti ti-terminal-2"></i> Consola</button>
          <button class="btn btn-sm" onclick="viewAppLogs(${a.id},'${a.name}')" title="Logs"><i class="ti ti-file-text"></i> Logs</button>
          <button class="btn btn-sm btn-danger" onclick="appAction(${a.id},'delete')" title="Eliminar"><i class="ti ti-trash"></i> Eliminar</button>
        </div>
      </td>
    </tr>
  `).join('');
}

function updateAppPathPreview() {
  const name = document.getElementById('app-name').value.trim() || 'nombre-app';
  const base = document.getElementById('app-path').value.trim() || '/var/www';
  const preview = document.getElementById('app-path-preview');
  if (preview) preview.textContent = base.replace(/\/+$/, '') + '/' + name;
}

// ── Deploy por ZIP (estilo Hostinger) ─────────────────────────
let deployZipFile = null;
let deployEnvFile = null;

document.addEventListener('DOMContentLoaded', () => {
  const nameEl = document.getElementById('app-name');
  const pathEl = document.getElementById('app-path');
  if (nameEl) nameEl.addEventListener('input', updateAppPathPreview);
  if (pathEl) pathEl.addEventListener('input', updateAppPathPreview);
  setupDragDrop();
  setupDeployDrops();
});

function setupDeployDrops() {
  bindDeployDrop('deploy-zip-drop', 'deploy-zip', 'deploy-zip-label', (f) => { deployZipFile = f; });
  bindDeployDrop('deploy-env-drop', 'deploy-env', 'deploy-env-label', (f) => { deployEnvFile = f; });
}

function bindDeployDrop(zoneId, inputId, labelId, setFile) {
  const zone = document.getElementById(zoneId);
  const input = document.getElementById(inputId);
  if (!zone || !input) return;
  const label = document.getElementById(labelId);
  const accept = (f) => { setFile(f); label.textContent = f.name; zone.classList.add('has-file'); };

  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { if (input.files[0]) accept(input.files[0]); });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault(); zone.classList.remove('dragover');
    const f = e.dataTransfer.files[0];
    if (f) accept(f);
  });
}

function deployLog(msg) {
  const el = document.getElementById('deploy-log');
  el.textContent += msg + '\n';
  el.scrollTop = el.scrollHeight;
}

function renderDeploySteps(steps) {
  document.getElementById('deploy-steps').innerHTML = steps.map((s) => {
    const icon = s.state === 'ok' ? 'ti-circle-check' : s.state === 'err' ? 'ti-circle-x'
      : s.state === 'active' ? 'ti-loader-2' : 'ti-circle';
    return `<div class="deploy-step ${s.state}"><i class="ti ${icon}"></i> ${esc(s.label)}</div>`;
  }).join('');
}

async function startDeploy() {
  const name = document.getElementById('app-name').value.trim();
  const basePath = document.getElementById('app-path').value.trim() || '/var/www';
  const port = document.getElementById('app-port').value.trim();
  const domain = document.getElementById('app-domain').value.trim();

  if (!name) { toast('El nombre es obligatorio', 'error'); return; }
  if (!deployZipFile) { toast('Sube el .zip de tu proyecto', 'error'); return; }

  // Cambia a la vista de progreso
  document.getElementById('deploy-form').style.display = 'none';
  document.getElementById('deploy-progress').style.display = 'block';
  document.getElementById('deploy-start-btn').style.display = 'none';
  document.getElementById('deploy-cancel-btn').style.display = 'none';
  document.getElementById('deploy-log').textContent = '';

  const steps = [
    { key: 'create',  label: 'Crear aplicación',       state: 'pending' },
    { key: 'upload',  label: 'Subir archivos',          state: 'pending' },
    { key: 'extract', label: 'Extraer y detectar',      state: 'pending' },
    { key: 'install', label: 'Instalar dependencias',   state: 'pending' },
    { key: 'build',   label: 'Compilar (build)',        state: 'pending' },
    { key: 'start',   label: 'Arrancar aplicación',     state: 'pending' },
    { key: 'proxy',   label: 'Configurar acceso',       state: 'pending' },
  ];
  renderDeploySteps(steps);
  const setStep = (key, state) => { steps.find((s) => s.key === key).state = state; renderDeploySteps(steps); };

  let createdId = null;
  const finish = async (success) => {
    if (!success && createdId) {
      // Rollback: el servidor borra la carpeta y todos los archivos subidos
      deployLog('\n↩ Despliegue fallido. Limpiando: se elimina la carpeta y los archivos creados...');
      await req('DELETE', `/apps/${createdId}`);
      deployLog('✓ Limpieza completada. No quedó nada en el servidor.');
    }
    document.getElementById('deploy-done-btn').style.display = 'inline-flex';
    if (!success) return;
    const host = serverIp || location.hostname;
    deployLog('\n✅ Deploy completado. Accede a tu app desde:');
    if (port) deployLog(`   • IP:    http://${host}:${port}`);
    if (domain) deployLog(`   • Dominio: http://${domain}  (apunta el DNS del dominio a ${host})`);
  };

  try {
    // 1. Crear
    setStep('create', 'active'); deployLog('▶ Creando aplicación...');
    const created = await req('POST', '/apps', { name, path: basePath, port, domain });
    if (!created?.success) { setStep('create', 'err'); deployLog('✖ ' + (created?.error || 'Error')); return finish(false); }
    const id = created.id;
    createdId = id;
    setStep('create', 'ok'); deployLog('✓ Carpeta: ' + created.path);

    // 2. Subir
    setStep('upload', 'active'); deployLog('\n▶ Subiendo ' + deployZipFile.name + '...');
    const up = await uploadBinary(deployZipFile, created.path + '/' + deployZipFile.name);
    if (!up?.success) { setStep('upload', 'err'); deployLog('✖ Falló la subida del zip'); return finish(false); }
    if (deployEnvFile) {
      deployLog('▶ Subiendo .env...');
      await uploadBinary(deployEnvFile, created.path + '/.env');
    }
    setStep('upload', 'ok'); deployLog('✓ Archivos subidos');

    // 3. Extraer + detectar
    setStep('extract', 'active'); deployLog('\n▶ Extrayendo...');
    const ext = await req('POST', `/apps/${id}/extract`);
    if (!ext?.success) { setStep('extract', 'err'); deployLog('✖ ' + (ext?.error || 'Error al extraer')); return finish(false); }
    setStep('extract', 'ok'); deployLog(ext.output || '');

    // 4. Instalar
    setStep('install', 'active'); deployLog('\n▶ Instalando dependencias...');
    const ins = await req('POST', `/apps/${id}/install`);
    deployLog(ins?.output || '');
    if (!ins?.ok && !ins?.skipped) { setStep('install', 'err'); deployLog('✖ Falló la instalación'); return finish(false); }
    setStep('install', 'ok');

    // 5. Build
    setStep('build', 'active'); deployLog('\n▶ Compilando...');
    const bld = await req('POST', `/apps/${id}/build`);
    deployLog(bld?.output || '');
    if (!bld?.ok && !bld?.skipped) { setStep('build', 'err'); deployLog('✖ Falló el build'); return finish(false); }
    setStep('build', 'ok');

    // 6. Arrancar
    setStep('start', 'active'); deployLog('\n▶ Arrancando...');
    const st = await req('POST', `/apps/${id}/start`);
    if (!st?.success) { setStep('start', 'err'); deployLog('✖ ' + (st?.error || 'No arrancó')); return finish(false); }
    setStep('start', 'ok'); deployLog('✓ Aplicación en marcha');

    // 7. Configurar acceso (puerto + proxy de dominio) — no crítico
    setStep('proxy', 'active'); deployLog('\n▶ Configurando acceso...');
    const px = await req('POST', `/apps/${id}/proxy`);
    if (px?.success) { setStep('proxy', 'ok'); deployLog(px.output || ''); }
    else { setStep('proxy', 'err'); deployLog('✖ ' + (px?.error || 'No se pudo configurar el acceso')); }

    toast(`App "${name}" desplegada`, 'success');
    await finish(true);
  } catch (e) {
    deployLog('✖ Error inesperado: ' + (e?.message || e));
    await finish(false);
  }
}

function resetDeployModal() {
  deployZipFile = null;
  deployEnvFile = null;
  document.getElementById('deploy-form').style.display = 'block';
  document.getElementById('deploy-progress').style.display = 'none';
  document.getElementById('deploy-start-btn').style.display = 'inline-flex';
  document.getElementById('deploy-cancel-btn').style.display = 'inline-flex';
  document.getElementById('deploy-done-btn').style.display = 'none';
  ['app-name', 'app-port', 'app-domain'].forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
  document.getElementById('app-path').value = '/var/www';
  ['deploy-zip', 'deploy-env'].forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
  document.getElementById('deploy-zip-label').textContent = 'Arrastra el .zip o haz clic';
  document.getElementById('deploy-env-label').textContent = 'Arrastra tu .env o haz clic';
  document.getElementById('deploy-zip-drop').classList.remove('has-file');
  document.getElementById('deploy-env-drop').classList.remove('has-file');
}

async function appAction(id, action) {
  if (action === 'delete' && !confirm('⚠ Se eliminará la aplicación Y TODOS sus archivos de forma permanente (carpeta, código, proxy y puerto). Esta acción no se puede deshacer.\n\n¿Continuar?')) return;
  const labels = { start: 'iniciada', stop: 'detenida', restart: 'reiniciada', delete: 'eliminada' };
  const r = await req('POST', `/apps/${id}/${action}`);
  if (r?.success) { toast(`App ${labels[action] || action}`, 'success'); loadApps(); }
  else toast(r?.error || 'Error', 'error');
}

async function viewAppLogs(id, name) {
  const r = await req('GET', `/apps/${id}/logs`);
  document.getElementById('log-output').textContent = r?.logs || 'Sin logs';
  navigate(document.querySelector('[data-page=logs]'));
}

// ── Consola de la app ─────────────────────────────────────────
let consoleAppId = null;

function openAppConsole(id, name) {
  consoleAppId = id;
  document.getElementById('console-app-name').textContent = name;
  document.getElementById('console-output').textContent = 'Listo. Escribe un comando (ej: npm install, ls -la, npm run build) y pulsa Ejecutar.\n';
  document.getElementById('console-cmd').value = '';
  openModal('modal-app-console');
  setTimeout(() => document.getElementById('console-cmd').focus(), 100);
}

async function runAppCommand() {
  if (!consoleAppId) return;
  const input = document.getElementById('console-cmd');
  const command = input.value.trim();
  if (!command) return;
  const out = document.getElementById('console-output');
  out.textContent += `\n$ ${command}\n`;
  out.scrollTop = out.scrollHeight;
  input.value = '';
  input.disabled = true;

  const r = await req('POST', `/apps/${consoleAppId}/exec`, { command });
  if (r?.success) {
    out.textContent += (r.output || '') + '\n';
  } else {
    out.textContent += `Error: ${r?.error || 'fallo al ejecutar'}\n`;
  }
  out.scrollTop = out.scrollHeight;
  input.disabled = false;
  input.focus();
}

function consoleKeydown(e) {
  if (e.key === 'Enter') { e.preventDefault(); runAppCommand(); }
}

async function installApp(id, name) {
  toast(`Instalando dependencias de "${name}"...`, 'info');
  const r = await req('POST', `/apps/${id}/install`);
  if (r?.success) {
    consoleAppId = id;
    document.getElementById('console-app-name').textContent = name;
    document.getElementById('console-output').textContent = `$ ${r.command || 'install'}\n${r.output || ''}\n`;
    document.getElementById('console-cmd').value = '';
    openModal('modal-app-console');
    document.getElementById('console-output').scrollTop = document.getElementById('console-output').scrollHeight;
    toast(r.ok ? 'Dependencias instaladas' : 'Instalación terminó con errores (revisa la consola)', r.ok ? 'success' : 'error');
  } else {
    toast(r?.error || 'Error al instalar', 'error');
  }
}

// ── Databases ─────────────────────────────────────────────────
let dbPassCache = {};

async function loadDatabases() {
  const data = await req('GET', '/databases');
  if (!data) return;
  dbPassCache = {};
  const tb = document.getElementById('databases-table');
  if (!data.length) { tb.innerHTML = '<tr><td colspan="6" class="empty-state"><i class="ti ti-database-off"></i><br>Sin bases de datos</td></tr>'; return; }
  tb.innerHTML = data.map(d => {
    dbPassCache[d.id] = d.db_password;
    return `
    <tr>
      <td style="font-weight:600;font-family:var(--mono)">${esc(d.name)}</td>
      <td><span class="badge ${d.type==='mysql'?'badge-blue':'badge-purple'}">${esc(d.type)}</span></td>
      <td style="font-family:var(--mono);font-size:12px">${esc(d.db_user)}</td>
      <td><span class="badge badge-green">${esc(d.status)}</span></td>
      <td style="color:var(--text-muted)">${fmtDate(d.created_at)}</td>
      <td>
        <button class="btn btn-sm" onclick="copyDbPass(${d.id})" title="Copiar contraseña"><i class="ti ti-copy"></i></button>
      </td>
    </tr>
  `;}).join('');
}

function copyDbPass(id) {
  const pass = dbPassCache[id];
  if (pass) copyText(pass);
  else toast('Contraseña no disponible', 'error');
}

async function createDatabase() {
  const name = document.getElementById('db-name').value.trim();
  if (!name) { toast('Nombre de BD requerido', 'error'); return; }
  toast('Creando base de datos...', 'info');
  const r = await req('POST', '/databases', {
    type: document.getElementById('db-type').value, name,
    user: document.getElementById('db-user').value,
    password: document.getElementById('db-pass').value
  });
  if (r?.success) {
    toast(`BD ${name} creada. Usuario: ${r.user}`, 'success');
    closeModal('modal-new-db'); loadDatabases();
  } else toast(r?.error || 'Error', 'error');
}

// ── Files ─────────────────────────────────────────────────────
let currentFilePath = '/';

async function loadFiles() {
  const path = currentFilePath;
  const data = await req('GET', `/files?path=${encodeURIComponent(path)}`);
  if (!data) { toast('Error cargando directorio', 'error'); return; }

  updateBreadcrumb(path);
  const tb = document.getElementById('files-table');
  const items = data.items || [];

  if (!items.length) {
    tb.innerHTML = '<tr><td colspan="5" style="padding:2rem;text-align:center;color:var(--text-muted)"><i class="ti ti-inbox"></i> Directorio vacío</td></tr>';
    return;
  }

  let itemsHtml = items.map(f => {
    const icon = f.type === 'directory' ? 'ti-folder' : getFileIcon(f.name);
    const onClick = f.type === 'directory' ? `onclick="browseDir('${esc(f.path)}')"` : '';
    const style = f.type === 'directory' ? 'cursor:pointer;color:var(--accent)' : '';
    const isArchive = /\.(zip|tar\.gz|tgz|tar)$/i.test(f.name);
    return `
      <tr>
        <td style="width:40px"><i class="ti ${icon}" style="font-size:16px;opacity:0.7"></i></td>
        <td><span ${onClick} style="${style};display:inline-block;${f.type === 'directory' ? 'text-decoration:underline' : ''}">${esc(f.name)}</span></td>
        <td>${f.type === 'file' ? fmtBytes(f.size) : '—'}</td>
        <td style="color:var(--text-muted)">${fmtDate(f.modified)}</td>
        <td>
          <div style="display:flex;gap:5px;justify-content:flex-end">
            ${isArchive ? `<button class="btn btn-sm btn-success" onclick="extractFile('${esc(f.path)}')" title="Extraer aquí"><i class="ti ti-file-zip"></i></button>` : ''}
            ${f.type === 'file' && !isArchive ? `<button class="btn btn-sm" onclick="editFile('${esc(f.path)}')" title="Editar"><i class="ti ti-edit"></i></button>` : ''}
            <button class="btn btn-sm btn-danger" onclick="deleteFile('${esc(f.path)}')" title="Eliminar"><i class="ti ti-trash"></i></button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  if (path !== '/') {
    const parentPath = path.substring(0, path.lastIndexOf('/')) || '/';
    itemsHtml = `
      <tr>
        <td style="width:40px"><i class="ti ti-arrow-up" style="font-size:16px;opacity:0.7"></i></td>
        <td colspan="4"><span onclick="browseDir('${esc(parentPath)}')" style="cursor:pointer;color:var(--accent);text-decoration:underline">.. (Volver arriba)</span></td>
      </tr>
    ` + itemsHtml;
  }

  tb.innerHTML = itemsHtml;
  setupDragDrop();
}

function updateBreadcrumb(path) {
  if (path === '/') {
    document.getElementById('file-breadcrumb').innerHTML = '<span style="color:var(--text-muted)">/</span>';
    return;
  }

  const parts = path.split('/').filter(p => p);
  const crumbs = parts.map((part, i) => {
    const subPath = '/' + parts.slice(0, i + 1).join('/');
    return `<a href="#" onclick="event.preventDefault();browseDir('${subPath}')" style="color:var(--accent);text-decoration:none;cursor:pointer">${esc(part)}</a>`;
  }).join(' <span style="color:var(--text-muted)">/</span> ');
  document.getElementById('file-breadcrumb').innerHTML = `<a href="#" onclick="event.preventDefault();browseDir('/')" style="color:var(--text-muted);text-decoration:none;cursor:pointer">/</a> <span style="color:var(--text-muted)">/</span> ${crumbs}`;
}

function getFileIcon(filename) {
  const ext = filename.split('.').pop().toLowerCase();
  const iconMap = {
    'html': 'ti-file-type-html', 'css': 'ti-file-type-css', 'js': 'ti-file-type-js',
    'json': 'ti-file-type-json', 'php': 'ti-file-type-php', 'py': 'ti-file-type-python',
    'txt': 'ti-file-type-txt', 'pdf': 'ti-file-type-pdf', 'zip': 'ti-file-type-zip',
    'jpg': 'ti-file-type-jpg', 'png': 'ti-file-type-png', 'gif': 'ti-file-type-gif'
  };
  return iconMap[ext] || 'ti-file';
}

let dragDropBound = false;
function setupDragDrop() {
  const zone = document.getElementById('drop-zone');
  if (!zone || dragDropBound) return;
  dragDropBound = true;

  // Evita que el navegador abra el archivo al soltarlo fuera de la zona exacta
  ['dragover', 'drop'].forEach(ev => {
    window.addEventListener(ev, (e) => { e.preventDefault(); }, false);
  });

  zone.addEventListener('dragenter', (e) => {
    e.preventDefault(); e.stopPropagation();
    zone.style.background = 'var(--accent-glow)';
    zone.style.borderColor = 'var(--accent)';
  });
  zone.addEventListener('dragover', (e) => {
    e.preventDefault(); e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    zone.style.background = 'var(--accent-glow)';
    zone.style.borderColor = 'var(--accent)';
  });
  zone.addEventListener('dragleave', (e) => {
    e.preventDefault(); e.stopPropagation();
    zone.style.background = 'var(--bg-card2)';
    zone.style.borderColor = 'var(--border)';
  });
  zone.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation();
    zone.style.background = 'var(--bg-card2)';
    zone.style.borderColor = 'var(--border)';
    handleDrop(e);
  });
  zone.addEventListener('click', () => document.getElementById('file-upload').click());
}

function handleDrop(e) {
  const dt = e.dataTransfer;
  if (!dt) return;

  // IMPORTANTE: las entries deben leerse de forma síncrona dentro del handler
  const entries = [];
  if (dt.items && dt.items.length) {
    for (let i = 0; i < dt.items.length; i++) {
      const item = dt.items[i];
      if (item.kind && item.kind !== 'file') continue;
      const entry = item.webkitGetAsEntry ? item.webkitGetAsEntry()
                  : (item.getAsEntry ? item.getAsEntry() : null);
      if (entry) entries.push(entry);
    }
  }

  if (entries.length > 0) {
    processEntries(entries);
  } else if (dt.files && dt.files.length > 0) {
    // Fallback: el navegador no soporta entries de directorio
    uploadFlatFiles(dt.files);
  } else {
    toast('No se detectaron archivos. Prueba con otro navegador (Chrome/Edge).', 'error');
  }
}

function handleFileUpload(e) {
  uploadFlatFiles(e.target.files);
  e.target.value = '';
}

function showProgress(done, total, currentName) {
  const wrap = document.getElementById('upload-progress');
  const bar = document.getElementById('upload-bar');
  const pct = document.getElementById('upload-percent');
  const status = document.getElementById('upload-status');
  const detail = document.getElementById('upload-detail');
  if (!wrap) return;
  wrap.style.display = 'block';
  const p = total > 0 ? Math.round((done / total) * 100) : 0;
  bar.style.width = p + '%';
  pct.textContent = p + '%';
  status.textContent = done < total ? `Subiendo: ${currentName}` : 'Completado';
  detail.textContent = `${done} / ${total} archivos`;
}

function hideProgress() {
  const wrap = document.getElementById('upload-progress');
  if (wrap) setTimeout(() => { wrap.style.display = 'none'; }, 3000);
}

function readEntryAsFile(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

function readDirEntries(reader) {
  return new Promise((resolve, reject) => {
    const all = [];
    (function batch() {
      reader.readEntries(results => {
        if (!results.length) return resolve(all);
        all.push(...results);
        batch();
      }, reject);
    })();
  });
}

async function flattenEntry(entry, basePath) {
  const list = [];
  if (entry.isFile) {
    list.push({ entry, destPath: basePath + '/' + entry.name, isDir: false });
  } else if (entry.isDirectory) {
    const dirPath = basePath + '/' + entry.name;
    list.push({ destPath: dirPath, isDir: true });
    const reader = entry.createReader();
    const children = await readDirEntries(reader);
    for (const child of children) {
      const sub = await flattenEntry(child, dirPath);
      list.push(...sub);
    }
  }
  return list;
}

// Sube un archivo por streaming binario (sin base64, sin límite de JSON)
async function uploadBinary(file, destPath) {
  const r = await fetch(API + '/api/files/upload?path=' + encodeURIComponent(destPath), {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  if (r.status === 401) { doLogout(); return { success: false }; }
  try { return await r.json(); } catch (_) { return { success: r.ok }; }
}

async function processEntries(entries) {
  const allItems = [];
  for (const entry of entries) {
    allItems.push(...await flattenEntry(entry, currentFilePath));
  }
  const fileItems = allItems.filter(i => !i.isDir);
  const total = fileItems.length;
  if (total === 0) { toast('La carpeta está vacía', 'error'); return; }

  let done = 0, errors = 0;
  showProgress(0, total, '');

  for (const item of allItems) {
    if (item.isDir) {
      await req('POST', '/files/mkdir', { path: item.destPath });
      continue;
    }
    try {
      const file = await readEntryAsFile(item.entry);
      showProgress(done, total, file.name);
      const r = await uploadBinary(file, item.destPath);
      if (r?.success) done++;
      else errors++;
    } catch (_) { errors++; }
    showProgress(done, total, '');
  }

  showProgress(total, total, '');
  hideProgress();
  if (errors === 0) toast(`${done} archivo${done > 1 ? 's' : ''} subido${done > 1 ? 's' : ''}`, 'success');
  else toast(`${done} subidos, ${errors} fallidos`, 'error');
  loadFiles();
}

async function uploadFlatFiles(fileList) {
  const files = Array.from(fileList);
  const total = files.length;
  if (total === 0) return;

  let done = 0, errors = 0;
  showProgress(0, total, '');

  for (const file of files) {
    try {
      showProgress(done, total, file.name);
      const r = await uploadBinary(file, currentFilePath + '/' + file.name);
      if (r?.success) done++;
      else errors++;
    } catch (_) { errors++; }
    showProgress(done, total, '');
  }

  showProgress(total, total, '');
  hideProgress();
  if (errors === 0) toast(`${done} archivo${done > 1 ? 's' : ''} subido${done > 1 ? 's' : ''}`, 'success');
  else toast(`${done} subidos, ${errors} fallidos`, 'error');
  loadFiles();
}

async function createFolder() {
  const name = document.getElementById('folder-name').value.trim();
  if (!name) { toast('Nombre requerido', 'error'); return; }
  const path = currentFilePath + '/' + name;
  const r = await req('POST', '/files/mkdir', { path });
  if (r?.success) { toast('Carpeta creada', 'success'); closeModal('modal-new-folder'); loadFiles(); }
  else toast(r?.error || 'Error', 'error');
}

async function createFile() {
  const name = document.getElementById('file-name').value.trim();
  if (!name) { toast('Nombre requerido', 'error'); return; }
  const path = currentFilePath + '/' + name;
  const r = await req('POST', '/files/write', { path, content: '' });
  if (r?.success) { toast('Archivo creado', 'success'); closeModal('modal-new-file'); loadFiles(); }
  else toast(r?.error || 'Error', 'error');
}

function browseDir(path) {
  currentFilePath = path;
  loadFiles();
}

async function deleteFile(path) {
  const name = path.split('/').pop();
  if (!confirm(`¿Eliminar "${name}"?`)) return;
  const r = await req('DELETE', '/files', { path });
  if (r?.success) { toast('Eliminado', 'success'); loadFiles(); }
  else toast(r?.error || 'Error', 'error');
}

async function extractFile(path) {
  const name = path.split('/').pop();
  if (!confirm(`¿Extraer "${name}" en esta carpeta?`)) return;
  toast(`Extrayendo ${name}...`, 'info');
  const r = await req('POST', '/files/extract', { path });
  if (r?.success) { toast('Archivo extraído', 'success'); loadFiles(); }
  else toast(r?.error || 'Error al extraer', 'error');
}

async function editFile(path) {
  const name = path.split('/').pop();
  const r = await req('GET', `/files/read?path=${encodeURIComponent(path)}`);
  if (!r?.content && r?.content !== '') { toast('No se pudo leer el archivo', 'error'); return; }

  const modal = document.createElement('div');
  modal.className = 'modal-overlay open';
  modal.id = 'modal-edit-file';
  modal.dataset.dynamic = 'true';
  modal.innerHTML = `
    <div class="modal" style="width:90%;max-width:900px;max-height:90vh;display:flex;flex-direction:column">
      <div class="modal-header">
        <div class="modal-title"><i class="ti ti-edit" style="color:var(--accent)"></i> Editar: ${esc(name)}</div>
        <button class="btn btn-sm" onclick="closeModal('modal-edit-file')"><i class="ti ti-x"></i></button>
      </div>
      <div style="flex:1;overflow:hidden;padding:1rem;border-top:1px solid var(--border);border-bottom:1px solid var(--border)">
        <textarea id="file-editor" style="width:100%;height:100%;background:var(--bg-app);color:var(--text-primary);border:1px solid var(--border);border-radius:var(--radius);padding:12px;font-family:var(--mono);font-size:13px;resize:none;outline:none">${esc(r.content)}</textarea>
      </div>
      <div class="modal-footer">
        <button class="btn" onclick="closeModal('modal-edit-file')">Cancelar</button>
        <button class="btn btn-primary" onclick="saveFile('${esc(path)}')"><i class="ti ti-check"></i> Guardar</button>
      </div>
    </div>
  `;
  modal.addEventListener('click', e => { if (e.target === modal) closeModal('modal-edit-file'); });
  document.body.appendChild(modal);
}

async function saveFile(path) {
  const content = document.getElementById('file-editor').value;
  const r = await req('POST', '/files/write', { path, content });
  if (r?.success) { toast('Guardado', 'success'); closeModal('modal-edit-file'); loadFiles(); }
  else toast(r?.error || 'Error', 'error');
}

// ── Firewall ──────────────────────────────────────────────────
async function loadFirewall() {
  const data = await req('GET', '/firewall');
  if (!data) return;
  document.getElementById('ufw-status').className = `badge ${data.enabled ? 'badge-green' : 'badge-red'}`;
  document.getElementById('ufw-status').textContent = data.enabled ? 'Activo' : 'Inactivo';

  const tb = document.getElementById('firewall-table');
  const rules = (data.rules || []).filter(r => r.num);
  if (!rules.length) { tb.innerHTML = '<tr><td colspan="5" class="empty-state">Sin reglas</td></tr>'; return; }
  tb.innerHTML = rules.map(r => `
    <tr>
      <td style="color:var(--text-muted);font-family:var(--mono)">${r.num}</td>
      <td style="font-weight:500">${esc(r.to)}</td>
      <td><span class="badge ${r.action==='ALLOW'?'badge-green':'badge-red'}">${esc(r.action)}</span></td>
      <td style="color:var(--text-muted)">${esc(r.from || 'Anywhere')}</td>
      <td><button class="btn btn-sm btn-danger" onclick="deleteRule(${r.num})"><i class="ti ti-trash"></i></button></td>
    </tr>
  `).join('');
}

async function createRule() {
  const r = await req('POST', '/firewall/rule', {
    action: document.getElementById('rule-action').value,
    port: document.getElementById('rule-port').value,
    protocol: document.getElementById('rule-proto').value,
    from: document.getElementById('rule-from').value
  });
  if (r?.success) { toast('Regla añadida', 'success'); closeModal('modal-new-rule'); loadFirewall(); }
  else toast(r?.error || 'Error', 'error');
}

async function deleteRule(num) {
  if (!confirm('¿Eliminar esta regla?')) return;
  const r = await req('DELETE', `/firewall/rule/${num}`);
  if (r?.success) { toast('Regla eliminada', 'success'); loadFirewall(); }
  else toast(r?.error || 'Error', 'error');
}

// ── SSL ───────────────────────────────────────────────────────
async function loadSSL() {
  await loadWebsites();
}

// ── Settings ──────────────────────────────────────────────────
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
}

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

// ── Logs ──────────────────────────────────────────────────────
async function loadLog(type, el) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  if (el) el.classList.add('active');
  const r = await req('GET', `/logs/${type}`);
  document.getElementById('log-output').textContent = r?.logs || 'Log no disponible';
  const logEl = document.getElementById('log-output');
  logEl.scrollTop = logEl.scrollHeight;
}

// ── Terminal (xterm.js) ──────────────────────────────────────
let term = null, fitAddon = null, termWS = null;

function sendResize() {
  if (term && termWS && termWS.readyState === 1) {
    termWS.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
  }
}
function termResizeHandler() {
  if (!fitAddon) return;
  try { fitAddon.fit(); sendResize(); } catch (_) {}
}
function termCleanup() {
  window.removeEventListener('resize', termResizeHandler);
  if (termWS) { try { termWS.close(); } catch (_) {} termWS = null; }
  if (term) { try { term.dispose(); } catch (_) {} term = null; fitAddon = null; }
}

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
        <span class="badge ${p.installed ? 'badge-green' : ''}" style="margin-left:auto">${p.installed ? 'Instalado' : 'No instalado'}</span>
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

async function installPlugin(id, name) {
  if (!confirm(`¿Instalar ${name}? Esto puede tardar unos minutos.`)) return;
  toast(`Instalando ${name}... esto puede tardar unos minutos`, 'info');
  const r = await req('POST', `/plugins/${id}/install`);
  if (r?.success) { toast(r.message || `${name} instalado`, 'success'); loadPlugins(); }
  else toast(r?.error || `Error instalando ${name}`, 'error');
}

async function uninstallPlugin(id, name) {
  if (!confirm(`¿Desinstalar ${name}?`)) return;
  toast(`Desinstalando ${name}...`, 'info');
  const r = await req('POST', `/plugins/${id}/uninstall`);
  if (r?.success) { toast(r.message || `${name} desinstalado`, 'success'); loadPlugins(); }
  else toast(r?.error || `Error desinstalando ${name}`, 'error');
}

// ── Utils ─────────────────────────────────────────────────────
function copyText(text) {
  navigator.clipboard.writeText(text).then(() => toast('Copiado al portapapeles', 'success'));
}

// ── Init ──────────────────────────────────────────────────────
checkAuth();

setInterval(() => {
  if (currentPage === 'dashboard') { loadServices(); loadProcesses(); }
}, 30000);
