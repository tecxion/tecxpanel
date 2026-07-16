// TecXPaneL — docker (contenedores, tabs, build, editor Dockerfile/compose)
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
