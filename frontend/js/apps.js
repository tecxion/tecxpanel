// TecXPaneL — apps (deploy Node/Python/React/TS, PM2, consola, git/webhook)

// Etiquetas humanas por tipo — mismo patrón que websites.js.
const APP_TYPE_LABELS = {
  nodejs:     { text: 'Node.js',    icon: '🟢', badge: 'badge-green' },
  typescript: { text: 'TypeScript', icon: '🔷', badge: 'badge-blue' },
  react:      { text: 'React',      icon: '⚛️', badge: 'badge-blue' },
  python:     { text: 'Python',     icon: '🐍', badge: 'badge-yellow' },
};

// appAccessUrl: URL principal (dominio o IP:puerto). Reutiliza window.serverIp.
function appAccessUrl(a) {
  if (a.domain) return `http://${a.domain}`;
  if (a.port) return `http://${window.serverIp || location.hostname}:${a.port}`;
  return '';
}

// loadApps: lista las aplicaciones desplegadas (PM2) con su estado y acciones.
async function loadApps() {
  if (!window.serverIp) {
    const ipData = await req('GET', '/system/ip').catch(() => null);
    if (ipData?.ip && ipData.ip !== 'desconocida') window.serverIp = ipData.ip;
  }
  const data = await req('GET', '/apps');
  if (!data) return;
  const tb = document.getElementById('apps-table');
  if (!data.length) { tb.innerHTML = '<tr><td colspan="6" class="empty-state">' + emptyState('brand-nodejs', 'Sin aplicaciones aún', 'Desplegar aplicación', "resetDeployModal();openModal('modal-new-app')") + '</td></tr>'; return; }

  tb.innerHTML = data.map(a => {
    const info = APP_TYPE_LABELS[a.type] || { text: a.type, icon: '•', badge: 'badge-purple' };
    const url = appAccessUrl(a);
    const restartWarn = a.restarts > 5 ? `<span class="badge badge-amber" title="Reinicios acumulados PM2" style="margin-left:4px">↻${a.restarts}</span>` : '';
    const aJson = esc(JSON.stringify(a));
    return `
    <tr>
      <td>
        <div style="font-weight:600">${esc(a.name)}</div>
        <div style="font-size:10px;color:var(--text-muted);font-family:var(--mono);margin-top:4px" title="Ruta física">${esc(a.path || '—')}</div>
      </td>
      <td><span class="badge ${info.badge}">${info.icon} ${info.text}</span></td>
      <td style="font-family:var(--mono);color:var(--cyan)">${esc(a.port || '—')}</td>
      <td>
        <span class="badge ${a.status==='running'?'badge-green':a.status==='unknown'?'badge-yellow':'badge-red'}">${esc(a.status)}</span>${restartWarn}
      </td>
      <td>${a.domain ? `<span class="domain-pill">${esc(a.domain)}</span>` : '—'}</td>
      <td>
        <div style="display:flex;gap:4px;flex-wrap:wrap">
          ${url ? `<button class="btn btn-sm" onclick="window.open('${url}','_blank')" title="Abrir"><i class="ti ti-external-link"></i></button>
                   <button class="btn btn-sm" onclick="copyText('${url}').then(()=>toast('URL copiada','success'))" title="Copiar URL"><i class="ti ti-copy"></i></button>` : ''}
          ${a.status==='running'
            ? `<button class="btn btn-sm btn-danger" onclick="appAction(${a.id},'stop',event)" title="Parar"><i class="ti ti-player-stop"></i></button>
               <button class="btn btn-sm" onclick="appAction(${a.id},'restart',event)" title="Reiniciar"><i class="ti ti-refresh"></i></button>`
            : `<button class="btn btn-sm btn-success" onclick="appAction(${a.id},'start',event)" title="Iniciar"><i class="ti ti-player-play"></i></button>`}
          <button class="btn btn-sm" onclick="installApp(${a.id},'${esc(a.name)}',event)" title="Instalar dependencias"><i class="ti ti-package"></i></button>
          <button class="btn btn-sm" onclick="openAppConsole(${a.id},'${esc(a.name)}')" title="Consola"><i class="ti ti-terminal-2"></i></button>
          <button class="btn btn-sm" onclick='openEditAppModal(${aJson})' title="Editar configuración"><i class="ti ti-settings"></i></button>
          <button class="btn btn-sm" onclick="openEnvEditor(${a.id},'${esc(a.name)}')" title="Editar .env"><i class="ti ti-file-code-2"></i></button>
          ${a.domain ? `<button class="btn btn-sm" onclick="rebuildAppProxy(${a.id},event)" title="Regenerar proxy Nginx"><i class="ti ti-refresh-dot"></i></button>` : ''}
          ${a.git_repo ? `<button class="btn btn-sm" onclick="openGitInfoModal(${a.id},'${esc(a.name)}','${esc(a.git_repo)}','${esc(a.git_branch)}','${esc(a.webhook_secret)}')" title="Git / Webhook"><i class="ti ti-git-fork"></i></button>` : ''}
          <button class="btn btn-sm" onclick="viewAppLogs(${a.id},'${esc(a.name)}')" title="Logs"><i class="ti ti-file-text"></i></button>
          <button class="btn btn-sm btn-danger" onclick="appAction(${a.id},'delete',event)" title="Eliminar"><i class="ti ti-trash"></i></button>
        </div>
      </td>
    </tr>`;
  }).join('');
}

