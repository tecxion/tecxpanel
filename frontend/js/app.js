// ════════════════════════════════════════════════════════════
//  TecXPaneL — Lógica del frontend (JavaScript "vanilla", sin frameworks)
//
//  Este único archivo controla toda la interfaz del panel: login,
//  navegación entre páginas, y la lógica de cada sección (sitios,
//  apps, bases de datos, Docker, archivos, firewall, etc.).
//  Se comunica con el backend mediante la función req() (API REST)
//  y WebSockets para los datos en tiempo real.
// ════════════════════════════════════════════════════════════

// Variables globales del estado de la app:
const API = window.location.origin;                  // URL base del panel
let TOKEN = localStorage.getItem('txpl_token') || ''; // token JWT guardado en el navegador
let statsWS = null;                                   // conexión WebSocket de estadísticas
let currentPage = 'dashboard';                        // página visible actualmente
let serverIp = '';                                    // IP pública del servidor (se carga al entrar)

// ── Helpers (funciones de apoyo usadas en toda la app) ────────

// req: hace una petición a la API REST con el token JWT incluido.
//  - method: 'GET' | 'POST' | 'DELETE'...   - path: ruta tras /api (ej. '/websites').
//  - body: objeto que se envía como JSON (opcional).
// Si el servidor responde 401 (no autorizado), cierra la sesión automáticamente.
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

// toast: muestra un mensajito flotante (verde/rojo/azul) que desaparece a los 3,5 s.
function toast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${type} show`;
  setTimeout(() => el.classList.remove('show'), 3500);
}

// fmtBytes: convierte un número de bytes en algo legible (ej. 1536 → "1.5 KB").
function fmtBytes(b) {
  if (!b || b === 0) return '0 B';
  const k = 1024, sz = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(b) / Math.log(k));
  return (b / Math.pow(k, i)).toFixed(1) + ' ' + sz[i];
}

// fmtDate: formatea una fecha al estilo español (ej. "15 jun 2026"), o "—" si no hay.
function fmtDate(d) {
  return d ? new Date(d).toLocaleDateString('es-ES', {day:'2-digit',month:'short',year:'numeric'}) : '—';
}

// esc: "escapa" caracteres peligrosos (< > & " ') antes de meter texto en el HTML.
// Es la defensa contra XSS: evita que datos del usuario se interpreten como código.
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]
  ));
}

// openModal / closeModal: muestran u ocultan una ventana modal por su id.
// (Las modales "dynamic" se eliminan del DOM al cerrarse.)
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

// Cerrar la modal al hacer clic fuera de ella (en el fondo oscuro) se vincula dinámicamente en bootApp

// ── Auth ──────────────────────────────────────────────────────
// doLogin: envía usuario+contraseña al backend. Si hay token, lo guarda y entra
// al panel; si el backend pide 2FA, muestra el campo del código.
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

// togglePassVis: muestra/oculta la contraseña del campo hermano (icono del ojo).
function togglePassVis(btn) {
  const input = btn.parentElement.querySelector('input');
  const icon = btn.querySelector('i');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  icon.className = show ? 'ti ti-eye-off' : 'ti ti-eye';
}

document.getElementById('login-pass').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});

document.getElementById('reset-username').addEventListener('keydown', e => {
  if (e.key === 'Enter') fetchSecurityQuestion();
});
['reset-answer', 'reset-email', 'reset-new-pass'].forEach(id => {
  document.getElementById(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') submitResetPassword();
  });
});

// showForgotPasswordForm: cambia del formulario de login al de recuperación.
function showForgotPasswordForm(e) {
  if (e) e.preventDefault();
  document.getElementById('login-box').style.display = 'none';
  document.getElementById('reset-box').style.display = 'block';
  document.getElementById('reset-step-1').style.display = 'block';
  document.getElementById('reset-step-2').style.display = 'none';
  
  // Clear inputs
  document.getElementById('reset-username').value = '';
  document.getElementById('reset-answer').value = '';
  document.getElementById('reset-email').value = '';
  document.getElementById('reset-new-pass').value = '';
  
  // Clear errors/success
  const errEl = document.getElementById('reset-error');
  errEl.style.display = 'none';
  errEl.textContent = '';
  const succEl = document.getElementById('reset-success');
  succEl.style.display = 'none';
  succEl.textContent = '';
}

// showLoginForm: vuelve del formulario de recuperación al de login.
function showLoginForm(e) {
  if (e) e.preventDefault();
  document.getElementById('login-box').style.display = 'block';
  document.getElementById('reset-box').style.display = 'none';
  document.getElementById('login-error').style.display = 'none';
}

// fetchSecurityQuestion: pide al backend la pregunta de seguridad del usuario
// (paso 1 de la recuperación de contraseña).
async function fetchSecurityQuestion() {
  const username = document.getElementById('reset-username').value.trim();
  const errEl = document.getElementById('reset-error');
  errEl.style.display = 'none';
  errEl.textContent = '';

  if (!username) {
    errEl.textContent = 'Introduce el nombre de usuario';
    errEl.style.display = 'block';
    return;
  }

  try {
    const data = await fetch(`${API}/api/auth/reset-question?username=${encodeURIComponent(username)}`)
      .then(r => r.json());

    if (data.question) {
      document.getElementById('reset-question-text').textContent = data.question;
      document.getElementById('reset-step-1').style.display = 'none';
      document.getElementById('reset-step-2').style.display = 'block';
    } else {
      errEl.textContent = data.error || 'Usuario no encontrado o pregunta no configurada';
      errEl.style.display = 'block';
    }
  } catch (err) {
    errEl.textContent = 'Error de conexión con el servidor';
    errEl.style.display = 'block';
  }
}

// submitResetPassword: envía respuesta + email + nueva contraseña para
// restablecerla (paso 2 de la recuperación).
async function submitResetPassword() {
  const username = document.getElementById('reset-username').value.trim();
  const answer = document.getElementById('reset-answer').value.trim();
  const email = document.getElementById('reset-email').value.trim();
  const newPassword = document.getElementById('reset-new-pass').value;
  const errEl = document.getElementById('reset-error');
  const succEl = document.getElementById('reset-success');

  errEl.style.display = 'none';
  errEl.textContent = '';
  succEl.style.display = 'none';
  succEl.textContent = '';

  if (!answer || !email || !newPassword) {
    errEl.textContent = 'Todos los campos son obligatorios';
    errEl.style.display = 'block';
    return;
  }

  if (newPassword.length < 8) {
    errEl.textContent = 'La nueva contraseña debe tener al menos 8 caracteres';
    errEl.style.display = 'block';
    return;
  }

  try {
    const data = await fetch(`${API}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, answer, email, newPassword })
    }).then(r => r.json());

    if (data.success) {
      succEl.textContent = 'Contraseña restablecida con éxito. Volviendo al login...';
      succEl.style.display = 'block';
      document.getElementById('reset-step-2').style.display = 'none';
      setTimeout(() => {
        showLoginForm();
      }, 3000);
    } else {
      errEl.textContent = data.error || 'Datos de recuperación incorrectos';
      errEl.style.display = 'block';
    }
  } catch (err) {
    errEl.textContent = 'Error al enviar la solicitud';
    errEl.style.display = 'block';
  }
}

