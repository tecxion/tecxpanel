'use strict';

// ============================================================
//  TecXPaneL — deploy (helpers PUROS del origen del código)
//
//  Sitios web y apps reciben su código igual: o subiendo archivos
//  (ZIP / archivos sueltos / carpeta) o clonando un repo de GitHub.
//  Aquí vive lo que no toca disco ni red, para poder testearlo.
// ============================================================

// Token de acceso a repos privados (GitHub: ghp_…, github_pat_…; GitLab: glpat-…).
// Solo caracteres "de token": evita meter saltos de línea en la cabecera HTTP.
const RE_GIT_TOKEN = /^[A-Za-z0-9_.-]{8,255}$/;
const isValidGitToken = (t) => typeof t === 'string' && RE_GIT_TOKEN.test(t);

// Entorno para ejecutar git. El token viaja en una cabecera HTTP pasada por
// variables de entorno (GIT_CONFIG_*), NUNCA por argv (se vería en `ps`) ni
// escrito en .git/config (la URL del remoto queda limpia).
// Entorno mínimo a propósito: no heredamos process.env completo.
function gitEnv(token) {
  const env = {
    PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME || '/root',
    LANG: 'C.UTF-8',
    GIT_TERMINAL_PROMPT: '0', // si falta/está mal el token, falla en vez de quedarse pidiendo usuario
  };
  if (token) {
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
  }
  return env;
}

// Un token solo tiene sentido con https:// (por http o ssh iría en claro / se ignoraría).
const tokenNeedsHttps = (repo, token) => !!token && !/^https:\/\//i.test(repo || '');

module.exports = { isValidGitToken, gitEnv, tokenNeedsHttps };