// rebuildAppProxy: regenera el vhost nginx sin borrar la app.
async function rebuildAppProxy(id, evt) {
  if (!confirm('¿Regenerar la configuración Nginx del proxy? No afecta a los archivos ni al SSL.')) return;
  const btn = evt?.currentTarget;
  if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
  try {
    const r = await req('POST', `/apps/${id}/rebuild-proxy`);
    toast(r?.success ? 'Proxy regenerado' : (r?.error || 'Error'), r?.success ? 'success' : 'error');
    if (r?.success) loadApps();
  } finally {
    if (btn) { btn.disabled = false; btn.style.opacity = ''; }
  }
}

// openEditAppModal: modal para editar comando/puerto/dominio/modo de una app.
function openEditAppModal(a) {
  let mod = document.getElementById('app-edit-modal');
  if (!mod) {
    mod = document.createElement('div');
    mod.id = 'app-edit-modal';
    mod.className = 'modal-overlay';
    document.body.appendChild(mod);
  }
  const isWorker = !a.port && !a.domain;
  mod.innerHTML = `
    <div class="modal" style="max-width:560px">
      <div class="modal-header">
        <div class="modal-title">⚙ Editar ${esc(a.name)}</div>
        <button class="btn btn-sm" onclick="document.getElementById('app-edit-modal').classList.remove('open')"><i class="ti ti-x"></i></button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label>Comando de arranque</label>
          <input type="text" id="edit-app-cmd" value="${esc(a.start_cmd || '')}" placeholder="npm start / node index.js / gunicorn app:app">
        </div>
        <div class="form-group">
          <label>Modo</label>
          <select id="edit-app-mode">
            <option value="web"${!isWorker?' selected':''}>Web (puerto + proxy)</option>
            <option value="worker"${isWorker?' selected':''}>Worker / Bot (sin puerto)</option>
          </select>
        </div>
        <div class="form-row">
          <div class="form-group"><label>Puerto</label><input type="number" id="edit-app-port" value="${a.port||''}" placeholder="3000"></div>
          <div class="form-group"><label>Dominio</label><input type="text" id="edit-app-domain" value="${esc(a.domain||'')}" placeholder="api.ejemplo.com"></div>
        </div>
        <div style="font-size:11px;color:var(--text-muted)">Reinicia la app tras guardar para aplicar los cambios.</div>
      </div>
      <div class="modal-footer">
        <button class="btn" onclick="document.getElementById('app-edit-modal').classList.remove('open')">Cancelar</button>
        <button class="btn btn-primary" onclick="saveAppEdit(${a.id},event)"><i class="ti ti-device-floppy"></i> Guardar</button>
      </div>
    </div>`;
  mod.classList.add('open');
}

async function saveAppEdit(id, evt) {
  const btn = evt?.currentTarget;
  const body = {
    start_cmd: document.getElementById('edit-app-cmd').value.trim(),
    mode: document.getElementById('edit-app-mode').value,
    port: document.getElementById('edit-app-port').value.trim(),
    domain: document.getElementById('edit-app-domain').value.trim(),
  };
  if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; }
  try {
    const r = await req('POST', `/apps/${id}/config`, body);
    if (r?.success) {
      toast('Configuración guardada — reinicia la app para aplicar', 'success');
      document.getElementById('app-edit-modal').classList.remove('open');
      loadApps();
    } else toast(r?.error || 'Error', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.style.opacity = ''; }
  }
}

// openEnvEditor: modal para leer/editar el .env de la app (guardado 600).
async function openEnvEditor(id, name) {
  const r = await req('GET', `/apps/${id}/env`);
  if (!r?.success) { toast(r?.error || 'No se pudo leer el .env', 'error'); return; }
  let mod = document.getElementById('app-env-modal');
  if (!mod) {
    mod = document.createElement('div');
    mod.id = 'app-env-modal';
    mod.className = 'modal-overlay';
    document.body.appendChild(mod);
  }
  mod.innerHTML = `
    <div class="modal" style="max-width:680px">
      <div class="modal-header">
        <div class="modal-title">🔐 .env de ${esc(name)}</div>
        <button class="btn btn-sm" onclick="document.getElementById('app-env-modal').classList.remove('open')"><i class="ti ti-x"></i></button>
      </div>
      <div class="modal-body">
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;font-family:var(--mono)">${esc(r.path)}${r.exists ? '' : ' <span style="color:var(--amber)">(no existe, se creará al guardar)</span>'}</div>
        <textarea id="app-env-content" style="width:100%;height:340px;font-family:var(--mono);font-size:12px;padding:10px;background:var(--bg-app);border:1px solid var(--border);border-radius:var(--radius-sm);resize:vertical" spellcheck="false">${esc(r.content || '')}</textarea>
        <div style="font-size:11px;color:var(--text-muted);margin-top:6px">Se guarda con permisos <code>600</code>. Reinicia la app para que los cambios surtan efecto.</div>
      </div>
      <div class="modal-footer">
        <button class="btn" onclick="document.getElementById('app-env-modal').classList.remove('open')">Cancelar</button>
        <button class="btn btn-primary" onclick="saveEnvEditor(${id},event)"><i class="ti ti-device-floppy"></i> Guardar</button>
      </div>
    </div>`;
  mod.classList.add('open');
}

