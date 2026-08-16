// TecXPaneL — backups (copias locales, config remota S3/SFTP, restore, planificación)

// ── Copias de seguridad ───────────────────────────────────────
// loadBackups: carga la programación guardada y la lista de backups disponibles.
async function loadBackups() {
  const data = await req('GET', '/backups');
  if (!data) return;
  loadBackupRemote();
  loadBackupResourceSummary();
  updateBackupMetrics(data);
  const s = data.schedule || {};
  document.getElementById('bk-enabled').checked = !!s.enabled;
  document.getElementById('bk-frequency').value = s.frequency || 'daily';
  document.getElementById('bk-time').value = s.time || '03:00';
  document.getElementById('bk-retention').value = s.retention_days || 7;

  const list = document.getElementById('backups-list');
  if (!data.backups.length) { list.innerHTML = '<div class="empty-state">' + emptyState('archive-off', 'Sin copias de seguridad aún — pulsa «Backup ahora»') + '</div>'; return; }
  list.innerHTML = '<div class="table-wrap"><table class="table"><thead><tr><th>Fecha</th><th>Tipo</th><th>Origen</th><th>Tamaño</th><th>Estado</th><th></th></tr></thead><tbody>' +
    data.backups.map((b) => `<tr>
      <td>${esc(b.created_at)}</td>
      <td>${esc(b.kind)}</td>
      <td>${esc(b.origin)}</td>
      <td>${fmtBytes(b.size_bytes)}</td>
      <td>${esc(b.status)}</td>
      <td>
        <button class="btn btn-sm" data-bk-lock onclick="backupRestore(${b.id})"><i class="ti ti-restore"></i></button>
        <button class="btn btn-sm" onclick="backupUpload(${b.id})" title="Subir al remoto"><i class="ti ti-cloud-upload"></i></button>
        <button class="btn btn-sm" onclick="backupDownload(${b.id})"><i class="ti ti-download"></i></button>
        <button class="btn btn-sm btn-danger" onclick="backupDelete(${b.id})"><i class="ti ti-trash"></i></button>
      </td></tr>`).join('') + '</tbody></table></div>';
}

function updateBackupMetrics(data) {
  const backups = Array.isArray(data.backups) ? data.backups : [];
  const successful = backups.filter(b => b.status === 'ok').sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const total = backups.reduce((sum, backup) => sum + Number(backup.size_bytes || 0), 0);
  const schedule = data.schedule || {};
  const last = successful[0];
  document.getElementById('bk-stat-last').textContent = last ? fmtDate(last.created_at) : 'Sin copias';
  document.getElementById('bk-stat-next').textContent = schedule.enabled ? (schedule.frequency === 'weekly' ? 'Semanal · ' : 'Diario · ') + (schedule.time || '03:00') : 'Desactivada';
  document.getElementById('bk-stat-count').textContent = String(backups.length);
  document.getElementById('bk-stat-size').textContent = fmtBytes(total);
}

async function loadBackupResourceSummary() {
  const target = document.getElementById('bk-resource-summary');
  if (!target) return;
  const data = await req('GET', '/backups/resources');
  if (!data) { target.innerHTML = '<div class="backup-resource-error">No se pudieron cargar los recursos.</div>'; return; }
  const resources = [
    ['ti-database', 'Bases de datos', (data.databases || []).length, 'metric-gold'],
    ['ti-world-www', 'Sitios web', (data.sites || []).length, 'metric-blue'],
    ['ti-app-window', 'Aplicaciones', (data.apps || []).length, 'metric-purple'],
    ['ti-settings', 'Panel', (data.panel || []).length, 'metric-green'],
  ];
  target.innerHTML = resources.map(item => '<div class="backup-resource-item"><div class="backup-resource-icon ' + item[3] + '"><i class="ti ' + item[0] + '"></i></div><div><span>' + item[1] + '</span><strong>' + item[2] + '</strong></div></div>').join('');
}

// ── Destino remoto de backups (S3/SFTP) ───────────────────────
async function loadBackupRemote() {
  const r = await req('GET', '/backups/remote');
  const s = (r && r.remote) || null;
  renderBackupRemoteSummary(s);
  if (s) {
    document.getElementById('rm-type').value = s.type;
    document.getElementById('rm-path').value = s.remote_path || '';
    document.getElementById('rm-encrypt').checked = !!s.encrypt_enabled;
    document.getElementById('rm-auto').checked = !!s.auto_upload;
    document.getElementById('rm-retention').value = s.retention_days || 30;
  }
  backupRemoteTypeChange();
  backupRemoteEncryptToggle();
}

