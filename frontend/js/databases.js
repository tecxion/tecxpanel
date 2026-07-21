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
      ? `<button class="btn btn-sm" onclick="openTool('pma')" title="Abrir phpMyAdmin"><i class="ti ti-table"></i> phpMyAdmin</button>`
      : `<button class="btn btn-sm" onclick="openTool('adminer')" title="Abrir Adminer"><i class="ti ti-table"></i> Adminer</button>`;
    return `
    <tr>
      <td style="font-weight:600;font-family:var(--mono)">${esc(d.name)}</td>
      <td><span class="badge ${d.type==='mysql'?'badge-blue':'badge-purple'}">${esc(d.type)}</span></td>
      <td style="font-family:var(--mono);font-size:12px">${esc(d.name)}</td>
      <td style="font-family:var(--mono);font-size:12px">${esc(d.db_user)}</td>
      <td>
        <span id="pass-${d.id}" style="font-family:var(--mono);font-size:12px">••••••••</span>
        <button class="btn btn-sm" onclick="toggleDbPass(${d.id})" title="Mostrar/ocultar contraseña"><i class="ti ti-eye" id="passicon-${d.id}"></i></button>
      </td>
      <td><span class="badge badge-green">${esc(d.status)}</span></td>
      <td style="color:var(--text-muted)">${fmtDate(d.created_at)}</td>
      <td>
        <div style="display:flex;gap:5px;justify-content:flex-end">
          ${toolBtn}
          <button class="btn btn-sm btn-danger" onclick="deleteDatabase(${d.id},'${esc(d.name)}')" title="Eliminar base de datos"><i class="ti ti-trash"></i> Eliminar</button>
        </div>
      </td>
    </tr>
  `;}).join('');
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
  if (r?.password) {
    span.textContent = r.password;
    icon.className = 'ti ti-eye-off';
    dbPassShown[id] = true;
  } else {
    toast('No se pudo obtener la contraseña', 'error');
  }
}

// openTool: abre phpMyAdmin o Adminer en una pestaña nueva (IP:puerto).
function openTool(tool) {
  const host = serverIp || location.hostname;
  if (tool === 'pma') {
    if (dbTools.pma.configured) return window.open(`http://${host}:${dbTools.pma.port}`, '_blank');
    if (dbTools.pma.installed) {
      if (confirm('phpMyAdmin aún no está configurado para acceso web. ¿Configurarlo ahora?')) setupPma();
      return;
    }
    return toast('Instala el plugin phpMyAdmin desde la página Plugins primero.', 'error');
  }
  // adminer
  if (dbTools.adminer.configured) return window.open(`http://${host}:${dbTools.adminer.port}`, '_blank');
  toast('Instala el plugin Adminer desde la página Plugins primero.', 'error');
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
async function setupPma() {
  toast('Configurando phpMyAdmin (puede instalar PHP-FPM)...', 'info');
  const r = await req('POST', '/databases/phpmyadmin/setup');
  if (r?.success) { toast('phpMyAdmin listo en el puerto ' + r.port, 'success'); loadDatabases(); }
  else toast(r?.error || 'Error configurando phpMyAdmin', 'error');
}