// doLogout: borra el token, cierra el WebSocket y vuelve a la pantalla de login.
function doLogout() {
  TOKEN = '';
  localStorage.removeItem('txpl_token');
  if (statsWS) statsWS.close();
  termCleanup();
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('login-box').style.display = 'block';
  document.getElementById('reset-box').style.display = 'none';
}

// checkAuth: al cargar la página, si ya hay un token guardado, entra directo
// al panel sin pedir login otra vez.
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
// navigate: cambia de página en la SPA. Oculta todas las páginas, muestra la
// elegida y llama a su función de carga (loadDashboard, loadWebsites, etc.).
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
    plugins: 'Plugins', help: 'Manual de uso', settings: 'Ajustes', docker: 'Docker',
    n8n: 'Workflows', backups: 'Copias de seguridad', cron: 'Tareas programadas',
    mail: 'Correo', dns: 'DNS'
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
  if (page === 'docker') loadDockerContainers();
  if (page === 'n8n') loadN8n();
  if (page === 'backups') loadBackups();
  if (page === 'cron') loadCron();
  if (page === 'mail') loadMail();
  if (page === 'dns') loadDns();
}

// ── Init ──────────────────────────────────────────────────────
// initApp: arranca el panel tras el login (carga IP del servidor, dashboard
// y abre el WebSocket de estadísticas).
function initApp() {
  loadDashboard();
  connectStatsWS();
  loadServices();
  loadProcesses();
  req('GET', '/system/ip').then(d => { if (d?.ip) serverIp = d.ip; });
}

// ── Sparkline Charts (Dashboard) ──────────────────────────────
const maxSamples = 30;
const cpuHistory = [];
const memHistory = [];
const netRxHistory = [];
const netTxHistory = [];

// drawSparkline: dibuja un mini-gráfico de líneas (CPU/RAM/red) en un <canvas>.
function drawSparkline(canvasId, data, color, isNet = false, data2 = null) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);
  
  ctx.clearRect(0, 0, w, h);
  if (data.length < 2) return;
  
  let maxVal = 100;
  if (isNet) {
    maxVal = Math.max(...data, ...(data2 || []), 1024 * 1024); // Mínimo 1MB/s (auto-escala dinámicamente)
  }
  
  const drawLine = (values, lineColor, fillColor) => {
    ctx.beginPath();
    const getX = (i) => (i / (maxSamples - 1)) * w;
    const getY = (val) => h - (val / maxVal) * (h - 4) - 2;
    
    ctx.moveTo(getX(0), getY(values[0]));
    for (let i = 1; i < values.length; i++) {
      ctx.lineTo(getX(i), getY(values[i]));
    }
    
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    
    ctx.lineTo(getX(values.length - 1), h);
    ctx.lineTo(getX(0), h);
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();
  };
  
  if (isNet && data2) {
    drawLine(data, 'rgba(100, 172, 255, 1)', 'rgba(100, 172, 255, 0.1)'); // RX (blue)
    drawLine(data2, 'rgba(232, 160, 32, 1)', 'rgba(232, 160, 32, 0.05)'); // TX (orange)
  } else {
    drawLine(data, color, color.replace(', 1)', ', 0.15)'));
  }
}