function renderBackupRemoteSummary(s) {
  const target = document.getElementById('remote-summary');
  if (!target) return;
  target.innerHTML = s
    ? '<div class="backup-remote-state"><span class="backup-remote-state-dot"></span><strong>' + esc(s.type.toUpperCase()) + '</strong><span>' + esc(s.remote_path || '(raíz)') + '</span></div><div class="backup-remote-tags"><span>' + (s.encrypt_enabled ? '🔒 Cifrado activo' : 'Sin cifrado') + '</span><span>' + (s.auto_upload ? '☁️ Auto-subida activa' : 'Auto-subida inactiva') + '</span></div>'
    : '<div class="backup-remote-state is-empty"><span class="backup-remote-state-dot"></span><span>Aún no hay destino configurado</span></div>';
}

function backupRemoteTypeChange() {
  const t = document.getElementById('rm-type').value;
  document.getElementById('rm-s3').style.display = (t === 's3') ? '' : 'none';
  document.getElementById('rm-sftp').style.display = (t === 'sftp') ? '' : 'none';
}

function backupRemoteEncryptToggle() {
  document.getElementById('rm-cryptpass').style.display = document.getElementById('rm-encrypt').checked ? '' : 'none';
}

async function backupRemoteSave() {
  const t = document.getElementById('rm-type').value;
  const body = {
    type: t,
    remote_path: document.getElementById('rm-path').value.trim(),
    encrypt_enabled: document.getElementById('rm-encrypt').checked,
    crypt_pass: document.getElementById('rm-cryptpass').value,
    auto_upload: document.getElementById('rm-auto').checked,
    retention_days: +document.getElementById('rm-retention').value || 30,
  };
  if (t === 's3') Object.assign(body, {
    endpoint: document.getElementById('rm-endpoint').value.trim(),
    region: document.getElementById('rm-region').value.trim(),
    accessKey: document.getElementById('rm-akey').value.trim(),
    secretKey: document.getElementById('rm-skey').value,
  });
  else Object.assign(body, {
    host: document.getElementById('rm-host').value.trim(),
    port: +document.getElementById('rm-port').value || 22,
    user: document.getElementById('rm-user').value.trim(),
    password: document.getElementById('rm-pass').value,
    keyContent: document.getElementById('rm-key').value,
  });
  const r = await req('POST', '/backups/remote', body);
  if (r && r.error) { alert(r.error); return; }
  document.getElementById('rm-skey').value = '';
  document.getElementById('rm-pass').value = '';
  document.getElementById('rm-key').value = '';
  document.getElementById('rm-cryptpass').value = '';
  toast('Destino remoto guardado y verificado', 'success');
  loadBackupRemote();
}

async function backupRemoteTest() {
  const r = await req('POST', '/backups/remote/test');
  alert(r && r.ok ? '✅ Conexión correcta' : '❌ ' + ((r && (r.message || r.error)) || 'Fallo desconocido'));
}

async function backupRemoteClear() {
  if (!confirm('¿Desconectar el destino remoto? La config remota se borra (los archivos en el remoto NO se tocan).')) return;
  await req('DELETE', '/backups/remote');
  loadBackupRemote();
}

async function backupUpload(id) {
  const r = await req('POST', `/backups/${id}/upload`);
  if (r && r.error) alert(r.error); else alert('Subido al remoto.');
}

async function loadRemoteBackups() {
  const r = await req('GET', '/backups/remote/list');
  const el = document.getElementById('remote-list'); if (!el) return;
  if (!r || r.error) { el.innerHTML = `<p class="muted">${esc((r && r.error) || 'No se pudo listar')}</p>`; return; }
  if (!r.items.length) { el.innerHTML = '<p class="muted">Sin backups en el remoto.</p>'; return; }
  el.innerHTML = '<div class="table-wrap"><table class="table"><thead><tr><th>Nombre</th><th>Tamaño</th><th>Modificado</th><th></th></tr></thead><tbody>' +
    r.items.map((it) => `<tr>
      <td><code>${esc(it.name)}</code></td>
      <td>${fmtBytes(it.size)}</td>
      <td>${esc(it.modTime || '')}</td>
      <td style="text-align:right">
        <button class="btn btn-sm" onclick="backupRemoteRestore('${esc(it.name)}')"><i class="ti ti-restore"></i></button>
        <button class="btn btn-sm btn-danger" onclick="backupRemoteDelete('${esc(it.name)}')"><i class="ti ti-trash"></i></button>
      </td></tr>`).join('') + '</tbody></table></div>';
}

