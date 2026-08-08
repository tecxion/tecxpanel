// TecXPaneL — websites (CRUD Nginx vhosts)

// Etiquetas humanas para la columna Tipo (antes se pintaba "html", "nodejs"
// crudo en un badge, poco legible para usuarios no técnicos).
const SITE_TYPE_LABELS = {
  html:    { text: 'HTML',    icon: '📄' },
  php:     { text: 'PHP',     icon: '🐘' },
  nodejs:  { text: 'Node.js', icon: '🟢' },
  react:   { text: 'React',   icon: '⚛️' },
  python:  { text: 'Python',  icon: '🐍' },
};

// loadWebsites: pide la lista de sitios web y la pinta en la tabla. Cachea la
// IP pública del servidor en window.serverIp (para "Abrir" en modo IP:puerto).
async function loadWebsites() {
  if (!window.serverIp) {
    const ipData = await req('GET', '/system/ip').catch(() => null);
    if (ipData?.ip && ipData.ip !== 'desconocida') window.serverIp = ipData.ip;
  }
  const data = await req('GET', '/websites');
  if (!data) return;
  const tb = document.getElementById('websites-table');
  if (!data.length) {
    tb.innerHTML = '<tr><td colspan="6">' + emptyState('world-off', 'Sin sitios web aún', 'Crear sitio web', "openNewSiteModal()") + '</td></tr>';
    return;
  }
  tb.innerHTML = data.map(s => {
    const isPort = !!s.listen_port;
    const proto = s.ssl ? 'https' : 'http';
    const host = isPort ? (window.serverIp || location.hostname) : s.domain;
    const accessUrl = isPort ? `http://${host}:${s.listen_port}` : `${proto}://${host}`;
    const domainLabel = isPort
      ? `${esc(s.domain)} <span style="font-size:11px;color:var(--cyan)">:${s.listen_port}</span>`
      : esc(s.domain);
    const typeInfo = SITE_TYPE_LABELS[s.type] || { text: s.type, icon: '•' };
    const typeLabel = typeInfo.icon + ' ' + typeInfo.text + (s.php_version ? ` ${esc(s.php_version)}` : '');
    const sitePath = `/var/www/${s.domain}/public`;
    return `
    <tr>
      <td>
        <span class="domain-pill">${domainLabel}</span>
        <div style="font-size:10px;color:var(--text-muted);font-family:var(--mono);margin-top:4px" title="Ruta física de los archivos">${esc(sitePath)}</div>
      </td>
      <td><span class="badge badge-purple">${typeLabel}</span></td>
      <td>${isPort
        ? '<span class="badge badge-amber" title="SSL requiere dominio">IP:Puerto</span>'
        : s.ssl ? '<span class="badge badge-green">🔒 SSL</span>' : '<span class="badge badge-yellow">Sin SSL</span>'}</td>
      <td><span class="badge ${s.status === 'active' ? 'badge-green' : 'badge-red'}">${esc(s.status)}</span></td>
      <td style="color:var(--text-muted)">${fmtDate(s.created_at)}</td>
      <td>
        <div style="display:flex;gap:4px;flex-wrap:wrap">
          <button class="btn btn-sm" onclick="window.open('${accessUrl}','_blank')" title="Abrir sitio en nueva pestaña"><i class="ti ti-external-link"></i></button>
          <button class="btn btn-sm" onclick="openSiteFiles('${esc(s.domain)}')" title="Ir a los archivos del sitio"><i class="ti ti-folder"></i></button>
          <button class="btn btn-sm" onclick="copyText('${esc(sitePath)}').then(()=>toast('Ruta copiada','success'))" title="Copiar ruta al portapapeles"><i class="ti ti-copy"></i></button>
          <button class="btn btn-sm" onclick="viewVhost(${s.id})" title="Ver configuración Nginx"><i class="ti ti-file-code"></i></button>
          <button class="btn btn-sm" onclick="rebuildVhost(${s.id}, event)" title="Regenerar configuración Nginx (útil tras cambiar versión de PHP)"><i class="ti ti-refresh"></i></button>
          ${!isPort && !s.ssl ? `<button class="btn btn-sm" onclick="installSiteSsl(${s.id}, '${esc(s.domain)}', event)" title="Instalar certificado Let's Encrypt">🔒 SSL</button>` : ''}
          <button class="btn btn-sm btn-danger" onclick="deleteWebsite(${s.id})" title="Eliminar sitio"><i class="ti ti-trash"></i></button>
        </div>
      </td>
    </tr>`;
  }).join('');
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
    if (sslGroup) sslGroup.style.display = 'none';
  } else {
    label.textContent = 'Dominio';
    input.placeholder = 'ejemplo.com';
    hint.textContent = '';
    if (sslGroup) sslGroup.style.display = '';
  }
}

// togglePhpVersion: muestra el selector de versión de PHP solo si el tipo es PHP.
function togglePhpVersion() {
  const type = document.getElementById('site-type').value;
  document.getElementById('site-php-version-group').style.display = type === 'php' ? '' : 'none';
}

// openNewSiteModal: abre el modal reseteando el formulario (antes mantenía
// los valores del intento anterior). Le da foco al input principal.
function openNewSiteModal() {
  document.getElementById('site-mode').value = 'domain';
  document.getElementById('site-domain').value = '';
  document.getElementById('site-type').value = 'html';
  const pv = document.getElementById('site-php-version');
  if (pv) pv.value = '';
  const ssl = document.getElementById('site-ssl');
  if (ssl) ssl.checked = false;
  toggleSiteMode();
  togglePhpVersion();
  openModal('modal-new-site');
  setTimeout(() => document.getElementById('site-domain')?.focus(), 100);
}

