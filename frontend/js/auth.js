// TecXPaneL — auth (login, logout, 2FA, recuperación de contraseña)

// ── Auth ──────────────────────────────────────────────────────
// doLogin: envía usuario+contraseña (y código 2FA si el backend lo pide) al
// backend. Si hay token, entra al panel; si pide 2FA, muestra el campo del
// código; si falla, muestra el error real del backend. Bloquea el botón
// mientras la petición está en vuelo para evitar dobles envíos.
async function doLogin() {
  const btn = document.getElementById('login-btn');
  const errEl = document.getElementById('login-error');
  const user = document.getElementById('login-user').value.trim() || 'admin';
  const pass = document.getElementById('login-pass').value;
  const codeField = document.getElementById('login-2fa-field');
  const code = codeField.style.display === 'none' ? undefined
    : document.getElementById('login-code').value.trim();

  errEl.textContent = '';
  errEl.style.display = 'none';
  btn.disabled = true;
  const prevLabel = btn.textContent;
  btn.textContent = 'Entrando…';

  let data = null, netErr = false;
  try {
    const res = await fetch(API + '/api/auth/login', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ username: user, password: pass, code, remember: document.getElementById('login-remember').checked }),
    });
    data = await res.json().catch(() => ({}));
  } catch (_) { netErr = true; }

  btn.disabled = false;
  btn.textContent = prevLabel;

  if (netErr) {
    errEl.textContent = 'Error de red. Comprueba tu conexión.';
    errEl.style.display = 'block';
    return;
  }

  if (data && data.token) { enterPanel(data); return; }

  // Login pendiente de aprobar en Telegram: consulta cada 2 s hasta aprobar, denegar o caducar.
  if (data && data.pending) { waitTelegramApproval(data.pollSecret, data.expiresIn, errEl, btn); return; }

  // El backend pide 2FA: muestra el campo y devuelve el foco allí.
  if (data && data.twofa) {
    codeField.style.display = '';
    const codeInput = document.getElementById('login-code');
    codeInput.value = '';
    codeInput.focus();
    errEl.textContent = data.error === 'Código 2FA incorrecto' ? 'Código 2FA incorrecto' : '';
    errEl.style.display = errEl.textContent ? 'block' : 'none';
    return;
  }

  errEl.textContent = (data && data.error) || 'Credenciales incorrectas';
  errEl.style.display = 'block';
}

// enterPanel: guarda el JWT y muestra el panel (login normal o tras aprobar en Telegram).
function enterPanel(data) {
  TOKEN = data.token;
  localStorage.setItem('txpl_token', TOKEN);
  document.getElementById('user-name').textContent = data.user.username;
  document.getElementById('user-avatar').textContent = (data.user.username[0] || '?').toUpperCase();
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  document.getElementById('status-badge').style.display = 'flex';
  initApp();
}

// waitTelegramApproval: bloquea el botón y espera la decisión del bot de Telegram.
async function waitTelegramApproval(pollSecret, expiresIn, errEl, btn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Esperando aprobación en Telegram…';
  errEl.textContent = 'Abre Telegram y pulsa «Aprobar» (caduca en 2 min).';
  errEl.style.display = 'block';
  const until = Date.now() + (expiresIn || 120) * 1000;
  let msg = 'La aprobación caducó. Inicia sesión de nuevo.';
  while (Date.now() < until + 5000) {
    await new Promise((r) => setTimeout(r, 2000));
    let res, d;
    try {
      res = await fetch(API + '/api/auth/login/poll', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pollSecret }),
      });
      d = await res.json().catch(() => ({}));
    } catch (_) { continue; } // fallo de red puntual: sigue intentando
    if (d.token) { btn.disabled = false; btn.textContent = label; errEl.style.display = 'none'; enterPanel(d); return; }
    if (d.status === 'pending') continue;
    msg = d.error || msg; break;
  }
  btn.disabled = false;
  btn.textContent = label;
  errEl.textContent = msg;
  errEl.style.display = 'block';
}

// ── Passkeys (WebAuthn) ───────────────────────────────────────
// El servidor habla JSON con base64url; el navegador, con ArrayBuffer. Estas funciones convierten.
const b64uToBuf = (s) => {
  const p = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(p + '='.repeat((4 - p.length % 4) % 4)), (c) => c.charCodeAt(0)).buffer;
};
const bufToB64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Opciones del servidor → opciones nativas de navigator.credentials.
function decodePasskeyOptions(o) {
  o.challenge = b64uToBuf(o.challenge);
  if (o.user) o.user.id = b64uToBuf(o.user.id);
  (o.excludeCredentials || []).forEach((c) => { c.id = b64uToBuf(c.id); });
  (o.allowCredentials || []).forEach((c) => { c.id = b64uToBuf(c.id); });
  return o;
}

