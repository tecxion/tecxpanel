// TecXPaneL — databases (MySQL/PostgreSQL CRUD, phpMyAdmin/Adminer)
let dbTools = { pma: {}, adminer: {} };
const dbPassShown = {};

// loadDatabases: lista las bases de datos y dibuja la tabla con sus acciones.
async function loadDatabases() {
  // Estado de las herramientas web (para los botones por fila)
  dbTools.pma = (await req('GET', '/databases/phpmyadmin/status')) || {};
  dbTools.adminer = (await req('GET', '/databases/adminer/status')) || {};

  const data = await req('GET', '/databases');
  if (!data) return;
  const tb = document.getElementById('databases-table');
  if (!data.length) { tb.innerHTML = '<tr><td colspan="8" class="empty-state">' + emptyState('database-off', 'Sin bases de datos', 'Nueva base de datos', "openModal('modal-new-db')") + '</td></tr>'; return; }
  tb.innerHTML = data.map(d => {
    const toolBtn = d.type === 'mysql'
      ? `<button class="btn btn-sm" onclick="openTool('pma')" title="Abrir phpMyAdmin"><i class="ti ti-table"></i></button>`
      : `<button class="btn btn-sm" onclick="openTool('adminer')" title="Abrir Adminer"><i class="ti ti-table"></i></button>`;
    return `
    <tr>
      <td style="font-weight:600;font-family:var(--mono)">${esc(d.name)}</td>
      <td><span class="badge ${d.type==='mysql'?'badge-blue':'badge-purple'}">${esc(d.type)}</span></td>
      <td style="font-family:var(--mono);font-size:12px">${esc(d.name)}</td>
      <td style="font-family:var(--mono);font-size:12px">${esc(d.db_user)}</td>
      <td>
        <span id="pass-${d.id}" style="font-family:var(--mono);font-size:12px">••••••••</span>
        <button class="btn btn-sm" onclick="toggleDbPass(${d.id})" title="Mostrar/ocultar"><i class="ti ti-eye" id="passicon-${d.id}"></i></button>
      </td>
      <td><span class="badge badge-green">${esc(d.status)}</span></td>
      <td style="color:var(--text-muted)">${fmtDate(d.created_at)}</td>
      <td>
        <div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end">
          ${toolBtn}
          <button class="btn btn-sm" onclick="testDbConnection(${d.id},event)" title="Probar conexión"><i class="ti ti-plug"></i></button>
          <button class="btn btn-sm" onclick="showDbInfo(${d.id},'${esc(d.name)}')" title="Tamaño y tablas"><i class="ti ti-info-circle"></i></button>
          <button class="btn btn-sm" onclick="copyConnString(${d.id},'${esc(d.type)}','${esc(d.name)}','${esc(d.db_user)}')" title="Copiar cadena de conexión"><i class="ti ti-link"></i></button>
          <button class="btn btn-sm" onclick="changeDbPassword(${d.id},'${esc(d.name)}')" title="Cambiar contraseña"><i class="ti ti-key"></i></button>
          <button class="btn btn-sm" onclick="downloadDbDump(${d.id},'${esc(d.name)}')" title="Descargar dump SQL"><i class="ti ti-download"></i></button>
          <button class="btn btn-sm" onclick="openRestoreDb(${d.id},'${esc(d.name)}')" title="Restaurar desde .sql"><i class="ti ti-upload"></i></button>
          <button class="btn btn-sm btn-danger" onclick="deleteDatabase(${d.id},'${esc(d.name)}')" title="Eliminar"><i class="ti ti-trash"></i></button>
        </div>
      </td>
    </tr>
  `;}).join('');
}

// ── Tanda 2/3: acciones extra ────────────────────────────────

async function testDbConnection(id, evt) {
  const btn = evt?.currentTarget;
  if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
  try {
    const r = await req('POST', `/databases/${id}/test`);
    if (r?.working) toast('✅ Conexión OK', 'success');
    else toast('❌ ' + (r?.error || 'No conecta'), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.style.opacity = ''; }
  }
}

async function showDbInfo(id, name) {
  toast('Consultando información...', 'info');
  const r = await req('GET', `/databases/${id}/info`);
  if (!r?.success) return;
  const mb = (r.bytes / (1024 * 1024)).toFixed(2);
  alert(`ℹ ${name}\n\nTamaño: ${mb} MB (${r.bytes.toLocaleString()} bytes)\nTablas: ${r.tables}`);
}

