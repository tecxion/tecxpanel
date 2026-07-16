// TecXPaneL — settings (ajustes de cuenta, recuperación, cambio contraseña)

// ── Settings ──────────────────────────────────────────────────
// loadSettings: carga la página de Ajustes (datos de cuenta y recuperación).
async function loadSettings() {
  const me = await req('GET', '/auth/me');
  if (!me) return;
  const rows = [
    { label: 'Usuario', value: me.username },
    { label: 'Rol', value: me.role || 'admin' },
  ];
  document.getElementById('settings-account').innerHTML = rows.map(r => `
    <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border)">
      <span style="color:var(--text-muted)">${esc(r.label)}</span>
      <span style="font-weight:600">${esc(r.value)}</span>
    </div>`).join('');

  // Precargar los datos de recuperación actuales (email + pregunta)
  const rec = await req('GET', '/auth/recovery');
  if (rec) {
    document.getElementById('set-rec-email').value = rec.email || '';
    document.getElementById('set-rec-question').value = rec.question || '';
  }

  loadNotifyConfig();
}

// saveRecovery: guarda los datos de recuperación (email, pregunta y, opcional,
// nueva respuesta), pidiendo la contraseña actual para confirmar.
async function saveRecovery() {
  const email = document.getElementById('set-rec-email').value.trim();
  const question = document.getElementById('set-rec-question').value.trim();
  const answer = document.getElementById('set-rec-answer').value;
  const password = document.getElementById('set-rec-pass').value;
  if (!email || !question) { toast('El email y la pregunta son obligatorios', 'error'); return; }
  if (!password) { toast('Introduce tu contraseña actual para confirmar', 'error'); return; }
  const r = await req('POST', '/auth/recovery', { password, email, question, answer });
  if (r?.success) {
    toast('Datos de recuperación actualizados', 'success');
    document.getElementById('set-rec-answer').value = '';
    document.getElementById('set-rec-pass').value = '';
  } else toast(r?.error || 'Error al guardar la recuperación', 'error');
}

// changePassword: cambia la contraseña del usuario (pide la actual + la nueva x2).
async function changePassword() {
  const oldPass = document.getElementById('set-pass-old').value;
  const newPass = document.getElementById('set-pass-new').value;
  const newPass2 = document.getElementById('set-pass-new2').value;
  if (!newPass || newPass.length < 8) { toast('La nueva contraseña debe tener al menos 8 caracteres', 'error'); return; }
  if (newPass !== newPass2) { toast('Las contraseñas no coinciden', 'error'); return; }
  const r = await req('POST', '/auth/password', { oldPassword: oldPass, newPassword: newPass });
  if (r?.success) {
    toast('Contraseña actualizada', 'success');
    ['set-pass-old','set-pass-new','set-pass-new2'].forEach(id => document.getElementById(id).value = '');
  } else toast(r?.error || 'Error al cambiar la contraseña', 'error');
}