// Credencial del navegador → JSON para el servidor (alta o login).
function encodePasskeyCredential(c) {
  const r = c.response;
  const response = { clientDataJSON: bufToB64u(r.clientDataJSON) };
  if (r.attestationObject) {
    response.attestationObject = bufToB64u(r.attestationObject);
    response.transports = r.getTransports ? r.getTransports() : [];
  } else {
    response.authenticatorData = bufToB64u(r.authenticatorData);
    response.signature = bufToB64u(r.signature);
    if (r.userHandle) response.userHandle = bufToB64u(r.userHandle);
  }
  return { id: c.id, rawId: bufToB64u(c.rawId), type: c.type, clientExtensionResults: c.getClientExtensionResults(), response };
}

// doPasskeyLogin: entra con huella/PIN/llave de seguridad, sin contraseña.
async function doPasskeyLogin() {
  const errEl = document.getElementById('login-error');
  errEl.style.display = 'none';
  const post = (path, body) => fetch(API + '/api/auth' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body),
  }).then(async (r) => ({ ok: r.ok, d: await r.json().catch(() => ({})) }));
  try {
    const o = await post('/passkey/login/options');
    if (!o.ok) throw new Error(o.d.error || 'No se pudo iniciar');
    const cred = await navigator.credentials.get({ publicKey: decodePasskeyOptions(o.d.options) });
    const v = await post('/passkey/login/verify', {
      challengeId: o.d.challengeId, response: encodePasskeyCredential(cred), remember: document.getElementById('login-remember').checked,
    });
    if (!v.ok || !v.d.token) throw new Error(v.d.error || 'No se pudo verificar la passkey');
    enterPanel(v.d);
  } catch (e) {
    errEl.textContent = e.name === 'NotAllowedError' ? 'Operación cancelada' : (e.message || 'Error con la passkey');
    errEl.style.display = 'block';
  }
}
// Solo se ofrece el botón si el navegador soporta WebAuthn.
if (window.PublicKeyCredential) document.getElementById('login-passkey-btn').style.display = '';

// Aviso Caps-Lock en el input de contraseña (todos los paneles serios lo tienen).
function updateCapsHint(e) {
  const el = document.getElementById('login-caps');
  if (!el) return;
  const on = e.getModifierState && e.getModifierState('CapsLock');
  el.style.display = on ? '' : 'none';
}
['keydown','keyup'].forEach((ev) => document.getElementById('login-pass').addEventListener(ev, updateCapsHint));

// togglePassVis: muestra/oculta la contraseña del campo hermano (icono del ojo).
function togglePassVis(btn) {
  const input = btn.parentElement.querySelector('input');
  const icon = btn.querySelector('i');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  icon.className = show ? 'ti ti-eye-off' : 'ti ti-eye';
}

document.getElementById('login-pass').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});

document.getElementById('reset-username').addEventListener('keydown', e => {
  if (e.key === 'Enter') fetchSecurityQuestion();
});
['reset-answer', 'reset-email', 'reset-new-pass'].forEach(id => {
  document.getElementById(id).addEventListener('keydown', e => {
    if (e.key === 'Enter') submitResetPassword();
  });
});

// showForgotPasswordForm: cambia del formulario de login al de recuperación.
function showForgotPasswordForm(e) {
  if (e) e.preventDefault();
  document.getElementById('login-box').style.display = 'none';
  document.getElementById('reset-box').style.display = 'block';
  document.getElementById('reset-step-1').style.display = 'block';
  document.getElementById('reset-step-2').style.display = 'none';

  // Clear inputs
  document.getElementById('reset-username').value = '';
  document.getElementById('reset-answer').value = '';
  document.getElementById('reset-email').value = '';
  document.getElementById('reset-new-pass').value = '';

  // Clear errors/success
  const errEl = document.getElementById('reset-error');
  errEl.style.display = 'none';
  errEl.textContent = '';
  const succEl = document.getElementById('reset-success');
  succEl.style.display = 'none';
  succEl.textContent = '';
}

// showLoginForm: vuelve del formulario de recuperación al de login.
function showLoginForm(e) {
  if (e) e.preventDefault();
  document.getElementById('login-box').style.display = 'block';
  document.getElementById('reset-box').style.display = 'none';
  document.getElementById('login-error').style.display = 'none';
}

