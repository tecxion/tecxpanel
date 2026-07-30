// Helpers puros del despliegue Docker desde Git (sin estado, sin DB, sin exec).
// Testeados en backend/test/dockerDeploy.test.js. La orquestación con efectos
// (git clone, docker build/compose, nginx) vive en routes/docker.js.
const path = require('path');

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

// Jaula anti-traversal: true si `p` (tras resolver) queda dentro de `baseDir`.
function isInsideBase(baseDir, p) {
  const base = path.resolve(baseDir);
  const r = path.resolve(p);
  return r === base || r.startsWith(base + path.sep);
}

// Valida un puerto TCP. Vacío => { ok:true, port:null }. Inválido => { ok:false }.
function validatePort(v) {
  if (v === undefined || v === null || String(v).trim() === '') return { ok: true, port: null };
  const n = parseInt(v, 10);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return { ok: false };
  return { ok: true, port: n };
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

module.exports = { sanitizeRepoUrl, buildGitAuthEnv, isInsideBase, validatePort, parseVolumeBind };
