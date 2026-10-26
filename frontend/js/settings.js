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
  loadAbout();
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

// ── Acerca de: versión instalada y actualización ─────────────────
// Muestra la versión; si hay una más nueva en GitHub, sus novedades y el botón
// Actualizar. La actualización corre en segundo plano en el servidor (el panel se
// recarga a mitad), así que aquí solo se consulta el estado cada pocos segundos
// hasta que acaba, y entonces se recarga la página.
let aboutPoll = null;

async function loadAbout(refresh) {
  const box = document.getElementById('about-update');
  if (!box) return;
  const s = await req('GET', '/system/update' + (refresh ? '?refresh=1' : ''));
  if (!s) return;
  if (s.running) { renderUpdating(s); watchUpdate(); return; }
  const ver = s.current ? 'v' + esc(s.current) : 'desconocida';
  let html = `<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap">
    <span>Versión instalada: <strong>${ver}</strong></span>`;
  if (s.available) {
    html += `<span class="badge badge-green">Nueva versión v${esc(s.latest)}</span>
      <button class="btn btn-primary btn-sm" onclick="startPanelUpdate()"><i class="ti ti-download"></i> Actualizar</button>`;
  } else if (s.latest) {
    html += '<span class="badge badge-green">Al día</span>';
  }
  html += `<button class="btn btn-sm" onclick="loadAbout(true)" title="Buscar actualizaciones"><i class="ti ti-refresh"></i></button></div>`;
  if (s.error) html += `<div class="muted" style="margin-top:6px">${esc(s.error)}</div>`;
  if (s.available && s.notes) html += `<pre style="margin-top:10px;white-space:pre-wrap;font-family:inherit;font-size:12px;color:var(--text-secondary)">${esc(s.notes)}</pre>`;
  // Si la última actualización falló, se enseña por qué (el log del servidor).
  if (s.result && s.result !== 0 && s.log) html += `<div class="muted" style="margin-top:10px">La última actualización falló y se restauró la copia previa:</div><pre style="max-height:200px;overflow:auto;font-size:11px">${esc(s.log)}</pre>`;
  box.innerHTML = html;
}

function renderUpdating(s) {
  const box = document.getElementById('about-update');
  box.innerHTML = `<div><i class="ti ti-loader-2 spin"></i> <strong>Actualizando…</strong> <span class="muted">No cierres esta página; el panel se recargará solo al terminar.</span></div>
    <pre id="about-update-log" style="margin-top:10px;max-height:240px;overflow:auto;font-size:11px;background:#050805;color:#33ff66;padding:10px;border-radius:8px">${esc(s.log || '')}</pre>`;
  const pre = document.getElementById('about-update-log');
  if (pre) pre.scrollTop = pre.scrollHeight;
}

async function startPanelUpdate() {
  if (!confirm('Se descargará la última versión y se reiniciará el panel unos segundos. Se hace una copia previa y, si algo falla, se restaura sola. ¿Actualizar ahora?')) return;
  const r = await req('POST', '/system/update');
  if (!r?.success) { toast(r?.error || 'No se pudo iniciar la actualización', 'error'); return; }
  renderUpdating({ log: 'Iniciando…' });
  watchUpdate();
}

// watchUpdate: consulta el estado cada 3 s. Mientras el panel se reinicia las
// peticiones fallan: se ignoran y se sigue esperando.
function watchUpdate() {
  if (aboutPoll) return;
  aboutPoll = setInterval(async () => {
    let s = null;
    try {
      const r = await fetch(API + '/api/system/update', { headers: { Authorization: `Bearer ${TOKEN}` } });
      if (r.ok) s = await r.json();
    } catch (_) { /* panel reiniciándose */ }
    if (!s) return;
    if (s.running) { renderUpdating(s); return; }
    clearInterval(aboutPoll); aboutPoll = null;
    if (s.result === 0) { toast('Panel actualizado. Recargando…', 'success'); setTimeout(() => location.reload(), 1500); }
    else { toast('La actualización falló; se restauró la versión anterior', 'error'); loadAbout(); }
  }, 3000);
}

Object.assign(window, {
  changePassword, loadSettings, saveRecovery, loadAbout, startPanelUpdate });
