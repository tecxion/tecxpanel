// ── Copias de seguridad ───────────────────────────────────────
// loadBackups: carga la programación guardada y la lista de backups disponibles.
async function loadBackups() {
  const data = await req('GET', '/backups');
  if (!data) return;
  const s = data.schedule || {};
  document.getElementById('bk-enabled').checked = !!s.enabled;
  document.getElementById('bk-frequency').value = s.frequency || 'daily';
  document.getElementById('bk-time').value = s.time || '03:00';
  document.getElementById('bk-retention').value = s.retention_days || 7;

  const list = document.getElementById('backups-list');
  if (!data.backups.length) { list.innerHTML = '<p class="muted">Aún no hay copias de seguridad.</p>'; return; }
  list.innerHTML = '<table class="table"><thead><tr><th>Fecha</th><th>Tipo</th><th>Origen</th><th>Tamaño</th><th>Estado</th><th></th></tr></thead><tbody>' +
    data.backups.map((b) => `<tr>
      <td>${esc(b.created_at)}</td>
      <td>${esc(b.kind)}</td>
      <td>${esc(b.origin)}</td>
      <td>${fmtBytes(b.size_bytes)}</td>
      <td>${esc(b.status)}</td>
      <td>
        <button class="btn btn-sm" onclick="backupRestore(${b.id})"><i class="ti ti-restore"></i></button>
        <button class="btn btn-sm" onclick="backupUpload(${b.id})" title="Subir al remoto"><i class="ti ti-cloud-upload"></i></button>
        <button class="btn btn-sm" onclick="backupDownload(${b.id})"><i class="ti ti-download"></i></button>
        <button class="btn btn-sm btn-danger" onclick="backupDelete(${b.id})"><i class="ti ti-trash"></i></button>
      </td></tr>`).join('') + '</tbody></table>';
  loadBackupRemote();
}

// ── Destino remoto de backups (S3/SFTP) ───────────────────────
async function loadBackupRemote() {
  const r = await req('GET', '/backups/remote');
  const s = (r && r.remote) || null;
  document.getElementById('remote-summary').textContent = s
    ? `Configurado: ${s.type.toUpperCase()} → ${s.remote_path || '(raíz)'} · cifrado: ${s.encrypt_enabled ? 'sí' : 'no'} · auto-subida: ${s.auto_upload ? 'sí' : 'no'} · estado: ${s.status}`
    : 'Aún no hay destino remoto configurado.';
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
  alert('Guardado.');
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
  el.innerHTML = '<table class="table"><thead><tr><th>Nombre</th><th>Tamaño</th><th>Modificado</th><th></th></tr></thead><tbody>' +
    r.items.map((it) => `<tr>
      <td><code>${esc(it.name)}</code></td>
      <td>${fmtBytes(it.size)}</td>
      <td>${esc(it.modTime || '')}</td>
      <td style="text-align:right">
        <button class="btn btn-sm" onclick="backupRemoteRestore('${esc(it.name)}')"><i class="ti ti-restore"></i></button>
        <button class="btn btn-sm btn-danger" onclick="backupRemoteDelete('${esc(it.name)}')"><i class="ti ti-trash"></i></button>
      </td></tr>`).join('') + '</tbody></table>';
}

async function backupRemoteRestore(filename) {
  if (!confirm(`Se descargará ${filename}, se creará un snapshot de seguridad y luego se restaurará el backup completo. ¿Continuar?`)) return;
  const con = document.getElementById('backups-console');
  con.style.display = 'block'; con.textContent = '';
  await streamConsole(`/backups/remote/${encodeURIComponent(filename)}/restore`, {}, con);
  loadBackups();
}

async function backupRemoteDelete(filename) {
  if (!confirm(`¿Borrar ${filename} del remoto?`)) return;
  await req('DELETE', `/backups/remote/${encodeURIComponent(filename)}`);
  loadRemoteBackups();
}

async function backupNow(kind) {
  const r = await req('GET', '/backups/resources');
  if (!r) return;
  const all = [...r.databases, ...r.sites, ...r.apps, ...r.panel];
  const con = document.getElementById('backups-console');
  con.style.display = 'block'; con.textContent = '';
  await streamConsole('/backups', { kind, resources: all }, con);
  loadBackups();
}

