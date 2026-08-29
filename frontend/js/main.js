// ============================================================
//  TecXPaneL v2 — main.js (módulo ES, entry point del frontend)
// ============================================================
import { toast } from './core/toast.js';
import { fmtBytes, fmtDate, esc, emptyState, copyText, openModal, closeModal } from './core/utils.js';
import { themePref, applyTheme, setThemePref, toggleTheme } from './core/theme.js';
import { navigate, toggleSidebar } from './core/router.js';
import { streamConsole } from './core/stream.js';

const API = window.location.origin;

// ── Exponer globales (back-compat pages v1) ──────────────────
Object.assign(window, {
  API, TOKEN: localStorage.getItem('txpl_token') || '',
  req: async (method, path, body) => {
    const opts = { method, headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${window.TOKEN}` } };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(API + '/api' + path, opts);
    if (r.status === 401) { window.doLogout?.(); return; }
    return r.json();
  },
  toast, fmtBytes, fmtDate, esc, emptyState, copyText,
  openModal, closeModal, navigate, toggleSidebar,
  themePref, applyTheme, setThemePref, toggleTheme, streamConsole,
  currentPage: 'dashboard', statsWS: null, serverIp: '',
});

// initApp: arranca la carga de datos del panel (dashboard + servicios + IP).
// Lo llama boot() al abrir el panel ya autenticado y auth.js tras un login
// (antes vivía en el core.js v1, que ya no se carga → "initApp is not defined").
function initApp() {
  window.loadDashboard?.();
  window.loadServices?.();
  window.loadProcesses?.();
  window.connectStatsWS?.();
  window.req?.('GET', '/system/ip').then(d => { if (d?.ip) window.serverIp = d.ip; }).catch(() => {});
}
window.initApp = initApp;

async function loadTemplates() {
  const pages = ['dashboard','terminal','websites','databases','docker','n8n','catalog',
    'backups','cron','mail','files','firewall','ssl','logs','plugins','help','settings']; // 'apps' fusionado en 'websites'; 'dns' desactivado (sección no depurada)
  const tasks = [
    fetch('views/sidebar.html').then(r=>r.text()).then(h=>{const m=document.getElementById('sidebar-mount');if(m)m.innerHTML=h}),
    fetch('views/modals.html').then(r=>r.text()).then(h=>{const m=document.getElementById('modals-mount');if(m)m.innerHTML=h}),
  ];
  pages.forEach(page => tasks.push(fetch(`views/pages/${page}.html`).then(r=>r.text()).then(h=>{const m=document.getElementById(`page-${page}`);if(m)m.innerHTML=h})));
  try { await Promise.all(tasks); } catch(err) { console.error('Error loading templates:',err); toast('Error al cargar la interfaz','error'); }
}

function bindOverlays() {
  document.querySelectorAll('.modal-overlay').forEach(o=>{o.addEventListener('click',e=>{if(e.target===o)o.classList.remove('open')})});
}

async function checkAuth() {
  try { const r = await window.req('GET','/auth/me'); if(!r||r.unauthorized)window.doLogout?.();else{document.getElementById('app')?.classList.add('authed')} } catch(_){document.getElementById('app')?.classList.remove('authed')}
}

// ── Carga lazy de todas las páginas JS v1 (hacen funciones globales) ──
// ASSET_V se añade como ?v= a cada import dinámico para que un despliegue
// invalide la caché del navegador/nginx (que sirve JS con `immutable`); sin
// esto quedaban módulos viejos servidos (p. ej. terminal.js sin la carga lazy
// de xterm → "no se pudo cargar xterm.js"). SUBIR al cambiar cualquier página.
const ASSET_V = '20260829a';
const imp = (name) => import(`./${name}.js?v=${ASSET_V}`);
const PAGE_IMPORTS = {
  auth:        () => imp('auth'),
  dashboard:   () => imp('dashboard'),
  websites:    () => imp('websites'),
  apps:        () => imp('apps'),
  databases:   () => imp('databases'),
  files:       () => imp('files'),
  firewall:    () => imp('firewall'),
  ssl:         () => imp('ssl'),
  settings:    () => imp('settings'),
  notifications: () => imp('notifications'),
  logs:        () => imp('logs'),
  terminal:    () => imp('terminal'),
  plugins:     () => imp('plugins'),
  n8n:         () => imp('n8n'),
  catalog:     () => imp('catalog'),
  backups:     () => imp('backups'),
  mail:        () => imp('mail'),
  // dns:         () => imp('dns'), // DNS desactivado (sección no depurada)
  cron:        () => imp('cron'),
  docker:      () => imp('docker'),
};

async function boot() {
  await loadTemplates();
  // Carga todas las páginas JS. Cada módulo hace su propio `Object.assign(window, {...})`
  // al final del fichero para exponer sus funciones a los `onclick=` inline de las vistas.
  const pageLoads = Object.values(PAGE_IMPORTS).map(fn => fn().catch(()=>{}));
  await Promise.allSettled(pageLoads);
  bindOverlays();
  applyTheme(window.themePref?.());
  const ts = document.getElementById('set-theme'); if(ts)ts.value=window.themePref?.();
  try{ window.setupDragDrop?.();window.setupDeployDrops?.() }catch(_){}
  try{ document.getElementById('app-name')?.addEventListener('input', window.updateAppPathPreview); document.getElementById('app-path')?.addEventListener('input', window.updateAppPathPreview) }catch(_){}
  await checkAuth();
  // Arranque inicial del dashboard: el <div id="page-dashboard"> ya está marcado
  // como active en el HTML, así que router.navigate() nunca se dispara al abrir
  // el panel y sus loaders (loadDashboard/Services/Processes/connectStatsWS)
  // quedarían esperando al setInterval de 30 s (Services/Processes) o para
  // siempre (WebSocket de stats). Los invocamos aquí una vez.
  if (window.currentPage === 'dashboard') initApp();
  setInterval(()=>{ if(window.currentPage==='dashboard'){window.loadServices?.();window.loadProcesses?.()}if(window.currentPage==='docker')window.loadDockerContainers?.() },30000);
}
boot();