async function saveEnvEditor(id, evt) {
  const btn = evt?.currentTarget;
  const content = document.getElementById('app-env-content').value;
  if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; }
  try {
    const r = await req('PUT', `/apps/${id}/env`, { content });
    if (r?.success) {
      toast(`Guardado (${r.bytes} bytes)`, 'success');
      document.getElementById('app-env-modal').classList.remove('open');
    } else toast(r?.error || 'Error al guardar', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.style.opacity = ''; }
  }
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
async function appAction(id, action, evt) {
  if (action === 'delete' && !confirm('⚠ Se eliminará la aplicación Y TODOS sus archivos de forma permanente (carpeta, código, proxy y puerto). Esta acción no se puede deshacer.\n\n¿Continuar?')) return;
  const btn = evt?.currentTarget;
  if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
  const labels = { start: 'iniciada', stop: 'detenida', restart: 'reiniciada', delete: 'eliminada' };
  try {
    const r = await req('POST', `/apps/${id}/${action}`);
    if (r?.success) { toast(`App ${labels[action] || action}`, 'success'); loadApps(); }
    else toast(r?.error || 'Error', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.style.opacity = ''; }
  }
}

// viewAppLogs: abre la página de Logs con esa app seleccionada como fuente.
async function viewAppLogs(id, name) {
  logsSrc = { type: 'app', id: String(id) };
  navigate('logs');
  const sel = document.getElementById('logs-app-select');
  if (sel) sel.value = String(id);
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

// Historial de la consola (compartido entre apps para simplificar).
const CONSOLE_HISTORY = [];
let consoleHistIdx = -1;

// runAppCommand: envía el comando escrito en la consola de la app y muestra su salida.
async function runAppCommand() {
  if (!consoleAppId) return;
  const input = document.getElementById('console-cmd');
  const command = input.value.trim();
  if (!command) return;
  // Guardar en historial (sin duplicar el último igual).
  if (CONSOLE_HISTORY[CONSOLE_HISTORY.length - 1] !== command) CONSOLE_HISTORY.push(command);
  consoleHistIdx = CONSOLE_HISTORY.length;
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

// consoleKeydown: Enter ejecuta; ↑↓ navega por el historial (estilo bash).
function consoleKeydown(e) {
  const input = e.currentTarget || document.getElementById('console-cmd');
  if (e.key === 'Enter') { e.preventDefault(); runAppCommand(); return; }
  if (e.key === 'ArrowUp') {
    if (!CONSOLE_HISTORY.length) return;
    e.preventDefault();
    consoleHistIdx = Math.max(0, consoleHistIdx - 1);
    input.value = CONSOLE_HISTORY[consoleHistIdx] || '';
    setTimeout(() => input.setSelectionRange(input.value.length, input.value.length), 0);
  } else if (e.key === 'ArrowDown') {
    if (!CONSOLE_HISTORY.length) return;
    e.preventDefault();
    consoleHistIdx = Math.min(CONSOLE_HISTORY.length, consoleHistIdx + 1);
    input.value = CONSOLE_HISTORY[consoleHistIdx] || '';
  }
}

// installApp: instala las dependencias de una app ya creada (botón 📦).
async function installApp(id, name, evt) {
  const btn = evt?.currentTarget;
  if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
  toast(`Instalando dependencias de "${name}"...`, 'info');
  try {
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
  } finally {
    if (btn) { btn.disabled = false; btn.style.opacity = ''; }
  }
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

Object.assign(window, {
  appAction, bindDeployDrop, confirmPythonConfig, consoleKeydown, copyWebhookUrl,
  deployLog, installApp, loadApps, openAppConsole, openGitInfoModal, renderDeploySteps,
  resetDeployModal, runAppCommand, setupDeployDrops, startDeploy, switchDeployTab,
  triggerGitPull, updateAppPathPreview, viewAppLogs,
  // v2
  openEditAppModal, saveAppEdit, openEnvEditor, saveEnvEditor, rebuildAppProxy, appAccessUrl,
});