// ── Stats WebSocket ───────────────────────────────────────────
// connectStatsWS: abre el WebSocket /ws/stats y actualiza los gráficos en vivo
// cada vez que el servidor envía datos (CPU, RAM, red).
function connectStatsWS() {
  const wsProto = location.protocol === 'https:' ? 'wss' : 'ws';
  const wsUrl = `${wsProto}://${location.host}/ws/stats?token=${TOKEN}`;
  statsWS = new WebSocket(wsUrl);

  statsWS.onmessage = (e) => {
    const d = JSON.parse(e.data);
    if (d.type !== 'stats') return;

    // CPU
    document.getElementById('cpu-val').textContent = d.cpu;
    document.getElementById('cpu-bar').style.width = d.cpu + '%';
    document.getElementById('cpu-bar').style.background = d.cpu > 80 ? 'var(--red)' : d.cpu > 60 ? 'var(--yellow)' : 'var(--accent)';
    
    cpuHistory.push(d.cpu);
    if (cpuHistory.length > maxSamples) cpuHistory.shift();
    drawSparkline('cpu-chart', cpuHistory, 'rgba(232, 160, 32, 1)');

    // MEM
    document.getElementById('mem-val').textContent = d.memory.percent;
    document.getElementById('mem-bar').style.width = d.memory.percent + '%';
    document.getElementById('mem-detail').textContent = `${fmtBytes(d.memory.used)} / ${fmtBytes(d.memory.total)}`;
    
    memHistory.push(d.memory.percent);
    if (memHistory.length > maxSamples) memHistory.shift();
    drawSparkline('mem-chart', memHistory, 'rgba(90, 200, 250, 1)');

    // NET
    document.getElementById('net-rx').textContent = fmtBytes(d.network.rx) + '/s';
    document.getElementById('net-tx').textContent = fmtBytes(d.network.tx) + '/s';
    
    netRxHistory.push(d.network.rx);
    netTxHistory.push(d.network.tx);
    if (netRxHistory.length > maxSamples) netRxHistory.shift();
    if (netTxHistory.length > maxSamples) netTxHistory.shift();
    drawSparkline('net-chart', netRxHistory, '', true, netTxHistory);
  };

  statsWS.onclose = () => setTimeout(connectStatsWS, 5000);
}

// ── Dashboard ─────────────────────────────────────────────────
// loadDashboard: carga las tarjetas del panel principal (stats y resúmenes).
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
// loadServices: lista los servicios del sistema (nginx, mysql...) y su estado.
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

// svcAction: arranca/para/reinicia un servicio del sistema y refresca la lista.
async function svcAction(name, action) {
  toast(`${action} ${name}...`, 'info');
  const r = await req('POST', `/system/service/${name}/${action}`);
  if (r?.success) { toast(`${name} ${action} correcto`, 'success'); loadServices(); }
  else toast(r?.error || 'Error', 'error');
}

// ── Processes ─────────────────────────────────────────────────
// loadProcesses: muestra los procesos que más CPU consumen.
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
// loadWebsites: pide la lista de sitios web y la pinta en la tabla.
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

// toggleSiteMode: alterna el formulario entre "con dominio" y "por IP:puerto".
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

// togglePhpVersion: muestra el selector de versión de PHP solo si el tipo es PHP.
function togglePhpVersion() {
  const type = document.getElementById('site-type').value;
  document.getElementById('site-php-version-group').style.display = type === 'php' ? '' : 'none';
}

// createWebsite: envía el formulario para crear un sitio web nuevo.
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

// deleteWebsite: borra un sitio web (pide confirmación antes).
async function deleteWebsite(id) {
  if (!confirm('¿Eliminar este sitio web?')) return;
  const r = await req('DELETE', `/websites/${id}`);
  if (r?.success) { toast('Sitio eliminado', 'success'); loadWebsites(); }
  else toast(r?.error || 'Error', 'error');
}

// installSSL: instala el certificado HTTPS (Let's Encrypt) en un sitio.
async function installSSL(id) {
  toast('Instalando certificado SSL...', 'info');
  const r = await req('POST', `/websites/${id}/ssl`);
  if (r?.success) { toast('SSL instalado correctamente', 'success'); loadWebsites(); }
  else toast(r?.error || 'Error al instalar SSL', 'error');
}

