// core/router.js — navegación SPA con lazy loading de páginas
import { applyTheme } from './theme.js';
import { toast } from './toast.js';

const titles = {
  dashboard: 'Dashboard', terminal: 'Terminal SSH', logs: 'Logs del sistema',
  websites: 'Sitios Web', apps: 'Aplicaciones', databases: 'Bases de Datos',
  files: 'Gestor de Archivos', firewall: 'Firewall UFW', ssl: 'Certificados SSL',
  plugins: 'Plugins', help: 'Manual de uso', settings: 'Ajustes', docker: 'Docker',
  n8n: 'Workflows', backups: 'Copias de seguridad', cron: 'Tareas programadas',
  mail: 'Correo Electrónico', catalog: 'Catálogo de aplicaciones', // dns: 'DNS' desactivado (sección no depurada)
};

// Lazy page loaders — una vez importada la página, se cachea.
// Durante la migración v1→v2, las funciones globales (loadDockerContainers, loadWebsites, etc.)
// se siguen llamando como están. Cuando la página migre a ES module, su render()
// reemplazará el onclick inline con lit-html bindings.
const PAGE_TABLE = {
  dashboard: () => Promise.resolve(window.loadDashboard?.()),
  terminal:  () => Promise.resolve(window.initTerminal?.()),
  logs:      () => Promise.resolve(window.loadLogsPage?.()),
  websites:  () => Promise.resolve(window.loadWebsites?.()),
  apps:      () => Promise.resolve(window.loadApps?.()),
  databases: () => Promise.resolve(window.loadDatabases?.()),
  firewall:  () => Promise.resolve(window.loadFirewall?.()),
  files:     () => Promise.resolve(window.loadFiles?.()),
  ssl:       () => Promise.resolve(window.loadSSL?.()),
  plugins:   () => Promise.resolve(window.loadPlugins?.()),
  settings:  () => Promise.resolve(window.loadSettings?.()),
  docker:    () => Promise.resolve(window.loadDockerContainers?.()),
  n8n:       () => Promise.resolve(window.loadN8n?.()),
  catalog:   () => Promise.resolve(window.loadCatalog?.()),
  backups:   () => Promise.resolve(window.loadBackups?.()),
  cron:      () => Promise.resolve(window.loadCron?.()),
  mail:      () => Promise.resolve(window.loadMail?.()),
  // dns:       () => Promise.resolve(window.loadDns?.()), // DNS desactivado (sección no depurada)
};

let current = 'dashboard';

// Registra una página con su loader lazy. Usado por pages/<name>.js cuando se
// migren a ES modules en tareas siguientes.
export function registerPage(name, loader) {
  if (PAGE_TABLE[name]) throw new Error(`Page "${name}" already registered`);
  PAGE_TABLE[name] = loader;
}

export function navigate(pageOrEl) {
  const pageName = typeof pageOrEl === 'string' ? pageOrEl : pageOrEl?.dataset?.page;
  const target = pageName && document.getElementById('page-' + pageName);
  if (!target) return;

  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  if (pageOrEl && typeof pageOrEl !== 'string' && pageOrEl.classList) pageOrEl.classList.add('active');
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  target.classList.add('active');
  document.body.classList.remove('sidebar-open');

  document.getElementById('page-title').textContent = titles[pageName] || pageName;

  // Cleanup pages anteriores
  if (current === 'terminal' && pageName !== 'terminal') window.termCleanup?.();
  if (current === 'logs' && pageName !== 'logs') window.logsLiveStop?.();
  current = pageName;

  const loader = PAGE_TABLE[pageName];
  if (loader) loader();
}

// Export global para back-compat con onclick inline.
export function toggleSidebar() { document.body.classList.toggle('sidebar-open'); }

// Boot helper: load templates, check auth, init theme, expose globals.
export { applyTheme };