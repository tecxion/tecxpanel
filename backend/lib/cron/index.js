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
const CRON_CONFLICT_EXIT = 75; // flock -E: código de salida cuando la tarea ya se está ejecutando
const CRON_FIELD_RANGES = {
  minute: [0, 59], hour: [0, 23], dom: [1, 31], month: [1, 12], dow: [0, 7], generic: [0, 999],
};

function cronLogPath(id) {
  return `${CRON_LOG_DIR}/${id}.log`;
}

// Valida un campo cron: *, n, a-b, con paso opcional /n, en listas separadas
// por comas. Es validación de FORMA (no comprueba el rango exacto de cada campo).
function isValidCronField(token, field = 'generic') {
  if (typeof token !== 'string' || token.trim() === '') return false;
  const range = CRON_FIELD_RANGES[field] || CRON_FIELD_RANGES.generic;
  return token.split(',').every((part) => {
    const match = part.match(/^(\*|\d+|\d+-\d+)(?:\/(\d+))?$/);
    if (!match) return false;
    const step = match[2] === undefined ? null : Number(match[2]);
    if (step !== null && (step < 1 || step > range[1] - range[0] + 1)) return false;
    if (match[1] === '*') return true;
    const bounds = match[1].split('-').map(Number);
    if (bounds.some((value) => value < range[0] || value > range[1])) return false;
    return bounds.length === 1 || bounds[0] <= bounds[1];
  });
}

// El comando debe ser un string no vacío y SIN saltos de línea (un \n permitiría
// inyectar líneas adicionales en el crontab).
function isValidCommand(cmd) {
  return typeof cmd === 'string' && cmd.trim() !== '' && cmd.length <= 4096 && !/[\n\r]/.test(cmd);
}

// Ruta del lockfile por tarea. Compartido por la línea del crontab (cron del
// sistema) y por "Ejecutar ahora" para que NUNCA corran dos instancias a la vez.
function cronLockPath(id) {
  return `${CRON_LOG_DIR}/${id}.lock`;
}

// Envuelve el comando en `flock -n`: si la tarea ya está corriendo, la nueva
// instancia sale de inmediato con CRON_CONFLICT_EXIT sin ejecutar nada. Escapa
// las comillas simples para poder meter cualquier comando dentro de sh -c '...'.
function flockWrap(id, command) {
  const escaped = String(command).replace(/'/g, "'\\''");
  return `flock -n -E ${CRON_CONFLICT_EXIT} ${cronLockPath(id)} /bin/sh -c '${escaped}'`;
}

// Construye las dos líneas de una tarea: el marcador y la línea de cron con el
// candado flock y la redirección de la salida al log de la tarea.
function buildCronJobLines({ id, minute, hour, dom, month, dow, command }) {
  const expr = [minute, hour, dom, month, dow].join(' ');
  return `${CRON_MARKER}${id}\n${expr} ${flockWrap(id, command)} >> ${cronLogPath(id)} 2>&1`;
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
  CRON_MARKER, CRON_LOG_DIR, CRON_CONFLICT_EXIT, cronLogPath, cronLockPath,
  CRON_FIELD_RANGES, isValidCronField, isValidCommand, buildCronJobLines, rebuildCrontab,
};