// ── Apps ──────────────────────────────────────────────────────
// loadApps: lista las aplicaciones desplegadas (PM2) con su estado y acciones.
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
          ${a.git_repo ? `<button class="btn btn-sm" onclick="openGitInfoModal(${a.id},'${esc(a.name)}','${esc(a.git_repo)}','${esc(a.git_branch)}','${esc(a.webhook_secret)}')" title="Git / Webhook"><i class="ti ti-git-fork"></i> Git</button>` : ''}
          <button class="btn btn-sm" onclick="viewAppLogs(${a.id},'${a.name}')" title="Logs"><i class="ti ti-file-text"></i> Logs</button>
          <button class="btn btn-sm btn-danger" onclick="appAction(${a.id},'delete')" title="Eliminar"><i class="ti ti-trash"></i> Eliminar</button>
        </div>
      </td>
    </tr>
  `).join('');
}

// updateAppPathPreview: muestra una vista previa de la ruta donde se creará la app.
function updateAppPathPreview() {
  const name = document.getElementById('app-name').value.trim() || 'nombre-app';
  const base = document.getElementById('app-path').value.trim() || '/var/www';
  const preview = document.getElementById('app-path-preview');
  if (preview) preview.textContent = base.replace(/\/+$/, '') + '/' + name;
}

// ── Deploy por ZIP (estilo Hostinger) ─────────────────────────
let deployZipFile = null;
let deployEnvFile = null;
// La inicialización del DOM se realiza en bootApp tras cargar las plantillas dinámicamente

// setupDeployDrops: prepara las zonas de "arrastrar y soltar" para subir el código.
function setupDeployDrops() {
  bindDeployDrop('deploy-zip-drop', 'deploy-zip', 'deploy-zip-label', (f) => { deployZipFile = f; });
  bindDeployDrop('deploy-env-drop', 'deploy-env', 'deploy-env-label', (f) => { deployEnvFile = f; });
}

// bindDeployDrop: conecta una zona de drag-and-drop con su input de archivo.
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

// deployLog: añade una línea a la consola de despliegue de apps.
function deployLog(msg) {
  const el = document.getElementById('deploy-log');
  el.textContent += msg + '\n';
  el.scrollTop = el.scrollHeight;
}

// renderDeploySteps: dibuja la lista de pasos del despliegue con su estado.
function renderDeploySteps(steps) {
  document.getElementById('deploy-steps').innerHTML = steps.map((s) => {
    const icon = s.state === 'ok' ? 'ti-circle-check' : s.state === 'err' ? 'ti-circle-x'
      : s.state === 'active' ? 'ti-loader-2' : 'ti-circle';
    return `<div class="deploy-step ${s.state}"><i class="ti ${icon}"></i> ${esc(s.label)}</div>`;
  }).join('');
}

// confirmPythonConfig: pausa el deploy y deja al usuario confirmar comando/modo
// de una app Python. Resuelve con { start_cmd, mode } al pulsar "Continuar".
function confirmPythonConfig(detected) {
  return new Promise((resolve) => {
    const box = document.getElementById('py-confirm');
    const modeEl = document.getElementById('py-mode');
    const fileEl = document.getElementById('py-file');
    const cmdEl = document.getElementById('py-cmd');
    const btn = document.getElementById('py-confirm-btn');

    modeEl.value = detected.mode === 'worker' ? 'worker' : 'web';
    fileEl.innerHTML = (detected.pyFiles || []).map((f) => `<option value="${esc(f)}">${esc(f)}</option>`).join('');
    cmdEl.value = detected.startCmd || 'python app.py';
    // Elegir un .py rellena el comando con "python <archivo>"
    fileEl.onchange = () => { if (fileEl.value) cmdEl.value = `python ${fileEl.value}`; };

    box.style.display = 'block';
    btn.onclick = () => {
      const start_cmd = cmdEl.value.trim();
      if (!start_cmd) { toast('Indica el comando de arranque', 'error'); return; }
      box.style.display = 'none';
      btn.onclick = null;
      resolve({ start_cmd, mode: modeEl.value });
    };
  });
}

let currentDeployTab = 'zip';

// switchDeployTab: alterna entre las pestañas del modal de despliegue de apps.
function switchDeployTab(tab) {
  currentDeployTab = tab;
  document.getElementById('tab-deploy-zip').classList.toggle('active', tab === 'zip');
  document.getElementById('tab-deploy-git').classList.toggle('active', tab === 'git');
  document.getElementById('deploy-zip-section').style.display = tab === 'zip' ? 'block' : 'none';
  document.getElementById('deploy-git-section').style.display = tab === 'git' ? 'block' : 'none';
}

// startDeploy: orquesta el despliegue de una app paso a paso (crear → subir →
// extraer → instalar → build → arrancar → proxy), mostrando el progreso.
async function startDeploy() {
  const name = document.getElementById('app-name').value.trim();
  const basePath = document.getElementById('app-path').value.trim() || '/var/www';
  const port = document.getElementById('app-port').value.trim();
  const domain = document.getElementById('app-domain').value.trim();

  const isGit = currentDeployTab === 'git';
  const gitRepo = isGit ? document.getElementById('app-git-repo').value.trim() : '';
  const gitBranch = isGit ? document.getElementById('app-git-branch').value.trim() : 'main';

  if (!name) { toast('El nombre es obligatorio', 'error'); return; }
  if (isGit && !gitRepo) { toast('El repositorio Git es obligatorio', 'error'); return; }
  if (!isGit && !deployZipFile) { toast('Sube el .zip de tu proyecto', 'error'); return; }

  // Cambia a la vista de progreso
  document.getElementById('deploy-form').style.display = 'none';
  document.getElementById('deploy-progress').style.display = 'block';
  document.getElementById('deploy-start-btn').style.display = 'none';
  document.getElementById('deploy-cancel-btn').style.display = 'none';
  document.getElementById('deploy-log').textContent = '';

  const steps = [];
  steps.push({ key: 'create', label: isGit ? 'Clonar repositorio Git y crear app' : 'Crear aplicación', state: 'pending' });
  if (!isGit) {
    steps.push({ key: 'upload', label: 'Subir archivos', state: 'pending' });
    steps.push({ key: 'extract', label: 'Extraer y detectar', state: 'pending' });
  }
  steps.push({ key: 'install', label: 'Instalar dependencias', state: 'pending' });
  steps.push({ key: 'build', label: 'Compilar (build)', state: 'pending' });
  steps.push({ key: 'start', label: 'Arrancar aplicación', state: 'pending' });
  steps.push({ key: 'proxy', label: 'Configurar acceso', state: 'pending' });

  renderDeploySteps(steps);
  const setStep = (key, state) => { steps.find((s) => s.key === key).state = state; renderDeploySteps(steps); };

  let createdId = null;
  let pyMode = null;       // 'web' | 'worker' | null (solo Python)
  const finish = async (success) => {
    if (!success && createdId) {
      deployLog('\n↩ Despliegue fallido. Limpiando: se elimina la carpeta y los archivos creados...');
      const del = await req('POST', `/apps/${createdId}/delete`);
      if (del?.success) deployLog('✓ Limpieza completada. No quedó nada en el servidor.');
      else deployLog('⚠ No se pudo limpiar automáticamente: ' + (del?.error || 'error') + '. Borra la app manualmente desde la lista.');
      createdId = null;
    }
    document.getElementById('deploy-done-btn').style.display = 'inline-flex';
    if (!success) return;
    const host = serverIp || location.hostname;
    if (pyMode !== 'worker') {
      deployLog('\n✅ Deploy completado. Accede a tu app desde:');
      if (port) deployLog(`   • IP:    http://${host}:${port}`);
      if (domain) deployLog(`   • Dominio: http://${domain}  (apunta el DNS del dominio a ${host})`);
    } else {
      deployLog('\n✅ Deploy completado. Worker/Bot en ejecución (sin puerto ni proxy).');
    }
  };

  try {
    let detected = null;   // detección de proyecto (tipo, pyFiles, startCmd, mode…)

    // 1. Crear / Clonar
    setStep('create', 'active'); deployLog(isGit ? '▶ Clonando repositorio Git...' : '▶ Creando aplicación...');
    const createData = { name, path: basePath, port, domain };
    if (isGit) {
      createData.git_repo = gitRepo;
      createData.git_branch = gitBranch;
    }
    const created = await req('POST', '/apps', createData);
    if (!created?.success) { setStep('create', 'err'); deployLog('✖ ' + (created?.error || 'Error')); return finish(false); }
    const id = created.id;
    createdId = id;
    setStep('create', 'ok'); deployLog(isGit ? '✓ Clonado exitosamente en: ' + created.path : '✓ Carpeta: ' + created.path);

    if (isGit && created.detected) {
      detected = created.detected;
      deployLog(`\nProyecto detectado: ${created.detected.type}\nInstalar: ${created.detected.installCmd || '—'}\nBuild: ${created.detected.buildCmd || '—'}\nInicio: ${created.detected.startCmd}`);
    }

    if (!isGit) {
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
      detected = ext.detected || null;
    }

    // Pausa de confirmación solo para proyectos Python
    if (detected && detected.type === 'python') {
      const cfg = await confirmPythonConfig(detected);
      const saved = await req('POST', `/apps/${id}/config`, { type: 'python', start_cmd: cfg.start_cmd, mode: cfg.mode, port, domain });
      if (!saved?.success) { deployLog('✖ No se pudo guardar la configuración'); return finish(false); }
      pyMode = cfg.mode;
    }

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

    // 7. Configurar acceso (se omite en workers Python sin puerto)
    if (pyMode !== 'worker') {
      setStep('proxy', 'active'); deployLog('\n▶ Configurando acceso...');
      const px = await req('POST', `/apps/${id}/proxy`);
      if (px?.success) { setStep('proxy', 'ok'); deployLog(px.output || ''); }
      else { setStep('proxy', 'err'); deployLog('✖ ' + (px?.error || 'No se pudo configurar el acceso')); }
    } else {
      setStep('proxy', 'ok'); deployLog('\nWorker/Bot: sin proxy ni puerto.');
    }

    toast(`App "${name}" desplegada`, 'success');
    await finish(true);
  } catch (e) {
    deployLog('✖ Error inesperado: ' + (e?.message || e));
    await finish(false);
  }
}

