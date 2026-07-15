// TecXPaneL — auth (login, logout, 2FA, recuperación de contraseña)

// ── Auth ──────────────────────────────────────────────────────
// doLogin: envía usuario+contraseña al backend. Si hay token, lo guarda y entra
// al panel; si el backend pide 2FA, muestra el campo del código.
async function doLogin() {
  const user = document.getElementById('login-user').value;
  const pass = document.getElementById('login-pass').value;
  const data = await fetch(API + '/api/auth/login', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ username: user, password: pass })
  }).then(r => r.json()).catch(() => ({}));

  if (data.token) {
    TOKEN = data.token;
    localStorage.setItem('txpl_token', TOKEN);
    document.getElementById('user-name').textContent = data.user.username;
    document.getElementById('user-avatar').textContent = data.user.username[0].toUpperCase();
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    document.getElementById('status-badge').style.display = 'flex';
    initApp();
  } else {
    document.getElementById('login-error').style.display = 'block';
  }
}

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
  TOKEN = '';
  localStorage.removeItem('txpl_token');
  if (statsWS) statsWS.close();
  termCleanup();
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
