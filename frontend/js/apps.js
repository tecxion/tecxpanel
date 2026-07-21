// TecXPaneL — apps (deploy Node/Python/React/TS, PM2, consola, git/webhook)
// ── Apps ──────────────────────────────────────────────────────
// loadApps: lista las aplicaciones desplegadas (PM2) con su estado y acciones.
async function loadApps() {
  const data = await req('GET', '/apps');
  if (!data) return;
  const tb = document.getElementById('apps-table');
  if (!data.length) { tb.innerHTML = '<tr><td colspan="6" class="empty-state">' + emptyState('brand-nodejs', 'Sin aplicaciones aún', 'Desplegar aplicación', "resetDeployModal();openModal('modal-new-app')") + '</td></tr>'; return; }

  const typeColors = { nodejs:'badge-green', typescript:'badge-blue', react:'badge-blue', python:'badge-yellow' };
  tb.innerHTML = data.map(a => `
    <tr>
      <td style="font-weight:600">${esc(a.name)}</td>
      <td><span class="badge ${typeColors[a.type]||'badge-purple'}">${esc(a.type)}</span></td>
      <td style="font-family:var(--mono);color:var(--cyan)">${esc(a.port || '—')}</td>
      <td><span class="badge ${a.status==='running'?'badge-green':'badge-red'}">${esc(a.status)}</span></td>
      <td>${a.domain ? `<span class="domain-pill">${esc(a.domain)}</span>` : '—'}</td>
      <td>
        <div style="display:flex;gap:5px;flex-wrap:wrap">
          ${a.status==='running'
            ? `<button class="btn btn-sm btn-danger" onclick="appAction(${a.id},'stop')" title="Parar"><i class="ti ti-player-stop"></i> Parar</button>
               <button class="btn btn-sm" onclick="appAction(${a.id},'restart')" title="Reiniciar"><i class="ti ti-refresh"></i> Reiniciar</button>`
            : `<button class="btn btn-sm btn-success" onclick="appAction(${a.id},'start')" title="Iniciar"><i class="ti ti-player-play"></i> Iniciar</button>`}
          <button class="btn btn-sm" onclick="installApp(${a.id},'${esc(a.name)}')" title="Instalar dependencias"><i class="ti ti-package"></i> Instalar</button>
          <button class="btn btn-sm" onclick="openAppConsole(${a.id},'${esc(a.name)}')" title="Consola en la carpeta"><i class="ti ti-terminal-2"></i> Consola</button>
          ${a.git_repo ? `<button class="btn btn-sm" onclick="openGitInfoModal(${a.id},'${esc(a.name)}','${esc(a.git_repo)}','${esc(a.git_branch)}','${esc(a.webhook_secret)}')" title="Git / Webhook"><i class="ti ti-git-fork"></i> Git</button>` : ''}
          <button class="btn btn-sm" onclick="viewAppLogs(${a.id},'${a.name}')" title="Logs"><i class="ti ti-file-text"></i> Logs</button>
          <button class="btn btn-sm btn-danger" onclick="appAction(${a.id},'delete')" title="Eliminar"><i class="ti ti-trash"></i> Eliminar</button>
        </div>
      </td>
    </tr>
  `).join('');
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
async function appAction(id, action) {
  if (action === 'delete' && !confirm('⚠ Se eliminará la aplicación Y TODOS sus archivos de forma permanente (carpeta, código, proxy y puerto). Esta acción no se puede deshacer.\n\n¿Continuar?')) return;
  const labels = { start: 'iniciada', stop: 'detenida', restart: 'reiniciada', delete: 'eliminada' };
  const r = await req('POST', `/apps/${id}/${action}`);
  if (r?.success) { toast(`App ${labels[action] || action}`, 'success'); loadApps(); }
  else toast(r?.error || 'Error', 'error');
}

// viewAppLogs: abre la página de Logs con esa app seleccionada como fuente.
async function viewAppLogs(id, name) {
  logsSrc = { type: 'app', id: String(id) };
  navigate(document.querySelector('[data-page=logs]'));
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

// runAppCommand: envía el comando escrito en la consola de la app y muestra su salida.
async function runAppCommand() {
  if (!consoleAppId) return;
  const input = document.getElementById('console-cmd');
  const command = input.value.trim();
  if (!command) return;
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

// consoleKeydown: ejecuta el comando al pulsar Enter en la consola de la app.
function consoleKeydown(e) {
  if (e.key === 'Enter') { e.preventDefault(); runAppCommand(); }
}

// installApp: instala las dependencias de una app ya creada (botón 📦).
async function installApp(id, name) {
  toast(`Instalando dependencias de "${name}"...`, 'info');
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
