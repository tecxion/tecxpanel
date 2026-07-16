// TecXPaneL — firewall (reglas UFW)

// ── Firewall ──────────────────────────────────────────────────
// loadFirewall: muestra el estado del firewall y sus reglas.
async function loadFirewall() {
  const data = await req('GET', '/firewall');
  if (!data) return;
  document.getElementById('ufw-status').className = `badge ${data.enabled ? 'badge-green' : 'badge-red'}`;
  document.getElementById('ufw-status').textContent = data.enabled ? 'Activo' : 'Inactivo';

  const tb = document.getElementById('firewall-table');
  const rules = (data.rules || []).filter(r => r.num);
  if (!rules.length) { tb.innerHTML = '<tr><td colspan="5" class="empty-state">Sin reglas</td></tr>'; return; }
  tb.innerHTML = rules.map(r => `
    <tr>
      <td style="color:var(--text-muted);font-family:var(--mono)">${r.num}</td>
      <td style="font-weight:500">${esc(r.to)}</td>
      <td><span class="badge ${r.action==='ALLOW'?'badge-green':'badge-red'}">${esc(r.action)}</span></td>
      <td style="color:var(--text-muted)">${esc(r.from || 'Anywhere')}</td>
      <td><button class="btn btn-sm btn-danger" onclick="deleteRule(${r.num})"><i class="ti ti-trash"></i></button></td>
    </tr>
  `).join('');
}

// createRule: añade una regla nueva al firewall.
async function createRule() {
  const r = await req('POST', '/firewall/rule', {
    action: document.getElementById('rule-action').value,
    port: document.getElementById('rule-port').value,
    protocol: document.getElementById('rule-proto').value,
    from: document.getElementById('rule-from').value
  });
  if (r?.success) { toast('Regla añadida', 'success'); closeModal('modal-new-rule'); loadFirewall(); }
  else toast(r?.error || 'Error', 'error');
}

// deleteRule: borra la regla número "num" del firewall.
async function deleteRule(num) {
  if (!confirm('¿Eliminar esta regla?')) return;
  const r = await req('DELETE', `/firewall/rule/${num}`);
  if (r?.success) { toast('Regla eliminada', 'success'); loadFirewall(); }
  else toast(r?.error || 'Error', 'error');
}
