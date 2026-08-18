// TecXPaneL — firewall UFW (reglas, políticas y operaciones seguras)

function firewallPayload() {
  return {
    action: document.getElementById('rule-action')?.value || 'allow',
    port: document.getElementById('rule-port')?.value.trim() || '',
    protocol: document.getElementById('rule-proto')?.value || 'tcp',
    from: document.getElementById('rule-from')?.value.trim() || '',
  };
}

function firewallShowFeedback(message, type = 'info') {
  const el = document.getElementById('firewall-feedback');
  if (!el) return;
  el.hidden = false;
  el.className = 'firewall-feedback ' + type;
  el.textContent = message;
}

function firewallSetStatus(enabled) {
  const label = enabled ? 'Activo' : 'Inactivo';
  const status = document.getElementById('ufw-status');
  const badge = document.getElementById('ufw-status-badge');
  if (status) status.textContent = label;
  if (badge) { badge.textContent = label; badge.className = 'badge ' + (enabled ? 'badge-green' : 'badge-red'); }
}

async function loadFirewall() {
  const data = await req('GET', '/firewall');
  if (!data || data.error) {
    firewallShowFeedback(data?.error || 'No se pudo consultar UFW. Comprueba que está instalado.', 'error');
    firewallSetStatus(false);
    return;
  }
  firewallSetStatus(!!data.enabled);
  document.getElementById('ufw-rule-count').textContent = String((data.rules || []).length);
  document.getElementById('ufw-default-incoming').textContent = data.defaults?.incoming || '—';
  document.getElementById('ufw-default-outgoing').textContent = data.defaults?.outgoing || '—';
  document.getElementById('ufw-logging').textContent = data.logging || '—';
  const tb = document.getElementById('firewall-table');
  const rules = (data.rules || []).filter((rule) => Number.isInteger(rule.num));
  if (!rules.length) { tb.innerHTML = '<tr><td colspan="6" class="firewall-empty"><i class="ti ti-shield-off"></i><strong>Sin reglas configuradas</strong><span>Añade una regla para controlar el tráfico entrante.</span></td></tr>'; return; }
  tb.innerHTML = rules.map((rule) => {
    const actionClass = rule.action === 'ALLOW' ? 'badge-green' : (rule.action === 'LIMIT' ? 'badge-yellow' : 'badge-red');
    return '<tr><td class="firewall-rule-number">' + rule.num + '</td><td><code>' + esc(rule.to) + '</code></td><td><span class="badge ' + actionClass + '">' + esc(rule.action) + '</span></td><td>' + esc(rule.direction || 'IN') + '</td><td class="firewall-source">' + esc(rule.from || 'Anywhere') + '</td><td><button class="btn btn-sm btn-danger" onclick="deleteRule(' + rule.num + ')" title="Eliminar regla"><i class="ti ti-trash"></i></button></td></tr>';
  }).join('');
}

async function firewallSetState(action) {
  const message = action === 'enable'
    ? 'Activar UFW puede bloquear SSH si no existe una regla para el puerto 22. ¿Continuar?'
    : 'Desactivar UFW dejará el servidor sin protección de firewall. ¿Continuar?';
  if (!confirm(message)) return;
  const r = await req('POST', '/firewall/state', { action });
  if (r?.success) { firewallShowFeedback(r.output || 'Operación completada', 'success'); loadFirewall(); }
  else firewallShowFeedback(r?.error || 'No se pudo cambiar el estado de UFW', 'error');
}

async function firewallReload() {
  const r = await req('POST', '/firewall/reload');
  if (r?.success) { firewallShowFeedback(r.output || 'UFW recargado', 'success'); loadFirewall(); }
  else firewallShowFeedback(r?.error || 'No se pudo recargar UFW', 'error');
}

async function previewRule() {
  const r = await req('POST', '/firewall/preview', firewallPayload());
  if (r?.success) firewallShowFeedback('Vista previa: ' + (r.output || 'regla válida'), 'success');
  else firewallShowFeedback(r?.error || 'Regla inválida', 'error');
}

async function createRule() {
  const r = await req('POST', '/firewall/rule', firewallPayload());
  if (r?.success) { toast('Regla añadida', 'success'); closeModal('modal-new-rule'); firewallShowFeedback(r.output || 'Regla aplicada y persistente', 'success'); loadFirewall(); }
  else firewallShowFeedback(r?.error || 'No se pudo añadir la regla', 'error');
}

async function deleteRule(num) {
  if (!confirm('¿Eliminar la regla #' + num + '? Esta acción se aplica inmediatamente.')) return;
  const r = await req('DELETE', '/firewall/rule/' + encodeURIComponent(num));
  if (r?.success) { toast('Regla eliminada', 'success'); firewallShowFeedback(r.output || 'Regla eliminada', 'success'); loadFirewall(); }
  else firewallShowFeedback(r?.error || 'No se pudo eliminar la regla', 'error');
}

Object.assign(window, { createRule, deleteRule, firewallReload, firewallSetState, loadFirewall, previewRule });
