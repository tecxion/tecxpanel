// Helpers puros del despliegue Docker desde Git (sin estado, sin DB, sin exec).
// Testeados en backend/test/dockerDeploy.test.js. La orquestación con efectos
// (git clone, docker build/compose, nginx) vive en routes/docker.js.
const path = require('path');

const SAFE_PATH = process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

// URL del repositorio sin credenciales embebidas (para mostrar en logs).
function sanitizeRepoUrl(url) {
  return String(url || '').replace(/(https?:\/\/)[^@]+@/, '$1');
}

// Entorno para autenticar git SIN exponer el token en la línea de comandos
// (ps aux) ni en .git/config: lo envía como cabecera Authorization vía
// GIT_CONFIG_* (git >= 2.31). Devuelve {} si no procede autenticar
// (sin token, URL no http(s), o la URL ya trae credenciales).
function buildGitAuthEnv(token, rawRepoUrl) {
  const t = String(token || '').trim();
  const url = String(rawRepoUrl || '');
  if (!t || url.includes('@') || !/^https?:\/\//i.test(url)) return {};
  const cred = t.includes(':') ? t : `x-access-token:${t}`;
  const basic = Buffer.from(cred).toString('base64');
  return {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.extraHeader',
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${basic}`,
  };
}

// Inyecta el token en la URL de clonado HTTPS para compatibilidad total con GitHub PAT
function buildAuthedRepoUrl(token, rawRepoUrl) {
  const t = String(token || '').trim();
  const url = String(rawRepoUrl || '').trim();
  if (!t || !/^https?:\/\//i.test(url)) return url;
  if (url.includes('@')) return url;
  const cred = t.includes(':') ? t : `x-access-token:${t}`;
  return url.replace(/^(https?:\/\/)/i, `$1${cred}@`);
}

// Jaula anti-traversal: true si `p` (tras resolver) queda dentro de `baseDir`.
function isInsideBase(baseDir, p) {
  const base = path.resolve(baseDir);
  const r = path.resolve(p);
  return r === base || r.startsWith(base + path.sep);
}

// Valida un puerto TCP. Vacío => { ok:true, port:null }. Inválido => { ok:false }.
function validatePort(v) {
  if (v === undefined || v === null || String(v).trim() === '') return { ok: true, port: null };
  if (!/^\d+$/.test(String(v).trim())) return { ok: false };
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return { ok: false };
  return { ok: true, port: n };
}

function validateImageRef(value) {
  const image = String(value || '').trim();
  if (!image || image.length > 256 || image.startsWith('-') || /[\s\0]/.test(image)) return { ok: false };
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:@/-]*$/.test(image)) return { ok: false };
  return { ok: true, image };
}

function normalizeEnvLines(value, options = {}) {
  const maxBytes = options.maxBytes || 32 * 1024;
  const maxLines = options.maxLines || 100;
  const envs = String(value || '');
  if (Buffer.byteLength(envs, 'utf8') > maxBytes) return { ok: false, error: 'Las variables de entorno superan el límite permitido.' };
  const lines = envs.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length > maxLines) return { ok: false, error: 'Demasiadas variables de entorno (máximo ' + maxLines + ').' };
  for (const line of lines) {
    const separator = line.indexOf('=');
    const key = separator >= 0 ? line.slice(0, separator).trim() : '';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || line.includes('\0')) {
      return { ok: false, error: 'Variable de entorno inválida: ' + (key || line.slice(0, 30)) };
    }
  }
  return { ok: true, value: lines.join('\n') };
}

function redactEnvLines(lines) {
  return (Array.isArray(lines) ? lines : []).map((line) => {
    const separator = line.indexOf('=');
    return separator < 0 ? line : line.slice(0, separator + 1) + '***';
  });
}

function validateZipEntries(entries, options = {}) {
  const maxEntries = options.maxEntries || 10_000;
  const maxPathLength = options.maxPathLength || 512;
  if (!Array.isArray(entries) || entries.length === 0) return { ok: false, error: 'El ZIP está vacío.' };
  if (entries.length > maxEntries) return { ok: false, error: 'El ZIP contiene demasiados archivos (máximo ' + maxEntries + ').' };
  for (const entry of entries) {
    const name = String(entry || '').replaceAll('\\', '/');
    if (!name || name.length > maxPathLength || name.startsWith('/') || name.split('/').includes('..')) {
      return { ok: false, error: 'Ruta no permitida dentro del ZIP: ' + name.slice(0, 120) };
    }
  }
  return { ok: true };
}

function buildCommandEnv(extra = {}) {
  return {
    PATH: SAFE_PATH,
    HOME: process.env.HOME || '/root',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    ...extra,
  };
}

// Valida y construye el bind de volumen. Nombre y ruta: ambos o ninguno.
function parseVolumeBind(volumeName, volumePath) {
  const vName = String(volumeName || '').trim();
  const vPath = String(volumePath || '').trim();
  if (!vName && !vPath) return { ok: true, bind: null };
  if (!vName || !vPath) return { ok: false, error: 'Para el volumen indica el nombre y la ruta, o deja ambos vacíos.' };
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/.test(vName)) return { ok: false, error: 'Nombre de volumen inválido.' };
  if (!vPath.startsWith('/') || vPath.includes('..')) return { ok: false, error: 'La ruta del contenedor debe ser absoluta y sin "..".' };
  return { ok: true, bind: `${vName}:${vPath}` };
}

module.exports = {
  sanitizeRepoUrl, buildGitAuthEnv, buildAuthedRepoUrl, isInsideBase,
  validatePort, validateImageRef, normalizeEnvLines, validateZipEntries,
  redactEnvLines, buildCommandEnv, parseVolumeBind,
};
