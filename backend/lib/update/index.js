'use strict';

// ============================================================
//  TecXPaneL — update (helpers PUROS)
//
//  Versionado MAYOR.MENOR.PARCHE. Aquí solo hay lógica sin red ni disco:
//  comparar versiones y sacar del CHANGELOG las novedades de una versión.
// ============================================================

const RE_VERSION = /^\d+\.\d+\.\d+$/;
const isValidVersion = (v) => typeof v === 'string' && RE_VERSION.test(v);

// -1 si a < b, 0 si iguales, 1 si a > b. Compara número a número ("2.10.0" > "2.9.0").
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

// Texto de la sección `## <version>` del CHANGELOG (hasta la siguiente `## `).
// Devuelve '' si no existe.
function changelogSection(text, version) {
  const lines = String(text || '').split('\n');
  const start = lines.findIndex((l) => l.startsWith('## ') && l.slice(3).trim().split(/\s+/)[0] === version);
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim();
}

// Marcadores que escribe txpl-update.sh en su log para que el panel sepa cómo acabó.
const START_MARK = '__TXPL_UPDATE_START__';
const DONE_MARK = '__TXPL_UPDATE_DONE__';

// Del log de la ÚLTIMA ejecución devuelve { text, result }: result = null si no ha
// terminado (o no hay log), si no el código de salida (0 = éxito).
function parseUpdateLog(raw) {
  const s = String(raw || '');
  const from = s.lastIndexOf(START_MARK);
  const run = from >= 0 ? s.slice(from) : s;
  const m = run.match(new RegExp(`${DONE_MARK}(\\d+)`));
  const text = run.split('\n').filter((l) => !l.includes(START_MARK) && !l.includes(DONE_MARK)).join('\n').trim();
  return { text, result: m ? parseInt(m[1], 10) : null };
}

module.exports = { isValidVersion, compareVersions, changelogSection, parseUpdateLog, START_MARK, DONE_MARK };
