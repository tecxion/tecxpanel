// TecXPaneL — Command Palette (Ctrl+K / Cmd+K)
// Búsqueda global: secciones, acciones y recursos (sitios, apps, BDs,
// contenedores). Índice estático + recursos con caché de 60 s.
// Sin librerías; requiere core.js (navigate, openModal, req, esc).

const PALETTE_SECTIONS = [
  { page: 'dashboard', label: 'Dashboard', alias: 'inicio panel', icon: 'layout-dashboard' },
  { page: 'websites',  label: 'Sitios Web', alias: 'webs dominios nginx', icon: 'world' },
  { page: 'apps',      label: 'Aplicaciones', alias: 'deploy pm2 node', icon: 'brand-nodejs' },
  { page: 'databases', label: 'Bases de Datos', alias: 'mysql postgres bbdd', icon: 'database' },
  { page: 'docker',    label: 'Docker', alias: 'contenedores containers', icon: 'brand-docker' },
  { page: 'n8n',       label: 'Workflows', alias: 'n8n automatizaciones', icon: 'sitemap' },
  { page: 'catalog',   label: 'Catálogo de aplicaciones', alias: 'wordpress ghost one-click', icon: 'apps' },
  { page: 'backups',   label: 'Copias de seguridad', alias: 'backups restaurar', icon: 'archive' },
  { page: 'cron',      label: 'Tareas programadas', alias: 'cron crontab', icon: 'clock' },
  { page: 'mail',      label: 'Correo', alias: 'email buzones mail', icon: 'mail' },
  { page: 'dns',       label: 'DNS', alias: 'zonas registros powerdns', icon: 'world-search' },
  { page: 'files',     label: 'Gestor de Archivos', alias: 'ficheros archivos explorador', icon: 'folder' },
  { page: 'firewall',  label: 'Firewall UFW', alias: 'cortafuegos puertos reglas', icon: 'shield' },
  { page: 'ssl',       label: 'Certificados SSL', alias: 'https certbot letsencrypt', icon: 'certificate' },
  { page: 'logs',      label: 'Logs del sistema', alias: 'registros errores', icon: 'file-text' },
  { page: 'terminal',  label: 'Terminal SSH', alias: 'consola shell', icon: 'terminal-2' },
  { page: 'plugins',   label: 'Plugins', alias: 'paquetes instalar', icon: 'puzzle' },
  { page: 'help',      label: 'Manual de uso', alias: 'ayuda documentacion', icon: 'lifebuoy' },
  { page: 'settings',  label: 'Ajustes', alias: 'configuracion tema contraseña', icon: 'settings' },
];

const PALETTE_ACTIONS = [
  { label: 'Crear sitio web', page: 'websites', modal: 'modal-new-site', icon: 'world-plus' },
  { label: 'Desplegar aplicación', page: 'apps', fn: 'resetDeployModal', modal: 'modal-new-app', icon: 'rocket' },
  { label: 'Nueva base de datos', page: 'databases', modal: 'modal-new-db', icon: 'database-plus' },
  { label: 'Nuevo contenedor Docker', page: 'docker', modal: 'modal-new-container', icon: 'cube-plus' },
  { label: 'Nueva regla de firewall', page: 'firewall', modal: 'modal-new-rule', icon: 'shield-plus' },
  { label: 'Nueva carpeta', page: 'files', modal: 'modal-new-folder', icon: 'folder-plus' },
  { label: 'Nuevo archivo', page: 'files', modal: 'modal-new-file', icon: 'file-plus' },
  { label: 'Backup completo ahora', page: 'backups', fn: 'backupNow', args: ['full'], icon: 'player-record' },
];

// Recursos dinámicos: se cargan al abrir con caché de 60 s.
let paletteCache = { at: 0, items: [] };

function paletteNorm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

