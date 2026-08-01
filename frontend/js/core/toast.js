// core/toast.js — mensaje flotante auto-cerrado
export function toast(msg, type = 'info') {
  window.toast = toast; // backward compat para funciones globales antiguas
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = `toast ${type} show`;
  setTimeout(() => el.classList.remove('show'), 3500);
}