'use strict';

// ============================================================
//  TecXPaneL — apitokens (helpers PUROS)
//
//  Tokens de API para clientes externos (p. ej. el servidor MCP de Claude).
//  Aquí solo hay lógica sin DB, Express ni estado: generar/hashear tokens,
//  validar nombres, calcular caducidades y la LISTA BLANCA de rutas que un
//  token puede llamar. Todo lo que no esté en ROUTES se deniega.
//  El token en claro solo se muestra una vez; en la DB solo se guarda su hash.
// ============================================================

const crypto = require('crypto');

const TOKEN_PREFIX = 'txpl_';
// Cada ámbito incluye los anteriores. `admin` es el más potente: caducidad más corta.
const SCOPES = ['read', 'write', 'admin'];
const EXPIRY_DAYS = [30, 90, 365];
const ADMIN_EXPIRY_DAYS = [7, 30];

// Días de caducidad permitidos según el ámbito ([] si es desconocido).
const expiryDaysFor = (scope) =>
  scope === 'admin' ? ADMIN_EXPIRY_DAYS : SCOPES.includes(scope) ? EXPIRY_DAYS : [];

// Token aleatorio de 256 bits y su hash SHA-256 (hex), que es lo único que se guarda.
function generateToken() {
  const token = TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

// Sirve para distinguir un token de API de un JWT de sesión en el middleware auth.
const isApiToken = (value) => typeof value === 'string' && value.startsWith(TOKEN_PREFIX);

const RE_NAME = /^[A-Za-z0-9 _.-]{1,40}$/;
const isValidTokenName = (name) => typeof name === 'string' && RE_NAME.test(name);

// Fecha en formato SQLite 'YYYY-MM-DD HH:MM:SS' (UTC), `days` días después de `now`.
function expiresAt(days, now = new Date()) {
  const d = new Date(now.getTime() + days * 86400000);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

// Compara como texto: el formato SQLite en UTC ordena igual que las fechas.
const isExpired = (row, now = new Date()) => row.expires_at <= expiresAt(0, now);

// Lista blanca. Regex ancladas y sin flag `i`.
// Los ids de contenedor deben EMPEZAR por alfanumérico para que `.` y `..` no casen.
const CONTAINER = '[A-Za-z0-9][A-Za-z0-9_.-]*';
const ROUTES = [
  '/api/system/stats',
  '/api/system/services',
  '/api/system/update',
  '/api/websites',
  '/api/apps',
  '/api/apps/\\d+/logs',
  '/api/databases',
  '/api/docker/containers',
  `/api/docker/containers/${CONTAINER}/logs`,
  `/api/docker/containers/${CONTAINER}/stats`,
  '/api/ssl/certificates',
  '/api/backups',
  '/api/logs/errors',
].map((p) => ({ scope: 'read', method: 'GET', re: new RegExp(`^${p}$`) }));

// Ámbito write: solo acciones reversibles (reiniciar, recargar, crear backup, renovar SSL).
const DOMAIN = '[A-Za-z0-9][A-Za-z0-9.-]*';
ROUTES.push(...[
  '/api/apps/\\d+/restart',
  '/api/apps/\\d+/reload',
  `/api/docker/containers/${CONTAINER}/restart`,
  '/api/backups',
  `/api/ssl/${DOMAIN}/renew`,
].map((p) => ({ scope: 'write', method: 'POST', re: new RegExp(`^${p}$`) })));

// Ámbito admin: cualquier método sobre /api/* salvo /api/auth (los tokens no se gestionan con tokens).
// La clase de caracteres excluye `%` (sin codificaciones); `..`, `//` y segmentos que empiezan por `.`
// se rechazan en isAllowed.
ROUTES.push({ scope: 'admin', method: '*', re: /^\/api\/[A-Za-z0-9_.\-/]+$/ });

// Express NO distingue mayúsculas al enrutar: /api/Auth/x llegaría al router de auth. Por eso esta
// exclusión es insensible a mayúsculas (y cubre variantes como /api/auth./x); no toca /api/authx.
const AUTH_DENEGADO = /^\/api\/auth(?![A-Za-z0-9_-])/i;

// ¿Puede un token de este ámbito llamar a method+path? `path` sin query string y sin
// normalizar. Cada ámbito incluye los anteriores. Ámbito desconocido => false.
function isAllowed(scope, method, path) {
  const rank = SCOPES.indexOf(scope);
  if (rank < 0 || path.includes('//') || path.includes('/.') || path.includes('..') || AUTH_DENEGADO.test(path)) return false;
  return ROUTES.some((r) => SCOPES.indexOf(r.scope) <= rank && (r.method === '*' || r.method === method) && r.re.test(path));
}

module.exports = {
  TOKEN_PREFIX, SCOPES, EXPIRY_DAYS, expiryDaysFor, generateToken, hashToken, isApiToken,
  isValidTokenName, expiresAt, isExpired, isAllowed, ROUTES,
};
