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

async function loadTemplates() {
  const pages = ['dashboard','terminal','websites','apps','databases','docker','n8n','catalog',
    'backups','cron','mail','dns','files','firewall','ssl','logs','plugins','help','settings'];
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
const PAGE_IMPORTS = {
  auth:        ()=>import('./auth.js'),
  dashboard:   ()=>import('./dashboard.js'),
  websites:    ()=>import('./websites.js'),
  apps:        ()=>import('./apps.js'),
  databases:   ()=>import('./databases.js'),
  files:       ()=>import('./files.js'),
  firewall:    ()=>import('./firewall.js'),
  ssl:         ()=>import('./ssl.js'),
  settings:    ()=>import('./settings.js'),
  notifications:()=>import('./notifications.js'),
  logs:        ()=>import('./logs.js'),
  terminal:    ()=>import('./terminal.js'),
  plugins:     ()=>import('./plugins.js'),
  n8n:         ()=>import('./n8n.js'),
  catalog:     ()=>import('./catalog.js'),
  backups:     ()=>import('./backups.js'),
  mail:        ()=>import('./mail.js'),
  dns:         ()=>import('./dns.js'),
  cron:        ()=>import('./cron.js'),
  docker:      ()=>import('./docker.js'),
};

async function boot() {
  await loadTemplates();
  // Carga todas las páginas JS (las funciones globales se registran en window)
  const pageLoads = Object.values(PAGE_IMPORTS).map(fn => fn().catch(()=>{}));
  await Promise.allSettled(pageLoads);
  bindOverlays();
  applyTheme(window.themePref?.());
  const ts = document.getElementById('set-theme'); if(ts)ts.value=window.themePref?.();
  try{ window.setupDragDrop?.();window.setupDeployDrops?.() }catch(_){}
  try{ document.getElementById('app-name')?.addEventListener('input', window.updateAppPathPreview); document.getElementById('app-path')?.addEventListener('input', window.updateAppPathPreview) }catch(_){}
  await checkAuth();
  setInterval(()=>{ if(window.currentPage==='dashboard'){window.loadServices?.();window.loadProcesses?.()}if(window.currentPage==='docker')window.loadDockerContainers?.() },30000);
}
boot();