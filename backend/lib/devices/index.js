'use strict';

// lib/devices — utilidades de "dispositivo recordado": cookie HttpOnly con `id.secreto`.
// Funciones puras (sin BD) para poder probarlas y reutilizarlas en el login con Telegram/passkeys.
const crypto = require('crypto');

const COOKIE = 'txpl_dev';
const DAYS = 30;                 // caducidad deslizante: se renueva en cada uso
const GRACE_MS = 60_000;         // el secreto anterior sigue valiendo 60 s (pestañas en paralelo)

const newSecret = () => crypto.randomBytes(32).toString('base64url');
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const eq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// Extrae {id, secret} de la cabecera Cookie; null si falta o está mal formada.
function parseCookie(header) {
  const m = new RegExp(`(?:^|;\\s*)${COOKIE}=(\\d{1,12})\\.([A-Za-z0-9_-]{20,64})`).exec(header || '');
  return m ? { id: Number(m[1]), secret: m[2] } : null;
}

// Set-Cookie: HttpOnly (JS no la lee), SameSite=Strict (anti-CSRF), solo se envía a /api/auth.
function setCookie(value, secure, maxAgeSec = DAYS * 86400) {
  return `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/api/auth; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}
const clearCookie = (secure) => setCookie('', secure, 0);

// Fecha SQLite ('YYYY-MM-DD HH:MM:SS' UTC) a N días vista.
const expiresAt = (days = DAYS) => new Date(Date.now() + days * 86400_000).toISOString().slice(0, 19).replace('T', ' ');

// Etiqueta legible a partir del User-Agent (sin guardar el UA completo).
function label(ua) {
  const s = String(ua || '');
  const os = /Windows/.test(s) ? 'Windows' : /Android/.test(s) ? 'Android' : /iPhone|iPad/.test(s) ? 'iOS' : /Mac OS/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : 'Desconocido';
  const br = /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : 'Navegador';
  return `${br} en ${os}`;
}

// ¿El instante SQLite `rotatedAt` está dentro de la ventana de gracia?
const inGrace = (rotatedAt) => !!rotatedAt && Date.now() - Date.parse(rotatedAt.replace(' ', 'T') + 'Z') < GRACE_MS;

module.exports = { COOKIE, DAYS, newSecret, hash, eq, parseCookie, setCookie, clearCookie, expiresAt, label, inGrace };
