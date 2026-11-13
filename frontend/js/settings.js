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
  loadApiTokens();
  loadAiAdmin();
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

// ── Tokens de API (IA / MCP) ─────────────────────────────────────
// Un token da acceso de solo lectura a una IA. Se crea con la contraseña actual,
// el servidor lo devuelve UNA sola vez y aquí solo se pinta en #tok-new (nunca se
// guarda en localStorage ni en variables; "Copiar" lo lee del DOM).

// hideNewToken: oculta y vacía el token recién creado.
function hideNewToken() {
  const box = document.getElementById('tok-new');
  box.innerHTML = '';
  box.style.display = 'none';
}

// loadApiTokens: pinta la tabla de tokens (sin el valor secreto, que no se conserva).
async function loadApiTokens() {
  hideNewToken();
  const tb = document.getElementById('tok-list');
  if (!tb) return;
  const data = await req('GET', '/auth/tokens');
  if (!Array.isArray(data)) return;
  if (!data.length) {
    tb.innerHTML = '<tr><td colspan="6" class="empty-state">' + emptyState('key', 'Aún no hay tokens') + '</td></tr>';
    return;
  }
  tb.innerHTML = data.map(t => {
    const id = Number(t.id); // numérico: va dentro de un onclick
    return `
    <tr>
      <td style="font-weight:600">${esc(t.name)}</td>
      <td><span class="badge ${t.scope === 'admin' ? 'badge-red' : 'badge-blue'}">${esc(TOK_SCOPE_LABEL[t.scope] || t.scope)}</span></td>
      <td style="color:var(--text-muted)">${esc(fmtDate(t.created_at))}</td>
      <td style="color:var(--text-muted)">${esc(fmtDate(t.expires_at))}</td>
      <td style="color:var(--text-muted)">${t.last_used_at ? esc(fmtDate(t.last_used_at)) : 'Nunca'}</td>
      <td style="text-align:right"><button class="btn btn-sm btn-danger" onclick="revokeApiToken(${id})"><i class="ti ti-trash"></i> Revocar</button></td>
    </tr>`;
  }).join('');
  // Guardados para el confirm de revocar (confirm() es texto plano: no se escapa)
  data.forEach(t => { tokNames[Number(t.id)] = t.name; });
}
// Etiqueta legible y caducidades permitidas por ámbito (el servidor las valida de nuevo)
const TOK_SCOPE_LABEL = { read: 'Lectura', write: 'Acciones', admin: 'Control total' };
const TOK_DAYS = { read: [30, 90, 365], write: [30, 90, 365], admin: [7, 30] };
const TOK_DAYS_DEFAULT = { read: 90, write: 90, admin: 7 };
let aiAdminOn = false; // estado del interruptor global de control total
let has2fa = false;    // el usuario tiene 2FA activo (pide código para tokens admin)
const tokNames = {}; // id → nombre, solo para mostrarlo en el confirm de revocar

// onTokScopeChange: adapta caducidades, avisos y campo 2FA al ámbito elegido.
function onTokScopeChange() {
  const scope = document.getElementById('tok-scope').value;
  const sel = document.getElementById('tok-days');
  sel.innerHTML = TOK_DAYS[scope].map(d => `<option value="${d}"${d === TOK_DAYS_DEFAULT[scope] ? ' selected' : ''}>${d} días</option>`).join('');
  document.getElementById('tok-help-write').style.display = scope === 'write' ? 'block' : 'none';
  document.getElementById('tok-help-admin').style.display = scope === 'admin' ? 'block' : 'none';
  document.getElementById('tok-code-group').style.display = scope === 'admin' && has2fa ? 'block' : 'none';
}

// loadAiAdmin: pinta el estado del interruptor global y consulta si hay 2FA.
async function loadAiAdmin() {
  const btn = document.getElementById('ai-admin-toggle');
  if (!btn) return;
  const [st, tf] = await Promise.all([req('GET', '/auth/ai-admin'), req('GET', '/auth/2fa/status')]);
  has2fa = !!tf?.enabled;
  if (st) aiAdminOn = !!st.enabled;
  const badge = document.getElementById('ai-admin-state');
  badge.textContent = aiAdminOn ? 'Activado' : 'Desactivado';
  badge.className = 'badge ' + (aiAdminOn ? 'badge-red' : 'badge-green');
  btn.className = 'btn ' + (aiAdminOn ? 'btn-danger' : 'btn-primary');
  btn.innerHTML = aiAdminOn ? '<i class="ti ti-power"></i> Desactivar control total' : '<i class="ti ti-power"></i> Activar control total';
  const opt = document.getElementById('tok-opt-admin');
  opt.disabled = !aiAdminOn;
  opt.title = aiAdminOn ? '' : 'Actívalo primero en “Control total de IA”';
  opt.textContent = aiAdminOn ? 'Control total (admin)' : 'Control total (admin) — actívalo primero en “Control total de IA”';
  const scope = document.getElementById('tok-scope');
  if (!aiAdminOn && scope.value === 'admin') scope.value = 'read';
  onTokScopeChange();
}

