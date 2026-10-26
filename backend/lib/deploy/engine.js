'use strict';

// ============================================================
//  TecXPaneL — deploy (efectos): clonar, actualizar y extraer
//
//  Compartido por routes/websites.js, routes/apps.js y webhooks.js.
//  Todos los comandos van con execFile + array de args (sin shell).
// ============================================================

const path = require('path');
const fs = require('fs');
const { runSafe } = require('../common/run');
const { flattenSingleSubdir } = require('../docker/config');
const { gitEnv } = require('./index');

const LONG = { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 };

// Última línea útil de stderr, sin filtrar el token (va en env, no sale en los mensajes).
const lastLine = (s) => (s || '').split('\n').filter(Boolean).slice(-1)[0] || 'error desconocido';

// Clona `repo` (rama `branch`) en `dir`. `dir` debe no existir o estar vacío.
// Devuelve { ok, error }.
async function cloneRepo(dir, repo, branch, token) {
  const r = await runSafe('git', ['clone', '--depth=1', '-b', branch, '--', repo, dir], { ...LONG, env: gitEnv(token) });
  return r.ok ? { ok: true } : { ok: false, error: lastLine(r.stderr) };
}

// Trae lo último de la rama y descarta cambios locales (la fuente de la verdad es el repo).
async function pullRepo(dir, branch, token) {
  const opts = { ...LONG, cwd: dir, env: gitEnv(token) };
  const f = await runSafe('git', ['fetch', '--depth=1', 'origin', branch], opts);
  if (!f.ok) return { ok: false, error: lastLine(f.stderr) };
  const r = await runSafe('git', ['reset', '--hard', 'FETCH_HEAD'], opts);
  return r.ok ? { ok: true } : { ok: false, error: lastLine(r.stderr) };
}

// Extrae el primer .zip/.tar/.tar.gz/.tgz que haya en `dir`, lo borra y aplana la
// carpeta raíz si el ZIP venía con una. Devuelve el nombre extraído o null si no había.
async function extractArchive(dir) {
  const archive = fs.readdirSync(dir).find((f) => /\.(zip|tar\.gz|tgz|tar)$/i.test(f));
  if (!archive) return null;
  const ap = path.join(dir, archive);
  const low = archive.toLowerCase();
  let r;
  if (low.endsWith('.zip')) {
    if (!(await runSafe('unzip', ['-v'])).ok) await runSafe('apt-get', ['install', '-y', 'unzip'], { timeout: 120_000 });
    r = await runSafe('unzip', ['-o', ap, '-d', dir], LONG);
  } else {
    r = await runSafe('tar', [low.endsWith('.tar') ? '-xf' : '-xzf', ap, '-C', dir], LONG);
  }
  if (!r.ok) throw Object.assign(new Error('No se pudo extraer el archivo: ' + lastLine(r.stderr)), { http: 400 });
  try { fs.unlinkSync(ap); } catch (_) {}
  flattenSingleSubdir(dir);
  return archive;
}

module.exports = { cloneRepo, pullRepo, extractArchive };