async function backupRestore(id) {
  const m = await req('GET', `/backups/${id}/manifest`);
  if (!m) return;
  if (!confirm('Se creará un snapshot de seguridad y luego se restaurará el backup completo. ¿Continuar?')) return;
  const con = document.getElementById('backups-console');
  con.style.display = 'block'; con.textContent = '';
  await streamConsole(`/backups/${id}/restore`, { items: m.manifest.items }, con);
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

// ── Correo (docker-mailserver) ─────────────────────────────────
// Streaming reutilizable (mismo patrón que streamConsole de backups).
async function mailStream(path, body, el, method = 'POST') {
  const DONE = '__TXPL_DONE__';
  const r = await fetch(API + '/api' + path, {
    method,
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (r.status === 401) { doLogout(); return 1; }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', code = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let show = buf;
    const idx = buf.indexOf(DONE);
    if (idx >= 0) { code = parseInt(buf.slice(idx + DONE.length).trim(), 10) || 0; show = buf.slice(0, idx); }
    el.textContent = show; el.scrollTop = el.scrollHeight;
  }
  return code;
}

async function loadMail() {
  const st = await req('GET', '/mail/status');
  if (!st) return;
  const body = document.getElementById('mail-body');
  if (!st.docker) {
    body.innerHTML = '<div class="card"><p>El correo necesita <b>Docker</b>. Instálalo desde <a href="#" onclick="navigate(document.querySelector(\'[data-page=plugins]\'));return false">Plugins</a>.</p></div>';
    return;
  }
  if (st.state === 'not_installed') {
    body.innerHTML = `<div class="card">
      <h3>Instalar correo</h3>
      <p class="muted">Instala docker-mailserver (un contenedor). Necesita ~1 GB de RAM y abrirá los puertos 25/465/587/143/993.</p>
      <button class="btn btn-primary" onclick="mailInstall()"><i class="ti ti-download"></i> Instalar correo</button>
    </div>`;
    return;
  }
  if (st.state === 'stopped') {
    body.innerHTML = `<div class="card"><p>El correo está instalado pero parado.</p>
      <button class="btn btn-success" onclick="mailAction('start')"><i class="ti ti-player-play"></i> Arrancar</button>
      <button class="btn btn-danger" onclick="mailUninstall()"><i class="ti ti-trash"></i> Desinstalar</button></div>`;
    return;
  }
  if (st.state === 'needs_config') {
    body.innerHTML = `<div class="card">
      <h3>Configurar el correo</h3>
      <p class="muted">Indica el hostname del correo (ej. <code>mail.tudominio.com</code>). El panel emitirá el certificado TLS con Certbot.</p>
      <div class="form-row"><input type="text" id="mail-hostname" placeholder="mail.tudominio.com" style="width:320px"></div>
      <button class="btn btn-primary" onclick="mailSaveConfig()"><i class="ti ti-device-floppy"></i> Guardar y emitir TLS</button>
    </div>`;
    return;
  }
  // ready
  body.innerHTML = `
    <div class="card">
      <h3><i class="ti ti-settings"></i> Configuración</h3>
      <p>Hostname: <b>${esc(st.hostname)}</b> · Dominio: <b>${esc(st.domain)}</b></p>
      <button class="btn btn-sm" onclick="mailAction('restart')"><i class="ti ti-refresh"></i> Reiniciar</button>
      <button class="btn btn-sm btn-danger" onclick="mailUninstall()"><i class="ti ti-trash"></i> Desinstalar</button>
    </div>
    <div class="card">
      <h3><i class="ti ti-inbox"></i> Buzones</h3>
      <div class="form-row">
        <input type="text" id="mb-addr" placeholder="usuario@${esc(st.domain)}" style="width:240px">
        <input type="password" id="mb-pass" placeholder="Contraseña" style="width:180px">
        <button class="btn btn-primary" onclick="mailAddMailbox()">Crear</button>
      </div>
      <div id="mail-mailboxes">Cargando…</div>
    </div>
    <div class="card">
      <h3><i class="ti ti-arrows-right"></i> Alias</h3>
      <div class="form-row">
        <input type="text" id="al-src" placeholder="info@${esc(st.domain)}" style="width:220px">
        <input type="text" id="al-dst" placeholder="destino@${esc(st.domain)}" style="width:220px">
        <button class="btn btn-primary" onclick="mailAddAlias()">Crear alias</button>
      </div>
      <div id="mail-aliases">Cargando…</div>
    </div>
    <div class="card">
      <h3><i class="ti ti-shield-lock"></i> DKIM y DNS</h3>
      <button class="btn" onclick="mailGenDkim()"><i class="ti ti-key"></i> Generar DKIM</button>
      <button class="btn" onclick="mailLoadDns()"><i class="ti ti-list"></i> Ver registros DNS</button>
      <div id="mail-dns"></div>
      <h3 style="margin-top:1.5rem"><i class="ti ti-inbox"></i> Webmail (Roundcube)</h3>
      <div id="mail-webmail">Cargando…</div>
    </div>`;
  loadMailboxes(); loadAliases(); loadWebmail();
}

async function mailInstall() {
  const con = document.getElementById('mail-console');
  con.style.display = 'block'; con.textContent = '';
  await mailStream('/mail/install', {}, con);
  loadMail();
}

async function mailAction(a) { await req('POST', `/mail/${a}`); loadMail(); }
async function mailUninstall() {
  if (!confirm('¿Desinstalar el correo? Se elimina el contenedor (los datos de correo se conservan en su volumen).')) return;
  await req('DELETE', '/mail'); loadMail();
}

// loadWebmail: pinta la tarjeta según el estado del contenedor Roundcube.
async function loadWebmail() {
  const el = document.getElementById('mail-webmail');
  if (!el) return;
  const st = await req('GET', '/mail/webmail/status');
  if (!st) return;
  if (!st.installed) {
    el.innerHTML = `
      <p class="muted" style="font-size:13px">Interfaz web para leer y enviar correo con los buzones de este servidor.</p>
      <div class="form-row">
        <input type="text" id="webmail-domain" placeholder="webmail.tudominio.com (opcional)" style="width:280px">
        <label style="margin-left:8px"><input type="checkbox" id="webmail-ssl"> SSL</label>
        <button class="btn btn-primary btn-sm" style="margin-left:8px" onclick="webmailInstall()"><i class="ti ti-download"></i> Instalar webmail</button>
      </div>`;
    return;
  }
  const url = st.domain ? `https://${st.domain}` : `http://127.0.0.1:${st.port}`;
  el.innerHTML = `
    <p><span class="badge ${st.running ? 'badge-green' : 'badge-red'}">${st.running ? 'En marcha' : 'Parado'}</span>
       ${st.domain ? `<a href="${esc(url)}" target="_blank">${esc(st.domain)}</a>` : `puerto ${st.port} (loopback)`}</p>
    <div class="form-row">
      <button class="btn btn-sm" onclick="webmailAction('${st.running ? 'stop' : 'start'}')">${st.running ? 'Parar' : 'Iniciar'}</button>
      <button class="btn btn-sm" onclick="webmailAction('restart')">Reiniciar</button>
      <button class="btn btn-sm btn-danger" onclick="webmailUninstall()"><i class="ti ti-trash"></i> Desinstalar</button>
    </div>`;
}

async function webmailInstall() {
  const domain = document.getElementById('webmail-domain').value.trim();
  const ssl = document.getElementById('webmail-ssl').checked;
  const con = document.getElementById('mail-console');
  con.style.display = 'block'; con.textContent = '';
  await mailStream('/mail/webmail/install', { domain, ssl }, con);
  loadWebmail();
}

async function webmailAction(a) {
  const r = await req('POST', `/mail/webmail/${a}`);
  if (r?.error) toast(r.error, 'error');
  loadWebmail();
}

async function webmailUninstall() {
  const purge = confirm('¿Borrar también la configuración guardada de Roundcube (volumen)? Aceptar = sí, Cancelar = conservar.');
  if (!confirm('¿Desinstalar el webmail?')) return;
  const con = document.getElementById('mail-console');
  con.style.display = 'block'; con.textContent = '';
  await mailStream(`/mail/webmail?volume=${purge}`, null, con, 'DELETE');
  loadWebmail();
}

async function mailSaveConfig() {
  const hostname = document.getElementById('mail-hostname').value.trim();
  const r = await req('POST', '/mail/config', { hostname });
  if (r && r.error) { alert(r.error); return; }
  if (r && r.tls && r.tls !== 'ok') alert('Guardado. TLS ' + r.tls);
  loadMail();
}

async function loadMailboxes() {
  const r = await req('GET', '/mail/mailboxes');
  const el = document.getElementById('mail-mailboxes'); if (!el) return;
  if (!r || r.error) { el.innerHTML = `<p class="muted">${esc((r && r.error) || 'No se pudieron cargar')}</p>`; return; }
  if (!r.mailboxes.length) { el.innerHTML = '<p class="muted">Aún no hay buzones.</p>'; return; }
  el.innerHTML = '<table class="table"><tbody>' + r.mailboxes.map((b) => `<tr>
    <td>${esc(b.address)}</td>
    <td style="text-align:right">
      <button class="btn btn-sm" onclick="mailPassword('${esc(b.address)}')"><i class="ti ti-key"></i></button>
      <button class="btn btn-sm btn-danger" onclick="mailDeleteMailbox('${esc(b.address)}')"><i class="ti ti-trash"></i></button>
    </td></tr>`).join('') + '</tbody></table>';
}

async function mailAddMailbox() {
  const address = document.getElementById('mb-addr').value.trim();
  const password = document.getElementById('mb-pass').value;
  const r = await req('POST', '/mail/mailboxes', { address, password });
  if (r && r.error) { alert(r.error); return; }
  document.getElementById('mb-addr').value = ''; document.getElementById('mb-pass').value = '';
  loadMailboxes();
}

async function mailPassword(addr) {
  const password = prompt(`Nueva contraseña para ${addr} (mínimo 6, sin espacios):`);
  if (!password) return;
  const r = await req('PUT', '/mail/mailboxes', { address: addr, password });
  if (r && r.error) alert(r.error); else alert('Contraseña actualizada.');
}

async function mailDeleteMailbox(addr) {
  if (!confirm(`¿Borrar el buzón ${addr}?`)) return;
  await req('DELETE', '/mail/mailboxes', { address: addr });
  loadMailboxes();
}

async function loadAliases() {
  const r = await req('GET', '/mail/aliases');
  const el = document.getElementById('mail-aliases'); if (!el) return;
  if (!r || r.error) { el.innerHTML = `<p class="muted">${esc((r && r.error) || 'No se pudieron cargar')}</p>`; return; }
  if (!r.aliases.length) { el.innerHTML = '<p class="muted">Aún no hay alias.</p>'; return; }
  el.innerHTML = '<table class="table"><tbody>' + r.aliases.map((a) => `<tr>
    <td>${esc(a.source)} → ${esc(a.destination)}</td>
    <td style="text-align:right"><button class="btn btn-sm btn-danger" onclick="mailDeleteAlias('${esc(a.source)}','${esc(a.destination)}')"><i class="ti ti-trash"></i></button></td>
    </tr>`).join('') + '</tbody></table>';
}

async function mailAddAlias() {
  const source = document.getElementById('al-src').value.trim();
  const destination = document.getElementById('al-dst').value.trim();
  const r = await req('POST', '/mail/aliases', { source, destination });
  if (r && r.error) { alert(r.error); return; }
  document.getElementById('al-src').value = ''; document.getElementById('al-dst').value = '';
  loadAliases();
}

async function mailDeleteAlias(source, destination) {
  if (!confirm(`¿Borrar el alias ${source} → ${destination}?`)) return;
  await req('DELETE', '/mail/aliases', { source, destination });
  loadAliases();
}

async function mailGenDkim() {
  const r = await req('POST', '/mail/dkim');
  if (r && r.error) { alert(r.error); return; }
  alert('DKIM generado. Pulsa "Ver registros DNS" para copiar el valor.');
  mailLoadDns();
}

async function mailLoadDns() {
  const r = await req('GET', '/mail/dns');
  const el = document.getElementById('mail-dns'); if (!el) return;
  if (!r || r.error) { el.innerHTML = `<p class="muted">${esc((r && r.error) || 'No disponible')}</p>`; return; }
  el.innerHTML = '<table class="table"><thead><tr><th>Tipo</th><th>Nombre</th><th>Valor</th></tr></thead><tbody>' +
    r.records.map((rec) => `<tr>
      <td>${esc(rec.type)}${rec.priority ? ' (' + rec.priority + ')' : ''}</td>
      <td><code>${esc(rec.name)}</code></td>
      <td><code>${esc(rec.value || '—')}</code>${rec.note ? `<br><span class="muted">${esc(rec.note)}</span>` : ''}</td>
    </tr>`).join('') + '</tbody></table>';
  el.innerHTML += `
    <div style="margin-top:10px">
      <button class="btn btn-sm btn-primary" onclick="mailDnsPreview()"><i class="ti ti-world-upload"></i> Publicar en DNS del panel</button>
      <span class="muted" style="font-size:12px;margin-left:8px">Requiere el DNS del panel instalado y la zona creada.</span>
    </div>`;
}

// mailDnsPreview: pide el resumen y muestra la modal de confirmación.
async function mailDnsPreview() {
  const r = await req('GET', '/mail/dns/preview');
  if (!r || r.error) { toast(r?.error || 'No se pudo calcular el resumen', 'error'); return; }
  const ACTION_BADGE = { crear: 'badge-green', sobrescribir: 'badge-yellow', igual: 'badge' };
  const rows = r.items.map((i) => `
    <tr><td><span class="badge ${ACTION_BADGE[i.action]}">${esc(i.action)}</span></td>
    <td>${esc(i.type)}</td><td>${esc(i.name)}</td>
    <td style="font-family:var(--mono);font-size:11px;word-break:break-all">${esc(i.value)}</td></tr>`).join('');
  const skipped = (r.skipped || []).map((s) => `<p class="muted" style="font-size:12px">⚠ ${esc(s)}</p>`).join('');
  const modal = document.createElement('div');
  modal.className = 'modal-overlay open';
  modal.id = 'modal-mail-dns';
  modal.dataset.dynamic = 'true';
  modal.innerHTML = `
    <div class="modal" style="max-width:720px">
      <div class="modal-header">
        <div class="modal-title"><i class="ti ti-world-upload"></i> Publicar registros en la zona ${esc(r.zone)}</div>
        <button class="btn btn-sm" onclick="closeModal('modal-mail-dns')"><i class="ti ti-x"></i></button>
      </div>
      <div style="padding:1rem;max-height:50vh;overflow:auto">
        <table class="table"><thead><tr><th>Acción</th><th>Tipo</th><th>Nombre</th><th>Valor</th></tr></thead>
        <tbody>${rows}</tbody></table>
        ${skipped}
      </div>
      <div class="modal-footer">
        <button class="btn" onclick="closeModal('modal-mail-dns')">Cancelar</button>
        <button class="btn btn-primary" onclick="mailDnsPublish()"><i class="ti ti-check"></i> Publicar</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
}

// mailDnsPublish: confirma el upsert.
async function mailDnsPublish() {
  closeModal('modal-mail-dns');
  const r = await req('POST', '/mail/dns/publish');
  if (r?.success) toast(`${r.applied} registros publicados en el DNS`, 'success');
  else toast(r?.error || 'Error al publicar', 'error');
}

// ── DNS (PowerDNS) ──────────────────────────────────────────────
// Streaming reutilizable (mismo patrón que mailStream).
async function dnsStream(path, body, el) {
  const DONE = '__TXPL_DONE__';
  const r = await fetch(API + '/api' + path, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  if (r.status === 401) { doLogout(); return 1; }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '', code = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let show = buf;
    const idx = buf.indexOf(DONE);
    if (idx >= 0) { code = parseInt(buf.slice(idx + DONE.length).trim(), 10) || 0; show = buf.slice(0, idx); }
    el.textContent = show; el.scrollTop = el.scrollHeight;
  }
  return code;
}

async function loadDns() {
  const st = await req('GET', '/dns/status');
  if (!st) return;
  const body = document.getElementById('dns-body');
  if (st.state === 'not_installed') {
    body.innerHTML = `<div class="card">
      <h3>Instalar DNS (PowerDNS)</h3>
      <p class="muted">Convierte este VPS en servidor DNS autoritativo. Abrirá el puerto 53 (TCP/UDP).</p>
      <button class="btn btn-primary" onclick="dnsInstall()"><i class="ti ti-download"></i> Instalar PowerDNS</button>
    </div>`;
    return;
  }
  if (st.state === 'needs_config') {
    body.innerHTML = `<div class="card">
      <h3>Configurar nameservers</h3>
      <p class="muted">Define dos nameservers (ambos apuntando a este servidor) y confirma la IP.</p>
      <div class="form-row"><input type="text" id="dns-ns1" placeholder="ns1.tudominio.com" style="width:240px"></div>
      <div class="form-row"><input type="text" id="dns-ns2" placeholder="ns2.tudominio.com" style="width:240px"></div>
      <div class="form-row"><input type="text" id="dns-ip" placeholder="IP del servidor" value="${esc(st.server_ip || '')}" style="width:180px"></div>
      <button class="btn btn-primary" onclick="dnsSaveConfig()"><i class="ti ti-device-floppy"></i> Guardar</button>
    </div>`;
    return;
  }
  // ready
  body.innerHTML = `
    <div class="card">
      <h3><i class="ti ti-server"></i> Nameservers</h3>
      <p><b>${esc(st.ns1)}</b> y <b>${esc(st.ns2)}</b> → <code>${esc(st.server_ip)}</code></p>
    </div>
    <div class="card">
      <h3><i class="ti ti-list"></i> Zonas (dominios)</h3>
      <div class="form-row">
        <input type="text" id="dns-zone-name" placeholder="tudominio.com" style="width:240px">
        <button class="btn btn-primary" onclick="dnsAddZone()">Añadir dominio</button>
      </div>
      <div id="dns-zones">Cargando…</div>
    </div>
    <div class="card" id="dns-zone-detail" style="display:none">
      <h3><i class="ti ti-list-details"></i> Registros de <span id="dns-current-zone"></span></h3>
      <div class="form-row">
        <input type="text" id="dns-rec-name" placeholder="nombre (ej. www.tudominio.com)" style="width:220px">
        <select id="dns-rec-type" onchange="dnsRecTypeChange()">
          <option>A</option><option>AAAA</option><option>CNAME</option><option>MX</option><option>TXT</option>
        </select>
        <input type="text" id="dns-rec-value" placeholder="valor" style="width:200px">
        <input type="number" id="dns-rec-prio" placeholder="prioridad" value="10" style="width:90px;display:none">
        <input type="number" id="dns-rec-ttl" placeholder="TTL" value="3600" style="width:80px">
        <button class="btn btn-primary" onclick="dnsAddRecord()">Añadir</button>
      </div>
      <div id="dns-records">Cargando…</div>
      <h4 style="margin-top:16px"><i class="ti ti-arrow-guide"></i> Delegación</h4>
      <div id="dns-delegation"></div>
    </div>`;
  loadDnsZones();
}

async function dnsInstall() {
  const con = document.getElementById('dns-console');
  con.style.display = 'block'; con.textContent = '';
  await dnsStream('/dns/install', {}, con);
  loadDns();
}

async function dnsSaveConfig() {
  const body = {
    ns1: document.getElementById('dns-ns1').value.trim(),
    ns2: document.getElementById('dns-ns2').value.trim(),
    server_ip: document.getElementById('dns-ip').value.trim(),
  };
  const r = await req('POST', '/dns/config', body);
  if (r && r.error) { alert(r.error); return; }
  loadDns();
}

async function loadDnsZones() {
  const r = await req('GET', '/dns/zones');
  const el = document.getElementById('dns-zones'); if (!el) return;
  if (!r || r.error) { el.innerHTML = `<p class="muted">${esc((r && r.error) || 'No se pudieron cargar')}</p>`; return; }
  if (!r.zones.length) { el.innerHTML = '<p class="muted">Aún no hay dominios.</p>'; return; }
  el.innerHTML = '<table class="table"><tbody>' + r.zones.map((z) => `<tr>
    <td>${esc(z.name)}</td>
    <td style="text-align:right">
      <button class="btn btn-sm" onclick="dnsOpenZone('${esc(z.name)}')"><i class="ti ti-edit"></i> Registros</button>
      <button class="btn btn-sm btn-danger" onclick="dnsDeleteZone('${esc(z.name)}')"><i class="ti ti-trash"></i></button>
    </td></tr>`).join('') + '</tbody></table>';
}

async function dnsAddZone() {
  const domain = document.getElementById('dns-zone-name').value.trim();
  const r = await req('POST', '/dns/zones', { domain });
  if (r && r.error) { alert(r.error); return; }
  document.getElementById('dns-zone-name').value = '';
  loadDnsZones();
}

async function dnsDeleteZone(zone) {
  if (!confirm(`¿Borrar el dominio ${zone} y todos sus registros?`)) return;
  await req('DELETE', `/dns/zones/${encodeURIComponent(zone)}`);
  document.getElementById('dns-zone-detail').style.display = 'none';
  loadDnsZones();
}

let _dnsZone = null;
function dnsOpenZone(zone) {
  _dnsZone = zone;
  document.getElementById('dns-zone-detail').style.display = 'block';
  document.getElementById('dns-current-zone').textContent = zone;
  document.getElementById('dns-rec-name').value = zone;
  loadDnsRecords(); dnsDelegation();
}

function dnsRecTypeChange() {
  const t = document.getElementById('dns-rec-type').value;
  document.getElementById('dns-rec-prio').style.display = (t === 'MX') ? '' : 'none';
}

async function loadDnsRecords() {
  const r = await req('GET', `/dns/zones/${encodeURIComponent(_dnsZone)}/records`);
  const el = document.getElementById('dns-records'); if (!el) return;
  if (!r || r.error) { el.innerHTML = `<p class="muted">${esc((r && r.error) || 'No se pudieron cargar')}</p>`; return; }
  el.innerHTML = '<table class="table"><thead><tr><th>Nombre</th><th>Tipo</th><th>TTL</th><th>Valor</th><th></th></tr></thead><tbody>' +
    r.records.map((rec) => `<tr>
      <td><code>${esc(rec.name)}</code></td>
      <td>${esc(rec.type)}</td>
      <td>${esc(String(rec.ttl))}</td>
      <td><code>${esc(rec.content)}</code></td>
      <td style="text-align:right">${rec.type === 'SOA' || rec.type === 'NS' ? '' : `<button class="btn btn-sm btn-danger" onclick="dnsDeleteRecord('${esc(rec.name)}','${esc(rec.type)}')"><i class="ti ti-trash"></i></button>`}</td>
    </tr>`).join('') + '</tbody></table>';
}

async function dnsAddRecord() {
  const body = {
    name: document.getElementById('dns-rec-name').value.trim(),
    type: document.getElementById('dns-rec-type').value,
    value: document.getElementById('dns-rec-value').value.trim(),
    ttl: +document.getElementById('dns-rec-ttl').value || 3600,
    priority: +document.getElementById('dns-rec-prio').value || 10,
  };
  const r = await req('POST', `/dns/zones/${encodeURIComponent(_dnsZone)}/records`, body);
  if (r && r.error) { alert(r.error); return; }
  document.getElementById('dns-rec-value').value = '';
  loadDnsRecords();
}

async function dnsDeleteRecord(name, type) {
  if (!confirm(`¿Borrar el registro ${type} ${name}?`)) return;
  await req('DELETE', `/dns/zones/${encodeURIComponent(_dnsZone)}/records`, { name, type });
  loadDnsRecords();
}

async function dnsDelegation() {
  const r = await req('GET', `/dns/zones/${encodeURIComponent(_dnsZone)}/delegation`);
  const el = document.getElementById('dns-delegation'); if (!el) return;
  if (!r || r.error) { el.innerHTML = `<p class="muted">${esc((r && r.error) || 'No disponible')}</p>`; return; }
  const estado = r.delegated
    ? '<span style="color:#16a34a">✅ Delegación activa</span>'
    : '<span style="color:#d97706">⚠️ Pendiente: cambia los NS del dominio en tu registrador</span>';
  el.innerHTML = `<p>${estado}</p>
    <p class="muted">Crea estos <b>glue records</b> en tu registrador y apunta los NS del dominio a ellos:</p>
    <table class="table"><tbody>` +
    r.glue.map((g) => `<tr><td>${esc(g.type)}</td><td><code>${esc(g.name)}</code></td><td><code>${esc(g.value)}</code></td></tr>`).join('') +
    `</tbody></table>` +
    (r.ns_found && r.ns_found.length ? `<p class="muted">NS detectados ahora: ${esc(r.ns_found.join(', '))}</p>` : '');
}

// ── Tareas programadas (cron) ─────────────────────────────────
// Muestra/oculta los campos del constructor guiado según el preset elegido.
function cronPresetChange() {
  const p = document.getElementById('cron-preset').value;
  document.getElementById('cron-time-wrap').style.display = (p === 'day' || p === 'week' || p === 'month') ? '' : 'none';
  document.getElementById('cron-dow-wrap').style.display = (p === 'week') ? '' : 'none';
  document.getElementById('cron-dom-wrap').style.display = (p === 'month') ? '' : 'none';
  document.getElementById('cron-custom-wrap').style.display = (p === 'custom') ? '' : 'none';
}

// Traduce el constructor guiado a los 5 campos cron.
function cronScheduleFromForm() {
  const p = document.getElementById('cron-preset').value;
  if (p === 'custom') {
    return {
      minute: document.getElementById('cron-f-min').value.trim(),
      hour: document.getElementById('cron-f-hour').value.trim(),
      dom: document.getElementById('cron-f-dom').value.trim(),
      month: document.getElementById('cron-f-month').value.trim(),
      dow: document.getElementById('cron-f-dow').value.trim(),
    };
  }
  const [hh, mm] = (document.getElementById('cron-time').value || '03:00').split(':');
  if (p === 'minute') return { minute: '*', hour: '*', dom: '*', month: '*', dow: '*' };
  if (p === 'hour') return { minute: '0', hour: '*', dom: '*', month: '*', dow: '*' };
  if (p === 'day') return { minute: String(+mm), hour: String(+hh), dom: '*', month: '*', dow: '*' };
  if (p === 'week') return { minute: String(+mm), hour: String(+hh), dom: '*', month: '*', dow: document.getElementById('cron-dow-sel').value };
  if (p === 'month') return { minute: String(+mm), hour: String(+hh), dom: document.getElementById('cron-dom-num').value, month: '*', dow: '*' };
  return { minute: '*', hour: '*', dom: '*', month: '*', dow: '*' };
}

function cronResetForm() {
  document.getElementById('cron-id').value = '';
  document.getElementById('cron-name').value = '';
  document.getElementById('cron-command').value = '';
  document.getElementById('cron-preset').value = 'day';
  document.getElementById('cron-time').value = '03:00';
  document.getElementById('cron-form-title').innerHTML = '<i class="ti ti-plus"></i> Nueva tarea';
  cronPresetChange();
}

async function loadCron() {
  cronPresetChange();
  const data = await req('GET', '/cron');
  if (!data) return;
  const list = document.getElementById('cron-list');
  if (!data.jobs.length) { list.innerHTML = '<p class="muted">No hay tareas programadas.</p>'; return; }
  list.innerHTML = '<table class="table"><thead><tr><th>Nombre</th><th>Programación</th><th>Comando</th><th>Estado</th><th></th></tr></thead><tbody>' +
    data.jobs.map((j) => `<tr>
      <td>${esc(j.name)}</td>
      <td><code>${esc(`${j.minute} ${j.hour} ${j.dom} ${j.month} ${j.dow}`)}</code></td>
      <td><code>${esc(j.command)}</code></td>
      <td>${j.enabled ? '🟢 activa' : '⚪ inactiva'}</td>
      <td>
        <button class="btn btn-sm" onclick="cronEdit(${j.id})"><i class="ti ti-edit"></i></button>
        <button class="btn btn-sm" onclick="cronToggle(${j.id})"><i class="ti ti-power"></i></button>
        <button class="btn btn-sm" onclick="cronViewLog(${j.id})"><i class="ti ti-file-text"></i></button>
        <button class="btn btn-sm btn-danger" onclick="cronDelete(${j.id})"><i class="ti ti-trash"></i></button>
      </td></tr>`).join('') + '</tbody></table>';
  window._cronJobs = data.jobs;
}

async function cronSave() {
  const id = document.getElementById('cron-id').value;
  const body = {
    name: document.getElementById('cron-name').value.trim(),
    command: document.getElementById('cron-command').value,
    ...cronScheduleFromForm(),
  };
  if (!body.name || !body.command.trim()) { alert('Nombre y comando son obligatorios'); return; }
  const r = id ? await req('PUT', `/cron/${id}`, body) : await req('POST', '/cron', body);
  if (r && r.error) { alert(r.error); return; }
  cronResetForm();
  loadCron();
}

function cronEdit(id) {
  const j = (window._cronJobs || []).find((x) => x.id === id);
  if (!j) return;
  document.getElementById('cron-id').value = j.id;
  document.getElementById('cron-name').value = j.name;
  document.getElementById('cron-command').value = j.command;
  document.getElementById('cron-preset').value = 'custom';
  cronPresetChange();
  document.getElementById('cron-f-min').value = j.minute;
  document.getElementById('cron-f-hour').value = j.hour;
  document.getElementById('cron-f-dom').value = j.dom;
  document.getElementById('cron-f-month').value = j.month;
  document.getElementById('cron-f-dow').value = j.dow;
  document.getElementById('cron-form-title').innerHTML = '<i class="ti ti-edit"></i> Editar tarea';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function cronToggle(id) {
  const r = await req('POST', `/cron/${id}/toggle`);
  if (r && r.error) toast(r.error, 'error');
  loadCron();
}

async function cronDelete(id) {
  if (!confirm('¿Borrar esta tarea programada?')) return;
  const r = await req('DELETE', `/cron/${id}`);
  if (r && r.error) toast(r.error, 'error');
  loadCron();
}

async function cronViewLog(id) {
  const r = await req('GET', `/cron/${id}/log`);
  if (!r) return;
  document.getElementById('cron-log-card').style.display = 'block';
  document.getElementById('cron-log-output').textContent = r.log || '(sin salida registrada todavía)';
  document.getElementById('cron-log-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ── Docker ────────────────────────────────────────────────────
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