// toggleAiAdmin: enciende/apaga el control total (pide la contraseña actual).
async function toggleAiAdmin() {
  const passEl = document.getElementById('ai-admin-pass');
  const password = passEl.value;
  if (!password) { toast('Introduce tu contraseña actual para confirmar', 'error'); return; }
  const enabled = !aiAdminOn;
  if (!enabled && !confirm('Al desactivarlo, los tokens admin existentes dejarán de funcionar de inmediato (no se borran). ¿Continuar?')) return;
  const btn = document.getElementById('ai-admin-toggle');
  if (btn.disabled) return;
  btn.disabled = true;
  let r;
  try {
    r = await req('POST', '/auth/ai-admin', { enabled, password });
  } catch (e) {
    toast('Error de red al cambiar el control total', 'error');
    return;
  } finally {
    btn.disabled = false;
  }
  passEl.value = '';
  if (r?.enabled === undefined) { toast(r?.error || 'Error al cambiar el control total', 'error'); return; }
  toast(r.enabled ? 'Control total activado' : 'Control total desactivado', 'success');
  await loadAiAdmin();
}

// createApiToken: crea un token y enseña su valor una única vez.
async function createApiToken() {
  const name = document.getElementById('tok-name').value.trim();
  const scope = document.getElementById('tok-scope').value;
  const days = parseInt(document.getElementById('tok-days').value, 10);
  const password = document.getElementById('tok-pass').value;
  // El código 2FA solo se pide (y envía) para tokens admin con 2FA activo
  const needCode = scope === 'admin' && has2fa;
  const code = document.getElementById('tok-code').value.trim();
  if (!name) { toast('Ponle un nombre al token', 'error'); return; }
  if (needCode && !/^\d{6}$/.test(code)) { toast('Introduce el código 2FA de 6 dígitos', 'error'); return; }
  if (!password) { toast('Introduce tu contraseña actual para confirmar', 'error'); return; }
  const btn = document.getElementById('tok-create');
  if (btn.disabled) return; // evita crear dos tokens con doble clic
  btn.disabled = true;
  let r;
  try {
    r = await req('POST', '/auth/tokens', needCode ? { name, scope, days, password, code } : { name, scope, days, password });
  } catch (e) {
    toast('Error de red al crear el token', 'error');
    return;
  } finally {
    btn.disabled = false;
  }
  document.getElementById('tok-pass').value = '';
  document.getElementById('tok-code').value = '';
  if (!r?.token) { toast(r?.error || 'Error al crear el token', 'error'); return; }
  document.getElementById('tok-name').value = '';
  await loadApiTokens(); // vacía #tok-new; se rellena justo después
  const box = document.getElementById('tok-new');
  box.innerHTML = `
    <code id="tok-new-value" style="display:block;word-break:break-all;padding:10px;background:var(--bg-card2);border:1px solid var(--border);border-radius:var(--radius)">${esc(r.token)}</code>
    <div style="display:flex;align-items:center;gap:10px;margin-top:8px;flex-wrap:wrap">
      <button class="btn btn-sm" onclick="copyText(document.getElementById('tok-new-value').textContent)"><i class="ti ti-copy"></i> Copiar</button>
      <button class="btn btn-sm" onclick="hideNewToken()"><i class="ti ti-eye-off"></i> Ocultar</button>
      <span style="font-size:12px;color:var(--text-secondary)"><i class="ti ti-alert-triangle" style="color:var(--accent)"></i> Cópialo ahora: no volverá a mostrarse.</span>
    </div>`;
  box.style.display = 'block';
  toast('Token creado', 'success');
}

// revokeApiToken: revoca un token tras confirmar.
async function revokeApiToken(id) {
  id = Number(id);
  if (!confirm(`¿Revocar el token "${tokNames[id] ?? id}"? La IA que lo use perderá el acceso al instante.`)) return;
  const r = await req('DELETE', `/auth/tokens/${id}`);
  if (r?.success) { toast('Token revocado', 'success'); loadApiTokens(); }
  else toast(r?.error || 'Error al revocar el token', 'error');
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
  changePassword, loadSettings, saveRecovery, loadAbout, startPanelUpdate,
  loadApiTokens, createApiToken, revokeApiToken, hideNewToken,
  onTokScopeChange, loadAiAdmin, toggleAiAdmin });