async function changeDbPassword(id, name) {
  const custom = prompt(`Nueva contraseña para "${name}" (deja vacío para generar una aleatoria de 24 caracteres):`);
  if (custom === null) return;
  const body = custom.trim() ? { password: custom.trim() } : {};
  const r = await req('POST', `/databases/${id}/password`, body);
  if (r?.success) {
    await copyText(r.password);
    toast(`Nueva contraseña copiada al portapapeles: ${r.password}`, 'success');
    loadDatabases();
  } else toast(r?.error || 'Error al cambiar contraseña', 'error');
}

function copyConnString(id, type, name, user) {
  const host = serverIp || location.hostname;
  const cmd = type === 'mysql'
    ? `mysql -h ${host} -u ${user} -p ${name}`
    : `psql -h ${host} -U ${user} -d ${name}`;
  copyText(cmd).then(() => toast('Cadena copiada — te pedirá contraseña al conectar', 'success'));
}

async function downloadDbDump(id, name) {
  toast('Generando dump...', 'info');
  const token = localStorage.getItem('txpl_token');
  const r = await fetch(`/api/databases/${id}/dump`, { headers: { Authorization: 'Bearer ' + token } });
  if (!r.ok) { const j = await r.json().catch(() => ({})); toast(j.error || 'Error al generar dump', 'error'); return; }
  const blob = await r.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name}-${Date.now()}.sql`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast('Dump descargado', 'success');
}

function openRestoreDb(id, name) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.sql,text/plain';
  input.onchange = async () => {
    const f = input.files[0];
    if (!f) return;
    if (!confirm(`⚠ Restaurar "${f.name}" (${(f.size / 1024).toFixed(1)} KB) sobre la BD "${name}".\n\nPuede sobrescribir datos existentes. ¿Continuar?`)) return;
    const sql = await f.text();
    toast('Restaurando...', 'info');
    const r = await req('POST', `/databases/${id}/restore`, { sql });
    if (r?.success) toast(`Restaurado (${r.bytes} bytes)`, 'success');
    else toast(r?.error || 'Error en restore', 'error');
  };
  input.click();
}

// toggleDbPass: muestra/oculta la contraseña de una base de datos (icono del ojo).
async function toggleDbPass(id) {
  const span = document.getElementById('pass-' + id);
  const icon = document.getElementById('passicon-' + id);
  if (dbPassShown[id]) {
    span.textContent = '••••••••';
    icon.className = 'ti ti-eye';
    dbPassShown[id] = false;
    return;
  }
  const r = await req('GET', `/databases/${id}/password`);
  if (r?.success && r.password) {
    span.textContent = r.password;
    icon.className = 'ti ti-eye-off';
    dbPassShown[id] = true;
  } else {
    toast(r?.error || 'No se pudo obtener la contraseña', 'error');
  }
}

// diagnoseDb: pregunta al backend qué método de acceso funciona para MySQL o
// PostgreSQL y muestra el resultado con instrucciones concretas si falla.
// Resuelve el clásico ERROR 1045 dando un mensaje accionable, no opaco.
async function diagnoseDb(kind) {
  const path = kind === 'mysql' ? '/databases/mysql/status' : '/databases/postgres/status';
  const label = kind === 'mysql' ? 'MySQL/MariaDB' : 'PostgreSQL';
  toast(`Comprobando acceso a ${label}...`, 'info');
  const r = await req('GET', path);
  if (!r) return;
  const title = r.working ? `✅ ${label} operativo` : `❌ ${label} no accesible`;
  const body = r.working
    ? `Método: <code>${esc(r.method || '—')}</code><br>Versión: <code>${esc(r.version || '—')}</code>`
    : `Método probado último: <code>${esc(r.method || '—')}</code><br>Error: <code>${esc(r.error || '—')}</code><br><br><strong>Cómo arreglarlo:</strong><br>${esc(r.hint || '')}`;
  let mod = document.getElementById('db-diag-modal');
  if (!mod) {
    mod = document.createElement('div');
    mod.id = 'db-diag-modal';
    mod.className = 'modal-overlay';
    document.body.appendChild(mod);
  }
  mod.innerHTML = `
    <div class="modal" style="max-width:560px">
      <div class="modal-header">
        <div class="modal-title">${title}</div>
        <button class="btn btn-sm" onclick="document.getElementById('db-diag-modal').classList.remove('open')"><i class="ti ti-x"></i></button>
      </div>
      <div class="modal-body" style="line-height:1.6">${body}</div>
      <div class="modal-footer">
        <button class="btn btn-primary" onclick="document.getElementById('db-diag-modal').classList.remove('open')">Cerrar</button>
      </div>
    </div>`;
  mod.classList.add('open');
}

// openTool: abre phpMyAdmin o Adminer en una pestaña nueva (IP:puerto).
// toolUrl: mejor URL para abrir una herramienta según su estado.
// Prioridad: https://dominio (443) → https://(dominio|IP):puerto (portSsl) →
// http://dominio → http://IP:puerto.
function toolUrl(t, host) {
  if (t.domain && t.ssl) return `https://${t.domain}`;
  if (t.portSsl) return `https://${t.domain || host}:${t.port}`;
  if (t.domain) return `http://${t.domain}`;
  return `http://${host}:${t.port}`;
}

