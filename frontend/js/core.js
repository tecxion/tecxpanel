// TecXPaneL — núcleo compartido (globals, req, toast, navegación, boot)
// ════════════════════════════════════════════════════════════
//  TecXPaneL — Frontend en JavaScript "vanilla", sin frameworks.
//
//  Este fichero es el núcleo: globals (API, TOKEN, statsWS,
//  currentPage, serverIp), helpers (req, toast, esc, fmt*,
//  openModal/closeModal), navegación (navigate), streaming genérico
//  (streamConsole), portapapeles y el arranque (bootApp + carga de
//  parciales). La lógica de cada sección vive en su propio fichero
//  js/<dominio>.js (auth, dashboard, websites, apps, databases,
//  files, firewall, ssl, settings, notifications, logs, terminal,
//  plugins, n8n, catalog, backups, mail, dns, cron, docker) y todos
//  comparten scope global — `<script>` clásicos ordenados con
//  core.js primero. Comunicación con el backend por req() (API REST)
//  y WebSockets para datos en tiempo real.
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

// emptyState: contenido de un estado vacío (icono + mensaje + CTA opcional).
// Devuelve el HTML interno; el llamador lo envuelve en su celda/div con
// class="empty-state". ctaOnclick es código inline (patrón onclick del panel).
function emptyState(icon, message, ctaLabel, ctaOnclick) {
  const cta = ctaLabel
    ? `<br><button class="btn btn-primary btn-sm mt-2" onclick="${esc(ctaOnclick)}"><i class="ti ti-plus"></i> ${esc(ctaLabel)}</button>`
    : '';
  return `<i class="ti ti-${esc(icon)}"></i><br>${esc(message)}${cta}`;
}

// Cerrar la modal al hacer clic fuera de ella (en el fondo oscuro) se vincula dinámicamente en bootApp

// ── Tema (claro/oscuro/sistema) ──────────────────────────────
// La preferencia vive en localStorage ('txpl_theme'); el anti-flash del
// index.html la aplica antes del primer pintado. Aquí solo se gestiona
// el cambio en caliente y la sincronización de los controles.
function themePref() {
  try { return localStorage.getItem('txpl_theme') || 'system'; } catch (_) { return 'system'; }
}
function applyTheme(pref) {
  const light = pref === 'light' ||
    (pref === 'system' && window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
  const ic = document.getElementById('theme-toggle-icon');
  if (ic) ic.className = 'ti ti-' + (light ? 'moon' : 'sun');
}
function setThemePref(pref) {
  try { localStorage.setItem('txpl_theme', pref); } catch (_) {}
  applyTheme(pref);
  const sel = document.getElementById('set-theme');
  if (sel) sel.value = pref;
}
function toggleTheme() {
  const light = document.documentElement.getAttribute('data-theme') === 'light';
  setThemePref(light ? 'dark' : 'light');
}
// Si la preferencia es "system", seguir los cambios del SO en vivo.
if (window.matchMedia) {
  const mq = matchMedia('(prefers-color-scheme: light)');
  if (mq.addEventListener) mq.addEventListener('change', () => { if (themePref() === 'system') applyTheme('system'); });
}

// ── Sidebar móvil (off-canvas) ───────────────────────────────
function toggleSidebar() {
  document.body.classList.toggle('sidebar-open');
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
    mail: 'Correo', dns: 'DNS', catalog: 'Catálogo de aplicaciones'
  };
  document.getElementById('page-title').textContent = titles[page] || page;
  if (currentPage === 'terminal' && page !== 'terminal') termCleanup();
  if (currentPage === 'logs' && page !== 'logs') logsLiveStop();
  currentPage = page;
  document.body.classList.remove('sidebar-open'); // cierra la sidebar móvil al navegar

  if (page === 'logs') loadLogsPage();
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
  if (page === 'catalog') loadCatalog();
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

// ── Init ──────────────────────────────────────────────────────
async function loadTemplates() {
  const pages = [
    'dashboard', 'terminal', 'websites', 'apps', 'databases',
    'docker', 'n8n', 'catalog', 'backups', 'cron', 'mail', 'dns', 'files', 'firewall', 'ssl', 'logs', 'plugins',
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
  applyTheme(themePref());
  const themeSel = document.getElementById('set-theme');
  if (themeSel) themeSel.value = themePref();

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
