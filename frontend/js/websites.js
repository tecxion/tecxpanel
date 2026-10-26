// TecXPaneL — websites (CRUD Nginx vhosts)

// Etiquetas humanas para la columna Tipo (antes se pintaba "html", "nodejs"
// crudo en un badge, poco legible para usuarios no técnicos).
const SITE_TYPE_LABELS = {
  html:    { text: 'HTML',    icon: '📄' },
  php:     { text: 'PHP',     icon: '🐘' },
  nodejs:  { text: 'Node.js', icon: '🟢' },
  react:   { text: 'React',   icon: '⚛️' },
  python:  { text: 'Python',  icon: '🐍' },
  proxy:   { text: 'Proxy',   icon: '🔀' },
};

// loadWebsites: pide la lista de sitios web y la pinta en la tabla. Cachea la
// IP pública del servidor en window.serverIp (para "Abrir" en modo IP:puerto).
async function loadWebsites() {
  // La sección Sitios ahora también lista las apps desplegadas (fusión Sitios+Apps).
  window.loadApps?.();
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
    const isProxy = s.type === 'proxy';
    const typeLabel = typeInfo.icon + ' ' + typeInfo.text + (s.php_version ? ` ${esc(s.php_version)}` : '') + (isProxy ? ` :${s.proxy_port}` : '');
    const sitePath = `/var/www/${s.domain}/public`;
    return `
    <tr>
      <td>
        <span class="domain-pill">${domainLabel}</span>
        ${isProxy ? '' : `<div style="font-size:10px;color:var(--text-muted);font-family:var(--mono);margin-top:4px" title="Ruta física de los archivos">${esc(sitePath)}</div>`}
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
          ${isProxy ? '' : `<button class="btn btn-sm" onclick="openSiteFiles('${esc(s.domain)}')" title="Ir a los archivos del sitio"><i class="ti ti-folder"></i></button>
          <button class="btn btn-sm" onclick="copyText('${esc(sitePath)}').then(()=>toast('Ruta copiada','success'))" title="Copiar ruta al portapapeles"><i class="ti ti-copy"></i></button>`}
          ${s.git_repo ? `<button class="btn btn-sm" onclick="gitPullSite(${s.id}, event)" title="Actualizar desde Git (${esc(s.git_branch)})"><i class="ti ti-git-pull-request"></i></button>
          <button class="btn btn-sm" onclick="copySiteWebhook('${esc(s.webhook_secret)}')" title="Copiar URL del webhook (auto-actualizar en cada push)"><i class="ti ti-webhook"></i></button>` : ''}
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

// toggleSiteType: muestra solo los campos que aplican al tipo elegido
// (versión de PHP, puerto del proxy, origen del código).
function togglePhpVersion() {
  const type = document.getElementById('site-type').value;
  const show = (id, on) => { const el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; };
  show('site-php-version-group', type === 'php');
  show('site-proxy-port-group', type === 'proxy');
  show('site-source-mount', type !== 'proxy'); // un proxy no tiene archivos
}

// loadPhpVersions: rellena el selector con las versiones de PHP-FPM INSTALADAS.
// Las que no llevan el parche de php2shell salen deshabilitadas (el backend
// también las rechaza).
async function loadPhpVersions() {
  const sel = document.getElementById('site-php-version');
  if (!sel) return;
  sel.innerHTML = '<option value="">Auto-detectar</option>';
  const st = await req('GET', '/php/status').catch(() => null);
  for (const b of st?.branches || []) {
    const o = document.createElement('option');
    o.value = b.branch;
    o.disabled = !b.patched;
    o.textContent = `PHP ${b.branch}` + (b.patched ? ' ✓ parcheado' : ' ⚠ sin parchear (php2shell)');
    sel.appendChild(o);
  }
}

// openNewSiteModal: abre el modal reseteando el formulario (antes mantenía
// los valores del intento anterior). Le da foco al input principal.
function openNewSiteModal() {
  document.getElementById('site-mode').value = 'domain';
  document.getElementById('site-domain').value = '';
  document.getElementById('site-type').value = 'html';
  document.getElementById('site-proxy-port').value = '';
  document.getElementById('site-source-mount').innerHTML = sourceFieldsHtml('site', true);
  const pv = document.getElementById('site-php-version');
  if (pv) pv.value = '';
  const ssl = document.getElementById('site-ssl');
  if (ssl) ssl.checked = false;
  toggleSiteMode();
  togglePhpVersion();
  loadPhpVersions();
  openModal('modal-new-site');
  setTimeout(() => document.getElementById('site-domain')?.focus(), 100);
}

// ── Origen del código (compartido por el modal de sitio y el asistente de apps) ──
// `p` es el prefijo de los ids del formulario ('site' | 'dep').
// Opciones: vacío (solo sitios) · ZIP · archivos/carpeta sueltos · GitHub (público o privado).
function sourceFieldsHtml(p, withEmpty) {
  const radio = (v, label, checked) =>
    `<label style="font-weight:400"><input type="radio" name="${p}-src" value="${v}" ${checked ? 'checked' : ''} onchange="toggleSrc('${p}')"> ${label}</label>`;
  return `
    <div class="form-group"><label>Origen del c&oacute;digo</label>
      <div style="display:flex;gap:14px;flex-wrap:wrap;margin:4px 0 8px">
        ${withEmpty ? radio('empty', 'Vac&iacute;o', true) : ''}
        ${radio('zip', 'Subir ZIP', !withEmpty)}
        ${radio('files', 'Archivos / carpeta', false)}
        ${radio('git', 'GitHub', false)}
      </div>
      <div id="${p}-src-zip" style="display:${withEmpty ? 'none' : ''}"><input type="file" id="${p}-zip" accept=".zip,.tar,.tar.gz,.tgz"></div>
      <div id="${p}-src-files" style="display:none">
        <label style="font-weight:400;font-size:12px">Archivos sueltos</label> <input type="file" id="${p}-files" multiple>
        <label style="font-weight:400;font-size:12px;display:block;margin-top:6px">&hellip;o una carpeta entera</label> <input type="file" id="${p}-dir" webkitdirectory multiple>
      </div>
      <div id="${p}-src-git" style="display:none">
        <input id="${p}-git" placeholder="https://github.com/usuario/repo.git" style="width:100%;margin-bottom:6px">
        <input id="${p}-branch" placeholder="main" value="main" style="width:100%;margin-bottom:6px">
        <input id="${p}-token" type="password" autocomplete="off" placeholder="Token de acceso (solo si el repo es privado)" style="width:100%">
        <small class="muted">El token se guarda cifrado. Tras crear, el bot&oacute;n webhook te da la URL para actualizar en cada push.</small>
      </div>
      ${p === 'site' ? '<small class="muted" id="site-src-hint" style="display:block;margin-top:6px">Se guardar&aacute; en la carpeta p&uacute;blica del sitio (/var/www/&lt;dominio&gt;/public/).</small>' : ''}
    </div>`;
}

// toggleSrc: enseña solo el bloque de la opción elegida.
function toggleSrc(p) {
  const v = document.querySelector(`input[name="${p}-src"]:checked`)?.value;
  for (const k of ['zip', 'files', 'git']) {
    const el = document.getElementById(`${p}-src-${k}`);
    if (el) el.style.display = v === k ? '' : 'none';
  }
}

// readSource: lee y valida el formulario de origen. Devuelve { error } o los datos.
function readSource(p) {
  const v = (id) => document.getElementById(`${p}-${id}`)?.value.trim() || '';
  const src = document.querySelector(`input[name="${p}-src"]:checked`)?.value || 'empty';
  const zip = document.getElementById(`${p}-zip`)?.files[0];
  const files = [...(document.getElementById(`${p}-files`)?.files || []), ...(document.getElementById(`${p}-dir`)?.files || [])];
  if (src === 'zip' && !zip) return { error: 'Selecciona un archivo ZIP' };
  if (src === 'files' && !files.length) return { error: 'Selecciona archivos o una carpeta' };
  if (src === 'git' && !v('git')) return { error: 'Indica la URL del repositorio' };
  return { src, zip, files, repo: v('git'), branch: v('branch') || 'main', token: v('token') };
}

// uploadSource: sube el ZIP o los archivos a `destDir` conservando la estructura de
// carpetas (de una carpeta elegida se quita el primer nivel: su propio nombre).
// Devuelve un mensaje de error o null si todo fue bien.
async function uploadSource(destDir, s, log = () => {}) {
  const list = s.src === 'zip' ? [s.zip] : s.files;
  let n = 0;
  for (const f of list) {
    const rel = f.webkitRelativePath ? f.webkitRelativePath.split('/').slice(1).join('/') : f.name;
    log(`📤 Subiendo ${rel} (${++n}/${list.length})`);
    const up = await uploadBinary(f, destDir + '/' + rel);
    if (!up?.success) return up?.tooBig ? 'Archivo demasiado grande para Nginx (sube client_max_body_size).' : `No se pudo subir ${rel}`;
  }
  return null;
}

// createWebsite: envía el formulario para crear un sitio web nuevo.
// Bloquea el botón mientras la petición viaja para evitar dobles envíos.
async function createWebsite(evt) {
  const type = document.getElementById('site-type').value;
  const domain = document.getElementById('site-domain').value.trim();
  const usePort = document.getElementById('site-mode').value === 'port';
  const btn = evt?.currentTarget;
  if (!domain) { toast('Introduce un dominio o nombre', 'error'); return; }
  const proxyPort = document.getElementById('site-proxy-port').value;
  if (type === 'proxy' && !proxyPort) { toast('Indica el puerto local del proxy', 'error'); return; }
  const s = type === 'proxy' ? { src: 'empty' } : readSource('site');
  if (s.error) { toast(s.error, 'error'); return; }
  const phpVersion = type === 'php' ? document.getElementById('site-php-version').value : '';
  if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; }
  toast('Creando sitio web...', 'info');
  try {
    const body = {
      domain, type, usePort,
      phpVersion: phpVersion || undefined,
      proxyPort: type === 'proxy' ? proxyPort : undefined,
      ssl: !usePort && document.getElementById('site-ssl')?.checked,
    };
    // GitHub: el servidor clona directamente en la carpeta pública.
    if (s.src === 'git') Object.assign(body, { git_repo: s.repo, git_branch: s.branch, git_token: s.token || undefined });
    const r = await req('POST', '/websites', body);
    if (!r?.success) { toast(r?.error || 'Error al crear sitio', 'error'); return; }

    // Archivos: se suben a la carpeta pública y, si es un ZIP, se descomprime allí.
    if (s.src === 'zip' || s.src === 'files') {
      toast('Subiendo archivos...', 'info');
      const err = await uploadSource(`/var/www/${domain}/public`, s);
      const ext = !err && s.src === 'zip' ? await req('POST', `/websites/${r.id}/extract`) : null;
      if (err || (ext && !ext.success)) {
        toast(`Sitio creado, pero: ${err || ext.error}`, 'error');
        closeModal('modal-new-site'); loadWebsites(); return;
      }
    }
    toast(r.port ? `Sitio creado. Accede en http://${window.serverIp || 'tu-ip'}:${r.port}` : `Sitio ${domain} creado`, 'success');
    closeModal('modal-new-site');
    loadWebsites();
  } finally {
    if (btn) { btn.disabled = false; btn.style.opacity = ''; }
  }
}