// createWebsite: envía el formulario para crear un sitio web nuevo.
// Bloquea el botón mientras la petición viaja para evitar dobles envíos.
async function createWebsite(evt) {
  const btn = evt?.currentTarget;
  const domain = document.getElementById('site-domain').value.trim();
  if (!domain) { toast('Introduce un dominio o nombre', 'error'); return; }
  const usePort = document.getElementById('site-mode').value === 'port';
  const type = document.getElementById('site-type').value;
  const phpVersion = type === 'php' ? document.getElementById('site-php-version').value : '';
  if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; }
  toast('Creando sitio web...', 'info');
  try {
    const r = await req('POST', '/websites', {
      domain, type, usePort,
      phpVersion: phpVersion || undefined,
      ssl: !usePort && document.getElementById('site-ssl')?.checked,
    });
    if (r?.success) {
      const msg = r.port ? `Sitio creado. Accede en http://${window.serverIp || 'tu-ip'}:${r.port}` : `Sitio ${domain} creado`;
      toast(msg, 'success');
      closeModal('modal-new-site');
      loadWebsites();
    } else toast(r?.error || 'Error al crear sitio', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.style.opacity = ''; }
  }
}

// installSiteSsl: instala un certificado Let's Encrypt en un sitio existente.
async function installSiteSsl(id, domain, evt) {
  if (!confirm(`Instalar SSL en ${domain}.\n\nEl dominio debe apuntar a este servidor y el puerto 80 estar abierto. ¿Continuar?`)) return;
  const btn = evt?.currentTarget;
  if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
  toast('Instalando certificado SSL... puede tardar un minuto', 'info');
  try {
    const r = await req('POST', `/websites/${id}/ssl`);
    if (r?.success) { toast(`SSL instalado en ${domain}`, 'success'); loadWebsites(); }
    else toast(r?.error || 'Error al instalar SSL. Comprueba que el DNS apunta a este servidor.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.style.opacity = ''; }
  }
}

// rebuildVhost: regenera el fichero de nginx del sitio (útil tras cambios
// internos como autodetección de PHP-FPM o ajustes de plantilla).
async function rebuildVhost(id, evt) {
  if (!confirm('¿Regenerar la configuración de Nginx de este sitio? No afecta a los archivos ni al SSL.')) return;
  const btn = evt?.currentTarget;
  if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
  try {
    const r = await req('POST', `/websites/${id}/rebuild-vhost`);
    toast(r?.success ? 'Vhost regenerado' : (r?.error || 'Error'), r?.success ? 'success' : 'error');
    if (r?.success) loadWebsites();
  } finally {
    if (btn) { btn.disabled = false; btn.style.opacity = ''; }
  }
}

// viewVhost: muestra el contenido del vhost de nginx en un modal (debugging).
async function viewVhost(id) {
  const r = await req('GET', `/websites/${id}/vhost`);
  if (!r?.success) { toast(r?.error || 'No se pudo leer el vhost', 'error'); return; }
  let mod = document.getElementById('website-vhost-modal');
  if (!mod) {
    mod = document.createElement('div');
    mod.id = 'website-vhost-modal';
    mod.className = 'modal-overlay';
    document.body.appendChild(mod);
  }
  // Guardamos el contenido en un data-attr para el botón "Copiar" — evita
  // problemas al escapar backticks/comillas dentro del onclick inline.
  mod.dataset.vhost = r.content || '';
  mod.innerHTML = `
    <div class="modal" style="max-width:720px">
      <div class="modal-header">
        <div class="modal-title">📄 Configuración Nginx</div>
        <button class="btn btn-sm" onclick="document.getElementById('website-vhost-modal').classList.remove('open')"><i class="ti ti-x"></i></button>
      </div>
      <div class="modal-body">
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;font-family:var(--mono)">${esc(r.path)}</div>
        <pre style="background:var(--bg-app);padding:12px;border-radius:var(--radius-sm);font-family:var(--mono);font-size:12px;overflow:auto;max-height:60vh;white-space:pre-wrap">${esc(r.content)}</pre>
      </div>
      <div class="modal-footer">
        <button class="btn" onclick="copyText(document.getElementById('website-vhost-modal').dataset.vhost).then(()=>toast('Copiado','success'))"><i class="ti ti-copy"></i> Copiar</button>
        <button class="btn btn-primary" onclick="document.getElementById('website-vhost-modal').classList.remove('open')">Cerrar</button>
      </div>
    </div>`;
  mod.classList.add('open');
}

// openSiteFiles: navega al gestor de archivos abriendo directamente la carpeta
// pública del sitio (/var/www/<dominio>/public) sin obligar a navegar niveles.
function openSiteFiles(domain) {
  window.currentFilePath = `/var/www/${domain}/public`;
  navigate('files');
}

// deleteWebsite: borra un sitio web (pide confirmación antes).
async function deleteWebsite(id) {
  if (!confirm('¿Eliminar este sitio web?')) return;
  const r = await req('DELETE', `/websites/${id}`);
  if (r?.success) { toast('Sitio eliminado', 'success'); loadWebsites(); }
  else toast(r?.error || 'Error', 'error');
}

Object.assign(window, {
  createWebsite, deleteWebsite, installSiteSsl, loadWebsites,
  togglePhpVersion, toggleSiteMode, openNewSiteModal,
  rebuildVhost, viewVhost, openSiteFiles,
});
