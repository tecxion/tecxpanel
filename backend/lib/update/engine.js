'use strict';

// ============================================================
//  TecXPaneL — update (efectos)
//
//  - Versión instalada: fichero VERSION (lo copia txpl-update.sh).
//  - Última versión: VERSION de la rama principal del repo en GitHub (cache 10 min).
//  - Actualizar: lanza `txpl-update.sh --remote` como unidad transitoria de
//    systemd. Tiene que ser así: el script recarga el panel con PM2 y PM2 mata
//    a los procesos hijos del panel, pero no a los de systemd.
// ============================================================

const fs = require('fs');
const path = require('path');
const { runSafe } = require('../common/run');
const U = require('./index');

const TXPL_DIR = process.env.TXPL_DIR || '/opt/txpl';
const UPDATE_SCRIPT = path.join(TXPL_DIR, 'txpl-update.sh');
const LOG_FILE = '/var/log/txpl-update.log';
const UNIT = 'txpl-update';

// Repo y rama de donde salen las actualizaciones (solo por entorno, nunca por petición).
const REPO = /^[\w.-]+\/[\w.-]+$/.test(process.env.TXPL_UPDATE_REPO || '') ? process.env.TXPL_UPDATE_REPO : 'tecxion/tecxpanel';
const BRANCH = /^[\w./-]+$/.test(process.env.TXPL_UPDATE_BRANCH || '') ? process.env.TXPL_UPDATE_BRANCH : 'main';
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`;

// Versión instalada. En desarrollo VERSION está en la raíz del repo.
function localVersion() {
  for (const p of [path.join(TXPL_DIR, 'VERSION'), path.join(__dirname, '..', '..', '..', 'VERSION')]) {
    try {
      const v = fs.readFileSync(p, 'utf8').trim();
      if (U.isValidVersion(v)) return v;
    } catch (_) { /* siguiente candidato */ }
  }
  return null;
}

async function fetchText(file) {
  const r = await fetch(`${RAW}/${file}`, { signal: AbortSignal.timeout(6000) });
  if (!r.ok) throw new Error(`GitHub respondió ${r.status}`);
  return r.text();
}

// Última versión publicada + sus novedades. Cache para no consultar GitHub en cada visita.
let cache = null; // { at, latest, notes, error }
const CACHE_MS = 10 * 60_000;

async function fetchLatest(force) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache;
  try {
    const latest = (await fetchText('VERSION')).trim();
    if (!U.isValidVersion(latest)) throw new Error('VERSION remoto inválido');
    const notes = U.changelogSection(await fetchText('CHANGELOG.md').catch(() => ''), latest);
    cache = { at: Date.now(), latest, notes, error: null };
  } catch (e) {
    cache = { at: Date.now(), latest: null, notes: '', error: `No se pudo consultar GitHub: ${e.message}` };
  }
  return cache;
}

const isRunning = async () => (await runSafe('systemctl', ['is-active', '--quiet', UNIT])).ok;

// Estado completo para la UI: versiones, novedades y, si hay, el log de la última ejecución.
async function status({ refresh = false } = {}) {
  const current = localVersion();
  const l = await fetchLatest(refresh);
  let raw = '';
  try { raw = fs.readFileSync(LOG_FILE, 'utf8').slice(-20_000); } catch (_) { /* aún no hubo updates */ }
  const log = U.parseUpdateLog(raw);
  return {
    current,
    latest: l.latest,
    available: !!(current && l.latest && U.compareVersions(current, l.latest) < 0),
    notes: l.notes,
    error: l.error,
    running: await isRunning(),
    log: log.text.split('\n').slice(-60).join('\n'),
    result: log.result,
  };
}

// Lanza la actualización en segundo plano. Lanza error con .http si no se puede.
async function start() {
  if (!fs.existsSync(UPDATE_SCRIPT)) throw Object.assign(new Error(`Falta ${UPDATE_SCRIPT}. Ejecuta una vez la actualización manual desde el repo.`), { http: 409 });
  if (await isRunning()) throw Object.assign(new Error('Ya hay una actualización en curso.'), { http: 409 });
  const r = await runSafe('systemd-run', ['--unit', UNIT, '--collect', '--quiet', 'bash', UPDATE_SCRIPT, '--remote']);
  if (!r.ok) throw Object.assign(new Error(`No se pudo iniciar la actualización: ${(r.stderr || '').trim().split('\n').slice(-1)[0]}`), { http: 500 });
}

module.exports = { localVersion, status, start };
