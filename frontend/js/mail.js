// TecXPaneL — mail (docker-mailserver, buzones, alias, DKIM, DNS correo, webmail Roundcube)

// ── Correo (docker-mailserver) ─────────────────────────────────
// Streaming reutilizable (mismo patrón que streamConsole de backups).
async function mailStream(path, body, el, method = 'POST') {
  const DONE = '__TXPL_DONE__';
  let r;
  try {
    r = await fetch(API + '/api' + path, {
      method,
      headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
  } catch (error) {
    mailFeedback(error.message || 'No se pudo conectar con el servidor.', 'error');
    return 1;
  }
  if (r.status === 401) { doLogout(); return 1; }
  if (!r.ok) {
    let message = 'Error HTTP ' + r.status;
    try { message = (await r.json()).error || message; } catch (_) {}
    mailFeedback(message, 'error');
    return 1;
  }
  if (!r.body) { mailFeedback('El servidor no devolvió una respuesta de progreso.', 'error'); return 1; }
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
    // Los marcadores __TXPL_PULL__<n> (progreso de descarga de imagen) no van a la
    // consola: alimentan la barra de %. Se quitan del texto visible.
    let lastPct = null;
    show = show.replace(/__TXPL_PULL__(\d+)\n?/g, (_, n) => { lastPct = parseInt(n, 10); return ''; });
    if (lastPct !== null) mailSetProgress(lastPct);
    el.textContent = show; el.scrollTop = el.scrollHeight;
  }
  mailHideProgress();
  return code;
}

// Barra de % de descarga de imagen (alimentada por los marcadores __TXPL_PULL__).
function mailSetProgress(pct) {
  const wrap = document.getElementById('mail-progress');
  if (!wrap) return;
  wrap.hidden = false;
  const v = Math.max(0, Math.min(100, pct));
  const fill = document.getElementById('mail-progress-fill');
  const label = document.getElementById('mail-progress-label');
  if (fill) fill.style.width = v + '%';
  if (label) label.textContent = v + '%';
}

function mailHideProgress() {
  const wrap = document.getElementById('mail-progress');
  if (!wrap) return;
  wrap.hidden = true;
  const fill = document.getElementById('mail-progress-fill');
  if (fill) fill.style.width = '0%';
}

function mailFeedback(message, type = 'info') {
  const el = document.getElementById('mail-feedback');
  if (!el) return;
  el.hidden = false;
  el.className = 'mail-feedback ' + type;
  el.textContent = message;
}

function mailSetBusy(busy) {
  document.querySelectorAll('#mail-body button, #mail-body input, #mail-body select').forEach((el) => {
    el.disabled = busy;
  });
}

function mailSetStatus(state) {
  const labels = { ready: 'Operativo', stopped: 'Parado', needs_config: 'Configurar', needs_tls: 'TLS pendiente', not_installed: 'No instalado', error: 'Error' };
  const dot = document.getElementById('mail-status-dot');
  const label = document.getElementById('mail-status-label');
  let dotClass = 'is-unknown';
  if (state === 'ready') dotClass = 'is-ready';
  else if (state === 'stopped' || state === 'not_installed') dotClass = 'is-warning';
  else if (state === 'needs_tls' || state === 'error') dotClass = 'is-error';
  if (dot) dot.className = 'mail-status-dot ' + dotClass;
  if (label) label.textContent = labels[state] || 'Desconocido';
}

async function loadMail() {
  const st = await req('GET', '/mail/status');
  if (!st || st.error) {
    mailSetStatus('error');
    mailFeedback(st?.error || 'No se pudo consultar el servicio de correo.', 'error');
    return;
  }
  mailSetStatus(st.state);
  mailRenderStepper(st.docker ? st.state : null);
  // La tarjeta de relay solo tiene sentido con el hostname ya configurado.
  const relayCard = document.querySelector('.mail-relay');
  if (relayCard) { const showRelay = !!(st.docker && st.configured); relayCard.hidden = !showRelay; if (showRelay) loadMailRelay(); }
  const body = document.getElementById('mail-body');
  if (!st.docker) {
    body.innerHTML = '<div class="card mail-state-card"><i class="ti ti-brand-docker mail-state-icon"></i><h2>Docker no está disponible</h2><p>El correo necesita Docker para funcionar. Instálalo desde Plugins y vuelve a intentarlo.</p><button class="btn btn-primary" onclick="navigate(document.querySelector(\'[data-page=plugins]\'));return false"><i class="ti ti-puzzle"></i> Ir a Plugins</button></div>';
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
    body.innerHTML = `<div class="card mail-state-card"><p>El correo está instalado pero parado.</p>
      <button class="btn btn-success" onclick="mailAction('start')"><i class="ti ti-player-play"></i> Arrancar</button>
      <button class="btn btn-danger" onclick="mailUninstall()"><i class="ti ti-trash"></i> Desinstalar</button></div>`;
    return;
  }
  if (st.state === 'needs_config' || st.state === 'needs_tls') {
    body.innerHTML = `<div class="card">
      <h3>Configurar el correo</h3>
      <p class="muted">Indica el hostname del correo (ej. <code>mail.tudominio.com</code>). El panel emitirá el certificado TLS con Certbot. Si aparece como pendiente, revisa el DNS y vuelve a guardar.</p>
      <div class="form-row"><input type="text" id="mail-hostname" placeholder="mail.tudominio.com" style="width:320px"></div>
      <button class="btn btn-primary" onclick="mailSaveConfig()"><i class="ti ti-device-floppy"></i> Guardar y emitir TLS</button>
    </div>`;
    document.getElementById('mail-hostname').value = st.hostname || '';
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
  mailSetBusy(true);
  const code = await mailStream('/mail/install', {}, con);
  mailSetBusy(false);
  mailFeedback(code === 0 ? 'Correo instalado. Continúa con la configuración del hostname.' : 'La instalación no terminó correctamente. Revisa la consola.', code === 0 ? 'success' : 'error');
  loadMail();
}

async function mailAction(a) {
  mailSetBusy(true);
  const r = await req('POST', `/mail/${a}`);
  mailSetBusy(false);
  if (r?.error) { mailFeedback(r.error, 'error'); return; }
  const action = a === 'start' ? 'arrancado' : a === 'stop' ? 'detenido' : 'reiniciado';
  mailFeedback('Correo ' + action + ' correctamente.', 'success');
  loadMail();
}
async function mailUninstall() {
  if (!confirm('¿Desinstalar el correo? Se elimina el contenedor (los datos de correo se conservan en su volumen).')) return;
  const r = await req('DELETE', '/mail');
  if (r?.error) { mailFeedback(r.error, 'error'); return; }
  mailFeedback('Correo desinstalado. Los volúmenes se han conservado.', 'success');
  loadMail();
}

// loadWebmail: pinta la tarjeta según el estado del contenedor Roundcube.
async function loadWebmail() {
  const el = document.getElementById('mail-webmail');
  if (!el) return;
  const st = await req('GET', '/mail/webmail/status');
  if (!st || st.error) { el.innerHTML = '<p class="muted">' + esc(st?.error || 'No se pudo consultar Roundcube.') + '</p>'; return; }
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
  mailSetBusy(true);
  const code = await mailStream('/mail/webmail/install', { domain, ssl }, con);
  mailSetBusy(false);
  mailFeedback(code === 0 ? 'Roundcube instalado correctamente.' : 'La instalación de Roundcube ha fallado. Revisa la consola.', code === 0 ? 'success' : 'error');
  loadWebmail();
}

async function webmailAction(a) {
  mailSetBusy(true);
  const r = await req('POST', `/mail/webmail/${a}`);
  mailSetBusy(false);
  if (r?.error) mailFeedback(r.error, 'error');
  else mailFeedback('Roundcube ' + (a === 'start' ? 'iniciado' : a === 'stop' ? 'detenido' : 'reiniciado') + '.', 'success');
  loadWebmail();
}

async function webmailUninstall() {
  const purge = confirm('¿Borrar también la configuración guardada de Roundcube (volumen)? Aceptar = sí, Cancelar = conservar.');
  if (!confirm('¿Desinstalar el webmail?')) return;
  const con = document.getElementById('mail-console');
  con.style.display = 'block'; con.textContent = '';
  const code = await mailStream(`/mail/webmail?volume=${purge}`, null, con, 'DELETE');
  mailFeedback(code === 0 ? 'Roundcube desinstalado.' : 'No se pudo completar la desinstalación de Roundcube.', code === 0 ? 'success' : 'error');
  loadWebmail();
}

async function mailSaveConfig() {
  const hostname = document.getElementById('mail-hostname').value.trim();
  mailSetBusy(true);
  const r = await req('POST', '/mail/config', { hostname });
  mailSetBusy(false);
  if (r && r.error) { mailFeedback(r.error, 'error'); return; }
  mailFeedback(r?.tls === 'ok' ? 'Configuración guardada y TLS operativo.' : 'Configuración guardada, pero TLS sigue pendiente.', r?.tls === 'ok' ? 'success' : 'error');
  loadMail();
}

async function loadMailboxes() {
  const r = await req('GET', '/mail/mailboxes');
  const el = document.getElementById('mail-mailboxes'); if (!el) return;
  if (!r || r.error) { el.innerHTML = `<p class="muted">${esc((r && r.error) || 'No se pudieron cargar')}</p>`; return; }
  if (!r.mailboxes.length) { el.innerHTML = '<div class="empty-state">' + emptyState('mail-off', 'Sin buzones aún') + '</div>'; return; }
  el.innerHTML = '<div class="table-wrap"><table class="table"><tbody>' + r.mailboxes.map((b) => `<tr>
    <td>${esc(b.address)}</td>
    <td style="text-align:right">
      <button class="btn btn-sm" onclick="mailPassword('${esc(b.address)}')"><i class="ti ti-key"></i></button>
      <button class="btn btn-sm btn-danger" onclick="mailDeleteMailbox('${esc(b.address)}')"><i class="ti ti-trash"></i></button>
    </td></tr>`).join('') + '</tbody></table></div>';
}

async function mailAddMailbox() {
  const address = document.getElementById('mb-addr').value.trim();
  const password = document.getElementById('mb-pass').value;
  const r = await req('POST', '/mail/mailboxes', { address, password });
  if (r && r.error) { mailFeedback(r.error, 'error'); return; }
  mailFeedback('Buzón creado correctamente.', 'success');
  document.getElementById('mb-addr').value = ''; document.getElementById('mb-pass').value = '';
  loadMailboxes();
}

async function mailPassword(addr) {
  const password = prompt(`Nueva contraseña para ${addr} (mínimo 6, sin espacios):`);
  if (!password) return;
  const r = await req('PUT', '/mail/mailboxes', { address: addr, password });
  if (r && r.error) mailFeedback(r.error, 'error'); else mailFeedback('Contraseña actualizada.', 'success');
}

async function mailDeleteMailbox(addr) {
  if (!confirm(`¿Borrar el buzón ${addr}?`)) return;
  const r = await req('DELETE', '/mail/mailboxes', { address: addr });
  if (r?.error) { mailFeedback(r.error, 'error'); return; }
  mailFeedback('Buzón eliminado.', 'success');
  loadMailboxes();
}

async function loadAliases() {
  const r = await req('GET', '/mail/aliases');
  const el = document.getElementById('mail-aliases'); if (!el) return;
  if (!r || r.error) { el.innerHTML = `<p class="muted">${esc((r && r.error) || 'No se pudieron cargar')}</p>`; return; }
  if (!r.aliases.length) { el.innerHTML = '<div class="empty-state">' + emptyState('at-off', 'Sin alias') + '</div>'; return; }
  el.innerHTML = '<div class="table-wrap"><table class="table"><tbody>' + r.aliases.map((a) => `<tr>
    <td>${esc(a.source)} → ${esc(a.destination)}</td>
    <td style="text-align:right"><button class="btn btn-sm btn-danger" onclick="mailDeleteAlias('${esc(a.source)}','${esc(a.destination)}')"><i class="ti ti-trash"></i></button></td>
    </tr>`).join('') + '</tbody></table></div>';
}

async function mailAddAlias() {
  const source = document.getElementById('al-src').value.trim();
  const destination = document.getElementById('al-dst').value.trim();
  const r = await req('POST', '/mail/aliases', { source, destination });
  if (r && r.error) { mailFeedback(r.error, 'error'); return; }
  mailFeedback('Alias creado correctamente.', 'success');
  document.getElementById('al-src').value = ''; document.getElementById('al-dst').value = '';
  loadAliases();
}

async function mailDeleteAlias(source, destination) {
  if (!confirm(`¿Borrar el alias ${source} → ${destination}?`)) return;
  const r = await req('DELETE', '/mail/aliases', { source, destination });
  if (r?.error) { mailFeedback(r.error, 'error'); return; }
  mailFeedback('Alias eliminado.', 'success');
  loadAliases();
}

async function mailGenDkim() {
  const r = await req('POST', '/mail/dkim');
  if (r && r.error) { mailFeedback(r.error, 'error'); return; }
  mailFeedback('DKIM generado. Consulta ahora los registros DNS.', 'success');
  mailLoadDns();
}

let _mailDnsRecords = [];
async function mailLoadDns() {
  const r = await req('GET', '/mail/dns');
  const el = document.getElementById('mail-dns'); if (!el) return;
  if (!r || r.error) { el.innerHTML = `<p class="muted">${esc((r && r.error) || 'No disponible')}</p>`; return; }
  _mailDnsRecords = r.records || [];
  el.innerHTML = '<div class="table-wrap"><table class="table"><thead><tr><th>Tipo</th><th>Nombre</th><th>Valor</th><th></th></tr></thead><tbody>' +
    _mailDnsRecords.map((rec, i) => `<tr>
      <td>${esc(rec.type)}${rec.priority ? ' (' + rec.priority + ')' : ''}</td>
      <td><code>${esc(rec.name)}</code></td>
      <td><code>${esc(rec.value || '—')}</code>${rec.note ? `<br><span class="muted">${esc(rec.note)}</span>` : ''}</td>
      <td style="text-align:right">${rec.value ? `<button class="btn btn-sm" title="Copiar valor" onclick="mailCopyDnsRow(${i})">📋</button>` : ''}</td>
    </tr>`).join('') + '</tbody></table></div>';
  el.innerHTML += `
    <div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <button class="btn btn-sm" onclick="mailCopyAllDns()">📋 Copiar todo</button>
      <button class="btn btn-sm btn-primary" onclick="mailDnsPreview()"><i class="ti ti-world-upload"></i> Publicar en DNS del panel</button>
      <span class="muted" style="font-size:12px">Publicar requiere el DNS del panel instalado y la zona creada.</span>
    </div>`;
}
// Copia el valor de un registro, o todos (formato Tipo⇥Nombre⇥Valor para pegar).
function mailCopyDnsRow(i) {
  const rec = _mailDnsRecords[i];
  if (rec && rec.value) copyText(rec.value);
}
function mailCopyAllDns() {
  const rows = _mailDnsRecords.filter((r) => r.value)
    .map((r) => `${r.type}${r.priority ? ' (prioridad ' + r.priority + ')' : ''}\t${r.name}\t${r.value}`);
  if (!rows.length) return;
  copyText('Tipo\tNombre\tValor\n' + rows.join('\n'));
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
        <div class="table-wrap"><table class="table"><thead><tr><th>Acción</th><th>Tipo</th><th>Nombre</th><th>Valor</th></tr></thead>
        <tbody>${rows}</tbody></table></div>
        ${skipped}
      </div>
      <div class="modal-footer">
        <button class="btn" onclick="closeModal('modal-mail-dns')"><i class="ti ti-x"></i> Cancelar</button>
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

// mailRenderStepper: roadmap de 3 pasos (Instalar → Hostname/TLS → Buzones) que
// refleja en qué fase está el correo según el estado que devuelve /status.
function mailRenderStepper(state) {
  const el = document.getElementById('mail-stepper');
  if (!el) return;
  if (!state) { el.innerHTML = ''; return; }
  const installed = ['stopped', 'needs_config', 'needs_tls', 'ready'].includes(state);
  const configured = state === 'ready';
  const steps = [
    { n: 1, label: 'Instalar', done: installed, current: state === 'not_installed' },
    { n: 2, label: 'Hostname y TLS', done: configured, current: state === 'needs_config' || state === 'needs_tls' },
    { n: 3, label: 'Buzones y prueba', done: false, current: state === 'ready' },
  ];
  el.innerHTML = steps.map((s, i) => `
    <div class="mail-step ${s.done ? 'is-done' : ''} ${s.current ? 'is-current' : ''}">
      <span class="mail-step-num">${s.done ? '✓' : s.n}</span>
      <span class="mail-step-label">${esc(s.label)}</span>
    </div>${i < steps.length - 1 ? '<span class="mail-step-sep"></span>' : ''}`).join('');
}

// mailDiagnose: pide /mail/diagnose y pinta la checklist de salud con semáforos.
async function mailDiagnose() {
  const box = document.getElementById('mail-diagnose-results');
  const btn = document.getElementById('mail-diagnose-btn');
  if (!box) return;
  if (btn) btn.disabled = true;
  box.innerHTML = '<p class="muted">Comprobando… (puede tardar unos segundos)</p>';
  const d = await req('GET', '/mail/diagnose');
  if (btn) btn.disabled = false;
  if (!d || d.error) { box.innerHTML = '<p class="muted">' + esc(d?.error || 'No se pudo diagnosticar.') + '</p>'; return; }
  if (!d.checks || !d.checks.length) { box.innerHTML = '<p class="muted">Sin comprobaciones disponibles.</p>'; return; }
  const icon = { ok: '✅', warn: '⚠️', error: '❌' };
  box.innerHTML = d.checks.map((c) => `
    <div class="mail-check is-${esc(c.level)}">
      <span class="mail-check-icon">${icon[c.level] || '•'}</span>
      <div class="mail-check-body">
        <strong>${esc(c.title)}</strong>
        <p>${esc(c.detail)}</p>
        ${c.fix ? `<p class="mail-check-fix"><b>Cómo arreglarlo:</b> ${esc(c.fix)}</p>` : ''}
      </div>
    </div>`).join('');
}

// ── Relay SMTP (envío por smarthost cuando el puerto 25 está bloqueado) ──
const RELAY_PRESETS = {
  brevo: { host: 'smtp-relay.brevo.com', port: 587 },
  sendgrid: { host: 'smtp.sendgrid.net', port: 587 },
  mailgun: { host: 'smtp.mailgun.org', port: 587 },
  ses: { host: 'email-smtp.eu-west-1.amazonaws.com', port: 587 },
  gmail: { host: 'smtp.gmail.com', port: 587 },
};
function mailRelayPreset(name) {
  const p = RELAY_PRESETS[name];
  if (!p) return;
  document.getElementById('relay-host').value = p.host;
  document.getElementById('relay-port').value = p.port;
  document.getElementById('relay-enabled').checked = true;
}
async function loadMailRelay() {
  const host = document.getElementById('relay-host');
  if (!host) return;
  const r = await req('GET', '/mail/relay');
  if (!r || r.error) return;
  host.value = r.host || '';
  document.getElementById('relay-port').value = r.port || 587;
  document.getElementById('relay-user').value = r.username || '';
  document.getElementById('relay-enabled').checked = !!r.enabled;
  document.getElementById('relay-pass').placeholder = r.hasPassword ? 'contraseña guardada (vacío = mantener)' : 'contraseña / API key';
}
let relaySaving = false;
async function mailSaveRelay() {
  if (relaySaving) return;
  relaySaving = true;
  try {
    const body = {
      enabled: document.getElementById('relay-enabled').checked,
      host: document.getElementById('relay-host').value.trim(),
      port: +document.getElementById('relay-port').value || 587,
      username: document.getElementById('relay-user').value.trim(),
      password: document.getElementById('relay-pass').value,
    };
    mailSetBusy(true);
    const r = await req('POST', '/mail/relay', body);
    mailSetBusy(false);
    if (r?.error) { mailFeedback(r.error, 'error'); return; }
    document.getElementById('relay-pass').value = '';
    mailFeedback(body.enabled ? 'Relay activado. El contenedor se recreó para aplicarlo.' : 'Relay desactivado.', 'success');
    loadMail();
  } finally { relaySaving = false; }
}

Object.assign(window, {
  loadAliases, loadMail, loadMailboxes, loadMailRelay, loadWebmail, mailAction, mailAddAlias, mailAddMailbox, mailCopyAllDns, mailCopyDnsRow, mailDeleteAlias, mailDeleteMailbox, mailDiagnose, mailDnsPreview, mailDnsPublish, mailGenDkim, mailInstall, mailLoadDns, mailPassword, mailRelayPreset, mailSaveConfig, mailSaveRelay, mailStream, mailUninstall, webmailAction, webmailInstall, webmailUninstall,
});
