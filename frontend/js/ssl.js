// TecXPaneL — ssl (certificados Let's Encrypt)
// ── SSL ───────────────────────────────────────────────────────
// ── SSL / Certificados ────────────────────────────────────────
// loadSSL: dashboard real de certificados. Pide GET /api/ssl/certificates
// (que lee `certbot certificates`) y pinta dominios, caducidad y estado.
const SSL_CAT = {
  valid:    { badge: 'badge-green',  txt: 'Válido' },
  expiring: { badge: 'badge-yellow', txt: 'Caduca pronto' },
  expired:  { badge: 'badge-red',    txt: 'Caducado' },
};
async function loadSSL() {
  const body = document.getElementById('ssl-body');
  body.innerHTML = '<p style="color:var(--text-muted)">Cargando certificados...</p>';
  const data = await req('GET', '/ssl/certificates');
  if (!data) return;

  if (!data.certbot) {
    body.innerHTML = `<p>Certbot no está instalado. Instálalo desde
      <a href="#" onclick="navigate(document.querySelector('[data-page=plugins]'));return false">Plugins</a>
      para gestionar certificados SSL.</p>`;
    return;
  }

  const rows = data.certificates.length ? data.certificates.map(c => {
    const cat = SSL_CAT[c.category] || SSL_CAT.valid;
    const dias = c.daysLeft === null ? '—' : `${c.daysLeft} días`;
    return `
    <tr>
      <td><span class="domain-pill">${esc(c.name)}</span></td>
      <td style="font-size:12px;color:var(--text-secondary)">${c.domains.map(esc).join(', ')}</td>
      <td><span class="badge ${cat.badge}">${cat.txt}</span></td>
      <td style="color:var(--text-muted);font-size:12px">${esc(c.expiry || '—')}<br>${dias}</td>
      <td>
        <div style="display:flex;gap:6px">
          <button class="btn btn-sm" onclick="sslRenew('${esc(c.name)}')" title="Renovar si procede"><i class="ti ti-refresh"></i> Renovar</button>
          <button class="btn btn-sm btn-danger" onclick="sslDelete('${esc(c.name)}')" title="Eliminar certificado"><i class="ti ti-trash"></i></button>
        </div>
      </td>
    </tr>`;
  }).join('') : '<tr><td colspan="5" class="empty-state"><i class="ti ti-certificate-off"></i><br>No hay certificados emitidos</td></tr>';

  body.innerHTML = `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Certificado</th><th>Dominios</th><th>Estado</th><th>Caducidad</th><th>Acciones</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
    <div style="margin-top:1.5rem;padding-top:1.25rem;border-top:1px solid var(--border)">
      <div class="card-title" style="font-size:14px;margin-bottom:.75rem"><i class="ti ti-plus"></i> Emitir certificado nuevo</div>
      <p style="color:var(--text-muted);font-size:12px;margin-bottom:.75rem">El dominio debe apuntar ya por DNS a este servidor y tener un sitio en Nginx.</p>
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        <input type="text" id="ssl-issue-domain" placeholder="ejemplo.com" style="flex:1;min-width:220px">
        <label style="display:flex;align-items:center;gap:6px;font-size:13px"><input type="checkbox" id="ssl-issue-www"> incluir www</label>
        <button class="btn btn-primary" onclick="sslIssue()"><i class="ti ti-certificate"></i> Emitir</button>
      </div>
    </div>
    <div class="card" id="ssl-console-card" style="display:none;margin-top:1rem;background:var(--bg-app)">
      <pre id="ssl-console-output" style="max-height:340px;overflow:auto;font-size:12px;white-space:pre-wrap"></pre>
    </div>`;
}

// sslRenew / sslDelete / sslIssue: acciones sobre certificados, en streaming.
async function sslRenew(name) {
  await sslStream(`/ssl/${encodeURIComponent(name)}/renew`, 'POST', `Renovando ${name}`);
}
function sslDelete(name) {
  if (!confirm(`¿Eliminar el certificado ${name}? Se revocará y se borrarán sus ficheros. Los sitios que lo usen dejarán de servir HTTPS.`)) return;
  sslStream(`/ssl/${encodeURIComponent(name)}`, 'DELETE', `Eliminando ${name}`);
}
async function sslIssue() {
  const domain = document.getElementById('ssl-issue-domain').value.trim();
  const www = document.getElementById('ssl-issue-www').checked;
  if (!domain) { toast('Introduce un dominio', 'error'); return; }
  await sslStream('/ssl/issue', 'POST', `Emitiendo ${domain}`, { domain, www });
}

// sslStream: helper de streaming (mismo patrón que catalogStream/n8nInstall).
async function sslStream(apiPath, method, title, body) {
  const card = document.getElementById('ssl-console-card');
  const out = document.getElementById('ssl-console-output');
  card.style.display = 'block';
  out.textContent = title + '...\n';
  const DONE = '__TXPL_DONE__';
  let exitCode = 1;
  try {
    const opts = { method, headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const r = await fetch(API + '/api' + apiPath, opts);
    if (r.status === 401) { doLogout(); return; }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
      let display = buffer;
      const idx = buffer.indexOf(DONE);
      if (idx >= 0) { exitCode = parseInt(buffer.slice(idx + DONE.length).trim(), 10) || 0; display = buffer.slice(0, idx); }
      out.textContent = display;
      out.scrollTop = out.scrollHeight;
    }
  } catch (e) {
    out.textContent += '\n✖ Error de conexión: ' + (e?.message || e);
  }
  toast(exitCode === 0 ? 'Operación completada' : 'La operación terminó con errores', exitCode === 0 ? 'success' : 'error');
  loadSSL();
}
