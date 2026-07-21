// TecXPaneL — websites (CRUD Nginx vhosts)

// ── Websites ──────────────────────────────────────────────────
// loadWebsites: pide la lista de sitios web y la pinta en la tabla.
async function loadWebsites() {
  const data = await req('GET', '/websites');
  if (!data) return;
  const tb = document.getElementById('websites-table');
  if (!data.length) { tb.innerHTML = '<tr><td colspan="6" class="empty-state">' + emptyState('world-off', 'Sin sitios web aún', 'Crear sitio web', "openModal('modal-new-site')") + '</td></tr>'; return; }
  tb.innerHTML = data.map(s => {
    const isPort = !!s.listen_port;
    const accessUrl = isPort ? `http://${serverIp || location.hostname}:${s.listen_port}` : `http://${s.domain}`;
    const domainLabel = isPort ? `${esc(s.domain)} <span style="font-size:11px;color:var(--cyan)">:${s.listen_port}</span>` : esc(s.domain);
    return `
    <tr>
      <td><span class="domain-pill">${domainLabel}</span></td>
      <td><span class="badge badge-purple">${esc(s.type)}${s.php_version ? ' '+esc(s.php_version) : ''}</span></td>
      <td>${isPort ? '<span class="badge badge-amber" title="SSL requiere dominio">IP:Puerto</span>' : s.ssl ? '<span class="badge badge-green">🔒 SSL</span>' : '<span class="badge badge-yellow">Sin SSL</span>'}</td>
      <td><span class="badge ${s.status === 'active' ? 'badge-green' : 'badge-red'}">${esc(s.status)}</span></td>
      <td style="color:var(--text-muted)">${fmtDate(s.created_at)}</td>
      <td>
        <div style="display:flex;gap:6px">
          <button class="btn btn-sm" onclick="window.open('${accessUrl}','_blank')" title="Abrir sitio"><i class="ti ti-external-link"></i> Abrir</button>
          ${!isPort && !s.ssl ? `<button class="btn btn-sm" onclick="installSiteSsl(${s.id}, '${esc(s.domain)}')" title="Instalar certificado Let's Encrypt">🔒 Instalar SSL</button>` : ''}
          <button class="btn btn-sm btn-danger" onclick="deleteWebsite(${s.id})" title="Eliminar sitio"><i class="ti ti-trash"></i> Eliminar</button>
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

// installSiteSsl: instala un certificado Let's Encrypt en un sitio existente.
async function installSiteSsl(id, domain) {
  if (!confirm(`Instalar SSL en ${domain}.\n\nEl dominio debe apuntar a este servidor y el puerto 80 estar abierto. ¿Continuar?`)) return;
  toast('Instalando certificado SSL... puede tardar un minuto', 'info');
  const r = await req('POST', `/websites/${id}/ssl`);
  if (r?.success) { toast(`SSL instalado en ${domain}`, 'success'); loadWebsites(); }
  else toast(r?.error || 'Error al instalar SSL. Comprueba que el DNS apunta a este servidor.', 'error');
}

// deleteWebsite: borra un sitio web (pide confirmación antes).
async function deleteWebsite(id) {
  if (!confirm('¿Eliminar este sitio web?')) return;
  const r = await req('DELETE', `/websites/${id}`);
  if (r?.success) { toast('Sitio eliminado', 'success'); loadWebsites(); }
  else toast(r?.error || 'Error', 'error');
}