// resetDeployModal: limpia el modal de despliegue para empezar de cero.
function resetDeployModal() {
  deployZipFile = null;
  deployEnvFile = null;
  switchDeployTab('zip');
  document.getElementById('deploy-form').style.display = 'block';
  document.getElementById('deploy-progress').style.display = 'none';
  document.getElementById('deploy-start-btn').style.display = 'inline-flex';
  document.getElementById('deploy-cancel-btn').style.display = 'inline-flex';
  document.getElementById('deploy-done-btn').style.display = 'none';
  ['app-name', 'app-port', 'app-domain', 'app-git-repo'].forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
  document.getElementById('app-git-branch').value = 'main';
  document.getElementById('app-path').value = '/var/www';
  ['deploy-zip', 'deploy-env'].forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
  document.getElementById('deploy-zip-label').textContent = 'Arrastra el .zip o haz clic';
  document.getElementById('deploy-env-label').textContent = 'Arrastra tu .env o haz clic';
  document.getElementById('deploy-zip-drop').classList.remove('has-file');
  document.getElementById('deploy-env-drop').classList.remove('has-file');
}

// appAction: ejecuta una acción sobre una app (start/stop/restart/delete).
async function appAction(id, action) {
  if (action === 'delete' && !confirm('⚠ Se eliminará la aplicación Y TODOS sus archivos de forma permanente (carpeta, código, proxy y puerto). Esta acción no se puede deshacer.\n\n¿Continuar?')) return;
  const labels = { start: 'iniciada', stop: 'detenida', restart: 'reiniciada', delete: 'eliminada' };
  const r = await req('POST', `/apps/${id}/${action}`);
  if (r?.success) { toast(`App ${labels[action] || action}`, 'success'); loadApps(); }
  else toast(r?.error || 'Error', 'error');
}

// viewAppLogs: muestra los últimos logs de una app de PM2.
async function viewAppLogs(id, name) {
  const r = await req('GET', `/apps/${id}/logs`);
  document.getElementById('log-output').textContent = r?.logs || 'Sin logs';
  navigate(document.querySelector('[data-page=logs]'));
}

// ── Consola de la app ─────────────────────────────────────────
let consoleAppId = null;

// openAppConsole: abre una consola para ejecutar comandos dentro de la carpeta de la app.
function openAppConsole(id, name) {
  consoleAppId = id;
  document.getElementById('console-app-name').textContent = name;
  document.getElementById('console-output').textContent = 'Listo. Escribe un comando (ej: npm install, ls -la, npm run build) y pulsa Ejecutar.\n';
  document.getElementById('console-cmd').value = '';
  openModal('modal-app-console');
  setTimeout(() => document.getElementById('console-cmd').focus(), 100);
}