function openTool(tool) {
  const host = serverIp || location.hostname;
  if (tool === 'pma') {
    if (dbTools.pma.configured) return window.open(toolUrl(dbTools.pma, host), '_blank');
    if (dbTools.pma.installed) {
      if (confirm('phpMyAdmin aún no está configurado para acceso web. ¿Configurarlo ahora?')) setupPma();
      return;
    }
    return toast('Instala el plugin phpMyAdmin desde la página Plugins primero.', 'error');
  }
  // adminer
  if (dbTools.adminer.configured) return window.open(toolUrl(dbTools.adminer, host), '_blank');
  if (dbTools.adminer.installed) {
    if (confirm('Adminer aún no está configurado para acceso web. ¿Configurarlo ahora?')) setupAdminer();
    return;
  }
  toast('Instala el plugin Adminer desde la página Plugins primero.', 'error');
}

// togglePortSsl: pone o quita HTTPS en el puerto de una herramienta.
// uiKey: 'pma' | 'adminer'. Mapea al endpoint real (phpmyadmin | adminer).
async function togglePortSsl(uiKey) {
  const endpoint = uiKey === 'pma' ? 'phpmyadmin' : 'adminer';
  const label = uiKey === 'pma' ? 'phpMyAdmin' : 'Adminer';
  const st = dbTools[uiKey] || {};
  if (!st.configured) { toast(`Configura ${label} primero (botón de la herramienta).`, 'error'); return; }
  const enabling = !st.portSsl;
  if (enabling && !st.domain) { toast(`Para HTTPS en el puerto, ${label} necesita un dominio con certificado. Config&uacute;ralo primero.`, 'error'); return; }
  const msg = enabling
    ? `Se activará HTTPS en el puerto ${st.port} de ${label} usando el certificado de ${st.domain}.\n\nA partir de entonces se entra por https://${st.domain}:${st.port} y DEJA de funcionar http://IP:${st.port}.\n\n¿Continuar?`
    : `Se quitará HTTPS del puerto ${st.port} de ${label}: volverá a http://IP:${st.port}.\n\n¿Continuar?`;
  if (!confirm(msg)) return;
  const r = await req('POST', `/databases/${endpoint}/port-ssl`, { enabled: enabling });
  if (r?.success) { toast(`Puerto de ${label}: HTTPS ${r.portSsl ? 'activado' : 'desactivado'} → ${r.portUrl}`, 'success'); loadDatabases(); }
  else toast(r?.error || 'Error', 'error');
}

// deleteDatabase: borra una base de datos y su usuario (con confirmación).
async function deleteDatabase(id, name) {
  if (!confirm(`⚠ Se eliminará la base de datos "${name}" Y su usuario de forma permanente. Todos los datos que contenga se perderán y no se pueden recuperar.\n\n¿Continuar?`)) return;
  const r = await req('DELETE', `/databases/${id}`);
  if (r?.success) { toast(`Base de datos "${name}" eliminada`, 'success'); loadDatabases(); }
  else toast(r?.error || 'Error al eliminar', 'error');
}

// createDatabase: crea una base de datos nueva; muestra la contraseña generada.
async function createDatabase() {
  const name = document.getElementById('db-name').value.trim();
  if (!name) { toast('Nombre de BD requerido', 'error'); return; }
  toast('Creando base de datos...', 'info');
  const r = await req('POST', '/databases', {
    type: document.getElementById('db-type').value, name,
    user: document.getElementById('db-user').value,
    password: document.getElementById('db-pass').value
  });
  if (r?.success) {
    toast(`BD ${name} creada. Usuario: ${r.user}`, 'success');
    closeModal('modal-new-db'); loadDatabases();
  } else toast(r?.error || 'Error', 'error');
}