async function backupRemoteRestore(filename) {
  if (backupBusy) { toast('Ya hay una operación de backup en curso', 'info'); return; }
  if (!confirm(`Se descargará ${filename}, se creará un snapshot de seguridad y luego se restaurará el backup completo. ¿Continuar?`)) return;
  setBackupBusy(true);
  try {
    const con = document.getElementById('backups-console');
    con.style.display = 'block'; con.textContent = '';
    document.getElementById('bk-console-empty')?.style.setProperty('display', 'none');
    await streamConsole(`/backups/remote/${encodeURIComponent(filename)}/restore`, {}, con);
  } finally {
    setBackupBusy(false);
  }
  loadBackups();
}

async function backupRemoteDelete(filename) {
  if (!confirm(`¿Borrar ${filename} del remoto?`)) return;
  await req('DELETE', `/backups/remote/${encodeURIComponent(filename)}`);
  loadRemoteBackups();
}

// Cerrojo de reentrada: crear/restaurar comparten la misma consola y no deben
// solaparse. Se activa de forma síncrona (antes de cualquier await) para que un
// doble clic rápido no cuele dos operaciones a la vez.
let backupBusy = false;
function setBackupBusy(on) {
  backupBusy = on;
  document.querySelectorAll('[data-bk-lock]').forEach((el) => { el.disabled = on; });
}

async function backupNow(kind) {
  if (backupBusy) { toast('Ya hay una operación de backup en curso', 'info'); return; }
  setBackupBusy(true);
  try {
    const r = await req('GET', '/backups/resources');
    if (!r) return;
    const all = [...r.databases, ...r.sites, ...r.apps, ...r.panel];
    const con = document.getElementById('backups-console');
    con.style.display = 'block'; con.textContent = '';
    document.getElementById('bk-console-empty')?.style.setProperty('display', 'none');
    await streamConsole('/backups', { kind, resources: all }, con);
  } finally {
    setBackupBusy(false);
  }
  loadBackups();
}

async function backupRestore(id) {
  if (backupBusy) { toast('Ya hay una operación de backup en curso', 'info'); return; }
  setBackupBusy(true);
  try {
    const m = await req('GET', `/backups/${id}/manifest`);
    if (!m) return;
    if (!confirm('Se creará un snapshot de seguridad y luego se restaurará el backup completo. ¿Continuar?')) return;
    const con = document.getElementById('backups-console');
    con.style.display = 'block'; con.textContent = '';
    document.getElementById('bk-console-empty')?.style.setProperty('display', 'none');
    await streamConsole(`/backups/${id}/restore`, { items: m.manifest.items }, con);
  } finally {
    setBackupBusy(false);
  }
  loadBackups();
}

async function backupDownload(id) {
  // El middleware de auth solo acepta el header Authorization: Bearer, así que
  // descargamos con fetch (enviando el token) y forzamos la descarga vía blob.
  const res = await fetch(`${API}/api/backups/${id}/download`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) { alert('No se pudo descargar el backup'); return; }
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') || '';
  const name = (cd.match(/filename="?([^"]+)"?/) || [])[1] || 'backup.tar.gz';
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; document.body.appendChild(a); a.click();
  a.remove(); URL.revokeObjectURL(url);
}

async function backupDelete(id) {
  if (!confirm('¿Borrar esta copia de seguridad?')) return;
  await req('DELETE', `/backups/${id}`);
  loadBackups();
}

async function saveBackupSchedule() {
  const r = await req('GET', '/backups/resources');
  const all = r ? [...r.databases, ...r.sites, ...r.apps, ...r.panel] : [{ class: 'panel', name: 'panel' }];
  const body = {
    enabled: document.getElementById('bk-enabled').checked ? 1 : 0,
    frequency: document.getElementById('bk-frequency').value,
    time: document.getElementById('bk-time').value,
    retention_days: +document.getElementById('bk-retention').value,
    resources: all,
  };
  const res = await req('POST', '/backups/schedule', body);
  if (res) alert('Programación guardada');
}

Object.assign(window, {
  backupDelete, backupDownload, backupNow, backupRemoteClear, backupRemoteDelete,
  backupRemoteEncryptToggle, backupRemoteRestore, backupRemoteSave, backupRemoteTest,
  backupRemoteTypeChange, backupRestore, backupUpload, loadBackupRemote, loadBackups,
  loadRemoteBackups, saveBackupSchedule,
  loadBackupResourceSummary, updateBackupMetrics, renderBackupRemoteSummary,
});
