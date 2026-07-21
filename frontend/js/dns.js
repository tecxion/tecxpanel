// TecXPaneL — dns (PowerDNS autoritativo, zonas, registros, delegación)
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
  if (!r.zones.length) { el.innerHTML = '<div class="empty-state">' + emptyState('world-search', 'Sin zonas DNS aún — crea la primera con el formulario de arriba') + '</div>'; return; }
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
