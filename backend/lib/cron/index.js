'use strict';

// ============================================================
//  TecXPaneL — Helpers puros de Tareas Programadas (Cron)
//
//  Sin estado ni dependencias del servidor: validación de campos
//  cron y de comandos, construcción de las líneas de una tarea y
//  reconstrucción del crontab conservando las líneas ajenas.
// ============================================================

const CRON_MARKER = '# txpl-cron:';
const CRON_LOG_DIR = '/var/log/txpl/cron';

function cronLogPath(id) {
  return `${CRON_LOG_DIR}/${id}.log`;
}

// Valida un campo cron: *, n, a-b, con paso opcional /n, en listas separadas
// por comas. Es validación de FORMA (no comprueba el rango exacto de cada campo).
function isValidCronField(token) {
  if (typeof token !== 'string' || token.trim() === '') return false;
  return token.split(',').every((part) => /^(\*|\d+|\d+-\d+)(\/\d+)?$/.test(part));
}

// El comando debe ser un string no vacío y SIN saltos de línea (un \n permitiría
// inyectar líneas adicionales en el crontab).
function isValidCommand(cmd) {
  return typeof cmd === 'string' && cmd.trim() !== '' && !/[\n\r]/.test(cmd);
}

// Construye las dos líneas de una tarea: el marcador y la línea de cron con la
// redirección de la salida al log de la tarea.
function buildCronJobLines({ id, minute, hour, dom, month, dow, command }) {
  const expr = [minute, hour, dom, month, dow].join(' ');
  return `${CRON_MARKER}${id}\n${expr} ${command} >> ${cronLogPath(id)} 2>&1`;
}

// Reconstruye el texto del crontab: conserva TODAS las líneas ajenas y elimina
// los bloques gestionados previos (marcador + su línea de comando siguiente),
// añadiendo al final el bloque regenerado a partir de `jobs` (tareas activas).
function rebuildCrontab(currentText, jobs) {
  const lines = String(currentText || '').split('\n');
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(CRON_MARKER)) { i++; continue; } // salta marcador + comando
    kept.push(lines[i]);
  }
  while (kept.length && kept[kept.length - 1] === '') kept.pop(); // quita vacías finales
  const block = (jobs || []).map((j) => buildCronJobLines(j)).join('\n');
  const parts = [];
  if (kept.length) parts.push(kept.join('\n'));
  if (block) parts.push(block);
  return parts.join('\n') + '\n';
}

module.exports = {
  CRON_MARKER, CRON_LOG_DIR, cronLogPath,
  isValidCronField, isValidCommand, buildCronJobLines, rebuildCrontab,
};