// fetchSecurityQuestion: pide al backend la pregunta de seguridad del usuario
// (paso 1 de la recuperación de contraseña).
async function fetchSecurityQuestion() {
  const username = document.getElementById('reset-username').value.trim();
  const errEl = document.getElementById('reset-error');
  errEl.style.display = 'none';
  errEl.textContent = '';

  if (!username) {
    errEl.textContent = 'Introduce el nombre de usuario';
    errEl.style.display = 'block';
    return;
  }

  try {
    const data = await fetch(`${API}/api/auth/reset-question?username=${encodeURIComponent(username)}`)
      .then(r => r.json());

    if (data.question) {
      document.getElementById('reset-question-text').textContent = data.question;
      document.getElementById('reset-step-1').style.display = 'none';
      document.getElementById('reset-step-2').style.display = 'block';
    } else {
      errEl.textContent = data.error || 'Usuario no encontrado o pregunta no configurada';
      errEl.style.display = 'block';
    }
  } catch (err) {
    errEl.textContent = 'Error de conexión con el servidor';
    errEl.style.display = 'block';
  }
}

// submitResetPassword: envía respuesta + email + nueva contraseña para
// restablecerla (paso 2 de la recuperación).
async function submitResetPassword() {
  const username = document.getElementById('reset-username').value.trim();
  const answer = document.getElementById('reset-answer').value.trim();
  const email = document.getElementById('reset-email').value.trim();
  const newPassword = document.getElementById('reset-new-pass').value;
  const errEl = document.getElementById('reset-error');
  const succEl = document.getElementById('reset-success');

  errEl.style.display = 'none';
  errEl.textContent = '';
  succEl.style.display = 'none';
  succEl.textContent = '';

  if (!answer || !email || !newPassword) {
    errEl.textContent = 'Todos los campos son obligatorios';
    errEl.style.display = 'block';
    return;
  }

  if (newPassword.length < 8) {
    errEl.textContent = 'La nueva contraseña debe tener al menos 8 caracteres';
    errEl.style.display = 'block';
    return;
  }

  try {
    const data = await fetch(`${API}/api/auth/reset-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, answer, email, newPassword })
    }).then(r => r.json());

    if (data.success) {
      succEl.textContent = 'Contraseña restablecida con éxito. Volviendo al login...';
      succEl.style.display = 'block';
      document.getElementById('reset-step-2').style.display = 'none';
      setTimeout(() => {
        showLoginForm();
      }, 3000);
    } else {
      errEl.textContent = data.error || 'Datos de recuperación incorrectos';
      errEl.style.display = 'block';
    }
  } catch (err) {
    errEl.textContent = 'Error al enviar la solicitud';
    errEl.style.display = 'block';
  }
}

// doLogout: borra el token, cierra el WebSocket y vuelve a la pantalla de login.
function doLogout() {
  // Revoca el dispositivo recordado de esta cookie (si existe) y la borra; sin esperar respuesta.
  fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  TOKEN = '';
  localStorage.removeItem('txpl_token');
  // disconnectStatsWS pone el flag wsShouldConnect=false para que onclose
  // NO reprograme una reconexión con el token vacío (bucle infinito antiguo).
  if (typeof disconnectStatsWS === 'function') disconnectStatsWS();
  else if (statsWS) { try { statsWS.close(); } catch (_) {} }
  // terminal.js se carga bajo demanda: si nunca se abrió, termCleanup no existe
  if (typeof termCleanup === 'function') termCleanup();
  document.getElementById('app').style.display = 'none';
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('login-box').style.display = 'block';
  document.getElementById('reset-box').style.display = 'none';
}

// checkAuth: al cargar la página, si ya hay un token guardado, entra directo
// al panel sin pedir login otra vez.
async function checkAuth() {
  if (!TOKEN) return;
  const data = await req('GET', '/auth/me');
  if (data && data.username) {
    document.getElementById('user-name').textContent = data.username;
    document.getElementById('user-avatar').textContent = data.username[0].toUpperCase();
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    document.getElementById('status-badge').style.display = 'flex';
    initApp();
  }
}

Object.assign(window, {
  checkAuth, doLogin, doPasskeyLogin, doLogout, decodePasskeyOptions, encodePasskeyCredential, fetchSecurityQuestion,
  showForgotPasswordForm, showLoginForm, submitResetPassword, togglePassVis,
});
