// core/theme.js — tema claro/oscuro/sistema
export function themePref() {
  try { return localStorage.getItem('txpl_theme') || 'system'; } catch (_) { return 'system'; }
}

export function applyTheme(pref) {
  const light = pref === 'light' ||
    (pref === 'system' && window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.setAttribute('data-theme', light ? 'light' : 'dark');
  const ic = document.getElementById('theme-toggle-icon');
  if (ic) ic.className = 'ti ti-' + (light ? 'moon' : 'sun');
}

export function setThemePref(pref) {
  try { localStorage.setItem('txpl_theme', pref); } catch (_) { }
  applyTheme(pref);
  const sel = document.getElementById('set-theme');
  if (sel) sel.value = pref;
}

export function toggleTheme() {
  const light = document.documentElement.getAttribute('data-theme') === 'light';
  setThemePref(light ? 'dark' : 'light');
}

if (window.matchMedia) {
  const mq = matchMedia('(prefers-color-scheme: light)');
  if (mq.addEventListener) mq.addEventListener('change', () => {
    if (themePref() === 'system') applyTheme('system');
  });
}