// runAppCommand: envía el comando escrito en la consola de la app y muestra su salida.
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

// consoleKeydown: ejecuta el comando al pulsar Enter en la consola de la app.
function consoleKeydown(e) {
  if (e.key === 'Enter') { e.preventDefault(); runAppCommand(); }
}

// installApp: instala las dependencias de una app ya creada (botón 📦).
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
let dbTools = { pma: {}, adminer: {} };
const dbPassShown = {};

// loadDatabases: lista las bases de datos y dibuja la tabla con sus acciones.
async function loadDatabases() {
  // Estado de las herramientas web (para los botones por fila)
  dbTools.pma = (await req('GET', '/databases/phpmyadmin/status')) || {};
  dbTools.adminer = (await req('GET', '/databases/adminer/status')) || {};

  const data = await req('GET', '/databases');
  if (!data) return;
  const tb = document.getElementById('databases-table');
  if (!data.length) { tb.innerHTML = '<tr><td colspan="8" class="empty-state"><i class="ti ti-database-off"></i><br>Sin bases de datos</td></tr>'; return; }
  tb.innerHTML = data.map(d => {
    const toolBtn = d.type === 'mysql'
      ? `<button class="btn btn-sm" onclick="openTool('pma')" title="Abrir phpMyAdmin"><i class="ti ti-table"></i> phpMyAdmin</button>`
      : `<button class="btn btn-sm" onclick="openTool('adminer')" title="Abrir Adminer"><i class="ti ti-table"></i> Adminer</button>`;
    return `
    <tr>
      <td style="font-weight:600;font-family:var(--mono)">${esc(d.name)}</td>
      <td><span class="badge ${d.type==='mysql'?'badge-blue':'badge-purple'}">${esc(d.type)}</span></td>
      <td style="font-family:var(--mono);font-size:12px">${esc(d.name)}</td>
      <td style="font-family:var(--mono);font-size:12px">${esc(d.db_user)}</td>
      <td>
        <span id="pass-${d.id}" style="font-family:var(--mono);font-size:12px">••••••••</span>
        <button class="btn btn-sm" onclick="toggleDbPass(${d.id})" title="Mostrar/ocultar contraseña"><i class="ti ti-eye" id="passicon-${d.id}"></i></button>
      </td>
      <td><span class="badge badge-green">${esc(d.status)}</span></td>
      <td style="color:var(--text-muted)">${fmtDate(d.created_at)}</td>
      <td>
        <div style="display:flex;gap:5px;justify-content:flex-end">
          ${toolBtn}
          <button class="btn btn-sm btn-danger" onclick="deleteDatabase(${d.id},'${esc(d.name)}')" title="Eliminar base de datos"><i class="ti ti-trash"></i> Eliminar</button>
        </div>
      </td>
    </tr>
  `;}).join('');
}

// toggleDbPass: muestra/oculta la contraseña de una base de datos (icono del ojo).
async function toggleDbPass(id) {
  const span = document.getElementById('pass-' + id);
  const icon = document.getElementById('passicon-' + id);
  if (dbPassShown[id]) {
    span.textContent = '••••••••';
    icon.className = 'ti ti-eye';
    dbPassShown[id] = false;
    return;
  }
  const r = await req('GET', `/databases/${id}/password`);
  if (r?.password) {
    span.textContent = r.password;
    icon.className = 'ti ti-eye-off';
    dbPassShown[id] = true;
  } else {
    toast('No se pudo obtener la contraseña', 'error');
  }
}

// openTool: abre phpMyAdmin o Adminer en una pestaña nueva (IP:puerto).
function openTool(tool) {
  const host = serverIp || location.hostname;
  if (tool === 'pma') {
    if (dbTools.pma.configured) return window.open(`http://${host}:${dbTools.pma.port}`, '_blank');
    if (dbTools.pma.installed) {
      if (confirm('phpMyAdmin aún no está configurado para acceso web. ¿Configurarlo ahora?')) setupPma();
      return;
    }
    return toast('Instala el plugin phpMyAdmin desde la página Plugins primero.', 'error');
  }
  // adminer
  if (dbTools.adminer.configured) return window.open(`http://${host}:${dbTools.adminer.port}`, '_blank');
  toast('Instala el plugin Adminer desde la página Plugins primero.', 'error');
}

// deleteDatabase: borra una base de datos y su usuario (con confirmación).
async function deleteDatabase(id, name) {
  if (!confirm(`⚠ Se eliminará la base de datos "${name}" Y su usuario de forma permanente. Todos los datos que contenga se perderán y no se pueden recuperar.\n\n¿Continuar?`)) return;
  const r = await req('DELETE', `/databases/${id}`);
  if (r?.success) { toast(`Base de datos "${name}" eliminada`, 'success'); loadDatabases(); }
  else toast(r?.error || 'Error al eliminar', 'error');
}

// createDatabase: crea una base de datos nueva; muestra la contraseña generada.
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

// phpMyAdmin: configurar acceso web (instala PHP-FPM y crea el vhost)
// setupPma: configura el acceso web a phpMyAdmin (vhost de nginx en su puerto).
async function setupPma() {
  toast('Configurando phpMyAdmin (puede instalar PHP-FPM)...', 'info');
  const r = await req('POST', '/databases/phpmyadmin/setup');
  if (r?.success) { toast('phpMyAdmin listo en el puerto ' + r.port, 'success'); loadDatabases(); }
  else toast(r?.error || 'Error configurando phpMyAdmin', 'error');
}