async function paletteLoadResources() {
  if (Date.now() - paletteCache.at < 60000) return paletteCache.items;
  const sources = [
    { path: '/websites', page: 'websites', icon: 'world', pick: (d) => (Array.isArray(d) ? d : []).map((w) => w.domain) },
    { path: '/apps', page: 'apps', icon: 'brand-nodejs', pick: (d) => (Array.isArray(d) ? d : []).map((a) => a.name) },
    { path: '/databases', page: 'databases', icon: 'database', pick: (d) => (Array.isArray(d) ? d : []).map((db) => db.name) },
    { path: '/docker/containers', page: 'docker', icon: 'brand-docker', pick: (d) => (d?.containers || (Array.isArray(d) ? d : [])).map((c) => c.name || (c.Names && c.Names[0]) || '').filter(Boolean) },
  ];
  const results = await Promise.allSettled(sources.map((s) => req('GET', s.path)));
  const items = [];
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled' || !r.value) return; // API caída: fuente omitida
    try {
      for (const name of sources[i].pick(r.value)) {
        items.push({ label: name, page: sources[i].page, icon: sources[i].icon, kind: 'Recursos' });
      }
    } catch (_) { /* forma inesperada: fuente omitida */ }
  });
  paletteCache = { at: Date.now(), items };
  return items;
}

let paletteSel = 0;
let paletteItems = [];

function paletteIndex(resources) {
  return [
    ...PALETTE_SECTIONS.map((s) => ({ ...s, kind: 'Secciones' })),
    ...PALETTE_ACTIONS.map((a) => ({ ...a, kind: 'Acciones' })),
    ...resources,
  ];
}

function paletteFilter(all, q) {
  const nq = paletteNorm(q);
  const hits = !nq ? all : all.filter((it) => paletteNorm(it.label + ' ' + (it.alias || '')).includes(nq));
  return hits.slice(0, 12);
}

function paletteRender() {
  const list = document.getElementById('palette-list');
  if (!paletteItems.length) {
    list.innerHTML = '<div class="palette-empty">Sin resultados</div>';
    return;
  }
  let html = '', lastKind = '';
  paletteItems.forEach((it, i) => {
    if (it.kind !== lastKind) { html += `<div class="palette-group">${esc(it.kind)}</div>`; lastKind = it.kind; }
    html += `<div class="palette-item${i === paletteSel ? ' sel' : ''}" onclick="paletteExec(${i})">` +
      `<i class="ti ti-${esc(it.icon || 'chevron-right')}"></i> ${esc(it.label)}</div>`;
  });
  list.innerHTML = html;
  const sel = list.querySelector('.palette-item.sel');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

async function paletteUpdate() {
  const q = document.getElementById('palette-input').value;
  const resources = await paletteLoadResources();
  paletteItems = paletteFilter(paletteIndex(resources), q);
  if (paletteSel >= paletteItems.length) paletteSel = 0;
  paletteRender();
}

function paletteExec(i) {
  const it = paletteItems[i];
  if (!it) return;
  closePalette();
  navigate(it.page);
  document.querySelectorAll('.nav-item').forEach((n) => n.classList.toggle('active', n.dataset.page === it.page));
  if (it.fn && typeof window[it.fn] === 'function') window[it.fn](...(it.args || []));
  if (it.modal) openModal(it.modal);
}

function openPalette() {
  paletteSel = 0;
  document.getElementById('palette-overlay').classList.add('open');
  const input = document.getElementById('palette-input');
  input.value = '';
  input.focus();
  paletteUpdate();
}

function closePalette() {
  document.getElementById('palette-overlay').classList.remove('open');
}

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    const open = document.getElementById('palette-overlay')?.classList.contains('open');
    if (open) closePalette(); else if (TOKEN) openPalette();
    return;
  }
  const overlay = document.getElementById('palette-overlay');
  if (!overlay || !overlay.classList.contains('open')) return;
  if (e.key === 'Escape') { closePalette(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); paletteSel = Math.min(paletteSel + 1, paletteItems.length - 1); paletteRender(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); paletteSel = Math.max(paletteSel - 1, 0); paletteRender(); }
  else if (e.key === 'Enter') { e.preventDefault(); paletteExec(paletteSel); }
});