// phpMyAdmin: configurar acceso web (instala PHP-FPM y crea el vhost)
// setupPma: configura el acceso web a phpMyAdmin (vhost de nginx en su puerto).
// setupPhpToolUI: flujo común de configuración para phpMyAdmin y Adminer.
// Pregunta por el subdominio (opcional) y muestra el resultado con las dos
// vías de acceso (puerto siempre; dominio+HTTPS si se indicó y hubo cert).
async function setupPhpToolUI(tool, label, defaultSub) {
  const domain = prompt(
    `Acceso web a ${label}.\n\n` +
    `• Con dominio (recomendado): escribe un subdominio, ej. ${defaultSub}\n` +
    '  El panel crea el vhost y emite certificado HTTPS automáticamente.\n' +
    '  IMPORTANTE: el subdominio debe apuntar YA (registro DNS A) a la IP del servidor.\n\n' +
    '• Sin dominio: deja el campo VACÍO y se sirve por http://IP:puerto\n\n' +
    'Podrás entrar por las DOS vías (puerto y dominio) si pones subdominio.\n\n' +
    'Subdominio (o vacío para solo IP:puerto):'
  );
  if (domain === null) return;
  const body = domain.trim() ? { domain: domain.trim() } : {};
  toast(`Configurando ${label} (puede tardar si emite certificado)...`, 'info');
  const r = await req('POST', `/databases/${tool}/setup`, body);
  if (!r?.success) { toast(r?.error || `Error configurando ${label}`, 'error'); return; }
  if (r.domain && r.ssl) toast(`${label} listo: ${r.domainUrl} (y también ${r.portUrl})`, 'success');
  else if (r.domain) toast(`${label} activo en ${r.portUrl}. ${r.message || 'SSL aún no emitido.'}`, 'info');
  else toast(`${label} listo en ${r.portUrl}`, 'success');
  loadDatabases();
}

async function setupPma() { return setupPhpToolUI('phpmyadmin', 'phpMyAdmin', 'phpmyadmin.tudominio.es'); }
async function setupAdminer() { return setupPhpToolUI('adminer', 'Adminer', 'adminer.tudominio.es'); }

// repairMysql: intenta "Opción A" (root → auth_socket + vaciar .env).
// Primero prueba sin credenciales; si el backend no puede entrar
// (needsPassword), pide la contraseña actual de root y reintenta pasándola
// como uso único (no se persiste).
async function repairMysql() {
  if (!confirm('Se cambiará el método de acceso de root@localhost a auth_socket y se vaciará MYSQL_ROOT_PASSWORD en .env.\n\nEl panel accederá a MySQL por socket (necesita correr como root, que es lo normal).\n\n¿Continuar?')) return;
  toast('Reparando MySQL...', 'info');
  let r = await req('POST', '/databases/mysql/repair');
  if (r?.needsPassword || (r && !r.success && /No se pudo reparar/i.test(r.error || ''))) {
    const cp = prompt('El panel no puede autenticar automáticamente. Pega la contraseña actual de root@localhost de MySQL (solo se usa para este ALTER, no se guarda). Cancela para reparar por SSH manualmente:');
    if (cp === null || !cp.trim()) return;
    r = await req('POST', '/databases/mysql/repair', { currentPassword: cp.trim() });
  }
  if (r?.success) toast('MySQL reparado. Ya puedes crear bases de datos.', 'success');
  else toast(r?.error || 'Error al reparar', 'error');
}

// editMysqlEnvPassword: modifica MYSQL_ROOT_PASSWORD en el .env desde el panel.
// El backend actualiza el fichero y process.env (surte efecto en caliente).
async function editMysqlEnvPassword() {
  const cur = await req('GET', '/databases/env/mysql-password');
  if (!cur) return;
  const status = cur.set ? `Actualmente HAY una contraseña (${cur.length} caracteres) en ${cur.envFile}` : `Actualmente NO hay contraseña en ${cur.envFile}`;
  const val = prompt(`${status}\n\nEscribe la nueva contraseña (deja vacío para BORRARLA y volver a auth_socket):`);
  if (val === null) return;
  const r = await req('PUT', '/databases/env/mysql-password', { password: val });
  if (r?.success) {
    toast(r.set ? 'Contraseña guardada en .env' : 'Contraseña vaciada en .env', 'success');
  } else {
    toast(r?.error || 'Error al guardar', 'error');
  }
}

Object.assign(window, {
  createDatabase, deleteDatabase, loadDatabases, openTool, setupPma, toggleDbPass,
  diagnoseDb,
  // v2 (tandas 2/3)
  testDbConnection, showDbInfo, changeDbPassword, copyConnString, downloadDbDump, openRestoreDb,
  // reparación / .env
  repairMysql, editMysqlEnvPassword,
  // adminer setup + toggle HTTPS puerto
  setupAdminer, togglePortSsl, toolUrl,
});