// ── Files ─────────────────────────────────────────────────────
let currentFilePath = '/';

// loadFiles: lista el contenido de la carpeta actual en el gestor de archivos.
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

// updateBreadcrumb: dibuja la barra de "migas de pan" (la ruta clicable de carpetas).
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

// getFileIcon: elige un icono según la extensión del archivo.
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
// setupDragDrop: activa arrastrar y soltar archivos/carpetas en el gestor.
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

// handleDrop: procesa los archivos/carpetas soltados en el gestor.
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

// handleFileUpload: gestiona la subida desde el botón de seleccionar archivos.
function handleFileUpload(e) {
  uploadFlatFiles(e.target.files);
  e.target.value = '';
}

// showProgress: actualiza la barra de progreso de subida de archivos.
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

// hideProgress: oculta la barra de progreso al terminar.
function hideProgress() {
  const wrap = document.getElementById('upload-progress');
  if (wrap) setTimeout(() => { wrap.style.display = 'none'; }, 3000);
}

// readEntryAsFile: convierte una entrada del drag-drop en un objeto File (promesa).
function readEntryAsFile(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

// readDirEntries: lee todas las entradas de una carpeta arrastrada.
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

// flattenEntry: recorre recursivamente una carpeta y devuelve su lista de archivos.
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
// uploadBinary: sube un archivo al servidor por streaming binario.
async function uploadBinary(file, destPath) {
  const r = await fetch(API + '/api/files/upload?path=' + encodeURIComponent(destPath), {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  if (r.status === 401) { doLogout(); return { success: false }; }
  try { return await r.json(); } catch (_) { return { success: r.ok }; }
}

// processEntries: sube en orden todos los archivos arrastrados, con progreso.
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

// uploadFlatFiles: sube una lista plana de archivos (sin estructura de carpetas).
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

// createFolder: crea una carpeta nueva en la ruta actual.
async function createFolder() {
  const name = document.getElementById('folder-name').value.trim();
  if (!name) { toast('Nombre requerido', 'error'); return; }
  const path = currentFilePath + '/' + name;
  const r = await req('POST', '/files/mkdir', { path });
  if (r?.success) { toast('Carpeta creada', 'success'); closeModal('modal-new-folder'); loadFiles(); }
  else toast(r?.error || 'Error', 'error');
}

// createFile: crea un archivo vacío en la ruta actual.
async function createFile() {
  const name = document.getElementById('file-name').value.trim();
  if (!name) { toast('Nombre requerido', 'error'); return; }
  const path = currentFilePath + '/' + name;
  const r = await req('POST', '/files/write', { path, content: '' });
  if (r?.success) { toast('Archivo creado', 'success'); closeModal('modal-new-file'); loadFiles(); }
  else toast(r?.error || 'Error', 'error');
}

// browseDir: entra en una carpeta y recarga la lista de archivos.
function browseDir(path) {
  currentFilePath = path;
  loadFiles();
}

// deleteFile: borra un archivo o carpeta (con confirmación).
async function deleteFile(path) {
  const name = path.split('/').pop();
  if (!confirm(`¿Eliminar "${name}"?`)) return;
  const r = await req('DELETE', '/files', { path });
  if (r?.success) { toast('Eliminado', 'success'); loadFiles(); }
  else toast(r?.error || 'Error', 'error');
}

// extractFile: descomprime un archivo .zip/.tar en su carpeta.
async function extractFile(path) {
  const name = path.split('/').pop();
  if (!confirm(`¿Extraer "${name}" en esta carpeta?`)) return;
  toast(`Extrayendo ${name}...`, 'info');
  const r = await req('POST', '/files/extract', { path });
  if (r?.success) { toast('Archivo extraído', 'success'); loadFiles(); }
  else toast(r?.error || 'Error al extraer', 'error');
}

// editFile: abre un archivo de texto en el editor del panel.
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

// saveFile: guarda los cambios del editor en el archivo.
async function saveFile(path) {
  const content = document.getElementById('file-editor').value;
  const r = await req('POST', '/files/write', { path, content });
  if (r?.success) { toast('Guardado', 'success'); closeModal('modal-edit-file'); loadFiles(); }
  else toast(r?.error || 'Error', 'error');
}

// ── Firewall ──────────────────────────────────────────────────
// loadFirewall: muestra el estado del firewall y sus reglas.
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

// createRule: añade una regla nueva al firewall.
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

// deleteRule: borra la regla número "num" del firewall.
async function deleteRule(num) {
  if (!confirm('¿Eliminar esta regla?')) return;
  const r = await req('DELETE', `/firewall/rule/${num}`);
  if (r?.success) { toast('Regla eliminada', 'success'); loadFirewall(); }
  else toast(r?.error || 'Error', 'error');
}

// ── SSL ───────────────────────────────────────────────────────
// loadSSL: reutiliza la lista de sitios (la gestión de SSL vive ahí).
async function loadSSL() {
  await loadWebsites();
}

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
  };
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
// loadLog: muestra un log (nginx/sistema/auditoría) en la página de logs.
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

// Helper de streaming reutilizable (mismo patrón que n8nInstall): hace POST,
// lee el cuerpo por chunks y vuelca a la consola hasta el centinela __TXPL_DONE__.
async function streamConsole(path, body, el) {
  const DONE = '__TXPL_DONE__';
  const r = await fetch(API + '/api' + path, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.status === 401) { doLogout(); return 1; }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buffer = '', exitCode = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });
    let display = buffer;
    const idx = buffer.indexOf(DONE);
    if (idx >= 0) { exitCode = parseInt(buffer.slice(idx + DONE.length).trim(), 10) || 0; display = buffer.slice(0, idx); }
    el.textContent = display; el.scrollTop = el.scrollHeight;
  }
  return exitCode;
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
async function mailStream(path, body, el) {
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
    </div>`;
  loadMailboxes(); loadAliases();
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

// ── Utils ─────────────────────────────────────────────────────
// copyText: copia un texto al portapapeles (con alternativa para conexiones sin HTTPS).
function copyText(text) {
  // navigator.clipboard solo existe en contextos seguros (HTTPS/localhost).
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(() => toast('Copiado al portapapeles', 'success'))
      .catch(() => fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}

// fallbackCopy: copia al portapapeles usando un textarea oculto (método antiguo,
// necesario cuando navigator.clipboard no está disponible, p.ej. sin HTTPS).
function fallbackCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus(); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    toast(ok ? 'Copiado al portapapeles' : 'No se pudo copiar', ok ? 'success' : 'error');
  } catch (_) {
    toast('No se pudo copiar', 'error');
  }
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

// ── Git / Webhooks ────────────────────────────────────────────
let gitInfoAppId = null;

// openGitInfoModal: muestra el repo/rama y la URL del webhook de auto-deploy de una app.
function openGitInfoModal(id, name, repo, branch, secret) {
  gitInfoAppId = id;
  document.getElementById('git-info-repo').textContent = repo || '—';
  document.getElementById('git-info-branch').textContent = branch || '—';
  document.getElementById('git-info-updated').textContent = 'Sincronizado al crear/actualizar';

  const webhookUrl = `${window.location.origin}/api/webhooks/deploy/${secret}`;
  document.getElementById('git-info-webhook').value = webhookUrl;

  document.getElementById('git-pull-progress').style.display = 'none';
  document.getElementById('git-pull-log').textContent = '';

  openModal('modal-git-info');
}

// copyWebhookUrl: copia la URL del webhook al portapapeles.
function copyWebhookUrl() {
  const input = document.getElementById('git-info-webhook');
  copyText(input.value);
}

// triggerGitPull: lanza manualmente un git pull + rebuild + recarga de la app.
async function triggerGitPull() {
  if (!gitInfoAppId) return;

  const progress = document.getElementById('git-pull-progress');
  const log = document.getElementById('git-pull-log');

  progress.style.display = 'block';
  log.textContent = 'Iniciando despliegue de Git Pull manual...\n';
  log.scrollTop = log.scrollHeight;

  const r = await req('POST', `/apps/${gitInfoAppId}/git-pull`);

  if (r?.success) {
    log.textContent += '\n' + (r.output || '') + '\n';
    toast('Aplicación actualizada y redesplegada con éxito.', 'success');
  } else {
    log.textContent += '\n✖ Error durante el despliegue:\n' + (r?.output || r?.error || 'Error desconocido') + '\n';
    toast('Error en el despliegue manual de Git.', 'error');
  }
  log.scrollTop = log.scrollHeight;
  loadApps();
}

// ── Init ──────────────────────────────────────────────────────
async function loadTemplates() {
  const pages = [
    'dashboard', 'terminal', 'websites', 'apps', 'databases',
    'docker', 'n8n', 'backups', 'cron', 'mail', 'dns', 'files', 'firewall', 'ssl', 'logs', 'plugins',
    'help', 'settings'
  ];

  const promises = [
    fetch('views/sidebar.html')
      .then(r => { if (!r.ok) throw new Error(`sidebar: ${r.statusText}`); return r.text(); })
      .then(html => {
        const mount = document.getElementById('sidebar-mount');
        if (mount) mount.innerHTML = html;
      }),
    fetch('views/modals.html')
      .then(r => { if (!r.ok) throw new Error(`modals: ${r.statusText}`); return r.text(); })
      .then(html => {
        const mount = document.getElementById('modals-mount');
        if (mount) mount.innerHTML = html;
      })
  ];

  pages.forEach(page => {
    promises.push(
      fetch(`views/pages/${page}.html`)
        .then(r => { if (!r.ok) throw new Error(`${page}: ${r.statusText}`); return r.text(); })
        .then(html => {
          const mount = document.getElementById(`page-${page}`);
          if (mount) mount.innerHTML = html;
        })
    );
  });

  try {
    await Promise.all(promises);
  } catch (err) {
    console.error('Error loading templates:', err);
    toast('Error al cargar la interfaz. Revisa la consola o recarga.', 'error');
  }
}

function bindModalOverlayEvents() {
  document.querySelectorAll('.modal-overlay').forEach(o => {
    o.addEventListener('click', e => { if (e.target === o) o.classList.remove('open') });
  });
}

async function bootApp() {
  await loadTemplates();
  bindModalOverlayEvents();
  
  // Re-run setup logic for DOM elements that were loaded dynamically
  const nameEl = document.getElementById('app-name');
  const pathEl = document.getElementById('app-path');
  if (nameEl) nameEl.addEventListener('input', updateAppPathPreview);
  if (pathEl) pathEl.addEventListener('input', updateAppPathPreview);
  setupDragDrop();
  setupDeployDrops();
  
  // Check auth
  await checkAuth();
}

bootApp();

setInterval(() => {
  if (currentPage === 'dashboard') { loadServices(); loadProcesses(); }
  if (currentPage === 'docker') { loadDockerContainers(); }
}, 30000);