// gitPullSite: actualiza un sitio con Git desde el panel (equivale al webhook).
async function gitPullSite(id, evt) {
  const btn = evt?.currentTarget;
  if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
  try {
    const r = await req('POST', `/websites/${id}/git-pull`);
    toast(r?.success ? 'Sitio actualizado desde Git' : (r?.error || 'Error al actualizar'), r?.success ? 'success' : 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.style.opacity = ''; }
  }
}

// copySiteWebhook: copia la URL que GitHub debe llamar en cada push.
function copySiteWebhook(secret) {
  copyText(`${window.location.origin}/api/webhooks/deploy/${secret}`).then(() => toast('URL del webhook copiada', 'success'));
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

// ── Asistente de despliegue de apps (Node/Python/React; el tipo se autodetecta) ──
// Crea la app, sube los archivos (o clona Git) y llama al endpoint único /deploy que
// hace todo de una pasada (detectar → instalar → build → arrancar → proxy) con
// streaming. El código queda en /var/www/<nombre>/.
function openDeployWizard() {
  document.getElementById('modal-deploy-app')?.remove();
  const mod = document.createElement('div');
  mod.className = 'modal-overlay open';
  mod.id = 'modal-deploy-app';
  mod.innerHTML = `
    <div class="modal" style="max-width:640px">
      <div class="modal-header">
        <div class="modal-title">🚀 Nueva app</div>
        <button class="btn btn-sm" onclick="document.getElementById('modal-deploy-app').remove()"><i class="ti ti-x"></i></button>
      </div>
      <div class="modal-body">
        <div class="form-group"><label>Nombre de la app</label><input id="dep-name" placeholder="mi-app"><small class="muted">Se guardar&aacute; en /var/www/&lt;nombre&gt;/</small></div>
        <div class="form-group"><label>Dominio (opcional)</label><input id="dep-domain" placeholder="app.midominio.com"><small class="muted">Sin dominio se sirve por IP:puerto.</small></div>
        ${sourceFieldsHtml('dep', false)}
        <div class="console" id="dep-console" style="display:none;white-space:pre-wrap;word-break:break-word;max-height:340px;overflow:auto;margin-top:10px;background:#050805;color:#33ff66;font-family:var(--mono),monospace;font-size:12px;line-height:1.5;padding:12px;border-radius:8px;border:1px solid #1c3a24"></div>
      </div>
      <div class="modal-footer">
        <button class="btn" onclick="document.getElementById('modal-deploy-app').remove()">Cerrar</button>
        <button class="btn btn-primary" id="dep-go" onclick="submitDeploy()">🚀 Desplegar</button>
      </div>
    </div>`;
  document.body.appendChild(mod);
  setTimeout(() => document.getElementById('dep-name')?.focus(), 100);
}

async function submitDeploy() {
  const name = document.getElementById('dep-name').value.trim();
  const domain = document.getElementById('dep-domain').value.trim();
  if (!name) { toast('Indica un nombre para la app', 'error'); return; }
  const s = readSource('dep');
  if (s.error) { toast(s.error, 'error'); return; }

  const con = document.getElementById('dep-console');
  const go = document.getElementById('dep-go');
  const log = (t) => { con.textContent += t + '\n'; con.scrollTop = con.scrollHeight; };
  con.style.display = 'block'; con.textContent = '';
  if (go) go.disabled = true;
  try {
    log('⏳ Creando la app...');
    const createData = { name };
    if (domain) createData.domain = domain;
    if (s.src === 'git') Object.assign(createData, { git_repo: s.repo, git_branch: s.branch, git_token: s.token || undefined });
    const created = await req('POST', '/apps', createData);
    // Fallo ANTES de arrancar el despliegue → se puede corregir y reintentar.
    if (!created?.id) { log('✖ ' + (created?.error || 'No se pudo crear la app')); if (go) go.disabled = false; return; }
    if (s.src !== 'git') {
      const err = await uploadSource(created.path, s, log);
      if (err) { log('✖ ' + err); if (go) go.disabled = false; return; }
    }
    await streamDeploy(created.id, con);
    // Despliegue terminado: no se vuelve a desplegar desde esta ventana; solo cerrar.
    if (go) go.style.display = 'none';
    loadWebsites();
  } catch (e) {
    log('✖ ' + (e?.message || e));
    if (go) go.disabled = false;
  }
}

// streamDeploy: llama a POST /apps/:id/deploy y vuelca el streaming en la consola.
async function streamDeploy(id, el) {
  const DONE = '__TXPL_DONE__';
  let r;
  try {
    r = await fetch(API + '/api/apps/' + id + '/deploy', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
  } catch (e) { el.textContent += '✖ ' + (e.message || 'Error de conexión') + '\n'; return 1; }
  if (r.status === 401) { doLogout(); return 1; }
  if (!r.ok || !r.body) {
    let m = 'Error HTTP ' + r.status;
    try { m = (await r.json()).error || m; } catch (_) {}
    el.textContent += '✖ ' + m + '\n'; return 1;
  }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', code = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let show = buf;
    const i = buf.indexOf(DONE);
    if (i >= 0) { code = parseInt(buf.slice(i + DONE.length).trim(), 10) || 0; show = buf.slice(0, i); }
    el.textContent = show; el.scrollTop = el.scrollHeight;
  }
  toast(code === 0 ? 'Despliegue completado' : 'El despliegue falló (revisa la consola)', code === 0 ? 'success' : 'error');
  return code;
}

// redeployApp: redespliegue en un clic sobre los ficheros ACTUALES de la app
// (sin subir nada). Reejecuta detectar → instalar → build → arrancar → proxy vía
// el endpoint idempotente /apps/:id/deploy (se salta la extracción si no hay ZIP).
// Para traer código nuevo de Git usa el botón Git/Webhook (git-pull) de la fila.
async function redeployApp(id, name) {
  if (!confirm(`¿Volver a desplegar "${name}"?\n\nSe reinstalan dependencias, se recompila y se reinicia sobre los archivos que ya hay en el servidor. No sube código nuevo.`)) return;
  document.getElementById('modal-redeploy')?.remove();
  const mod = document.createElement('div');
  mod.className = 'modal-overlay open';
  mod.id = 'modal-redeploy';
  mod.innerHTML = `
    <div class="modal" style="max-width:640px">
      <div class="modal-header">
        <div class="modal-title">🔄 Redesplegar ${esc(name)}</div>
        <button class="btn btn-sm" onclick="document.getElementById('modal-redeploy').remove()"><i class="ti ti-x"></i></button>
      </div>
      <div class="modal-body">
        <div class="console" id="redeploy-console" style="white-space:pre-wrap;word-break:break-word;max-height:400px;overflow:auto"></div>
      </div>
      <div class="modal-footer">
        <button class="btn" onclick="document.getElementById('modal-redeploy').remove()">Cerrar</button>
      </div>
    </div>`;
  document.body.appendChild(mod);
  const con = document.getElementById('redeploy-console');
  con.textContent = '🔄 Redesplegando sobre los archivos actuales...\n';
  await streamDeploy(id, con);
  loadApps();
}

Object.assign(window, {
  createWebsite, deleteWebsite, installSiteSsl, loadWebsites,
  togglePhpVersion, loadPhpVersions, toggleSiteMode, openNewSiteModal,
  rebuildVhost, viewVhost, openSiteFiles, gitPullSite, copySiteWebhook,
  sourceFieldsHtml, toggleSrc, readSource, uploadSource,
  openDeployWizard, submitDeploy, streamDeploy, redeployApp,
});
