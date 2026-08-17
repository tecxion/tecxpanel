'use strict';

// ============================================================
//  TecXPaneL — Tareas Programadas (Cron)
//  Gestiona SOLO las tareas marcadas (# txpl-cron:) del crontab
//  de root; conserva el resto (incluida la línea de backups).
// ============================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const express = require('express');
const { ok, fail, clientIp, run, runSafe, wrap } = require('../lib/helpers');
const { queries, audit } = require('../database');
const C = require('../lib/cron');
const { streamStart, streamEnd } = require('../lib/common/streaming');

const router = express.Router();

// IDs de tareas ejecutándose manualmente ahora mismo: impide relanzar la MISMA
// tarea en paralelo (spam del botón "Ejecutar"). Tareas distintas sí pueden correr a la vez.
const runningCronJobs = new Set();

// Crea el directorio de logs de cron si falta (idempotente; en dev/Windows puede
// fallar por permisos y no debe tumbar la petición).
function ensureLogDir() {
  try { fs.mkdirSync(C.CRON_LOG_DIR, { recursive: true, mode: 0o700 }); } catch (_) {}
}

// Reescribe el crontab de root a partir de las tareas ACTIVAS de la base de
// datos, conservando las líneas ajenas. Sin shell: fichero temporal + crontab <file>.
async function rewriteCrontab() {
  ensureLogDir();
  const jobs = queries.listCronJobs.all().filter((j) => j.enabled);
  const current = await runSafe('crontab', ['-l']);
  const text = C.rebuildCrontab(current.stdout || '', jobs);
  const tmp = path.join(os.tmpdir(), `txpl-crontab-${Date.now()}`);
  fs.writeFileSync(tmp, text);
  try { await run('crontab', [tmp]); } finally { fs.rmSync(tmp, { force: true }); }
}

// Valida el cuerpo de creación/edición. Devuelve un mensaje de error o null.
function validateBody(body) {
  const { name, command, minute, hour, dom, month, dow } = body || {};
  if (typeof name !== 'string' || !name.trim()) return 'El nombre es obligatorio';
  if (name.trim().length > 100) return 'El nombre no puede superar 100 caracteres';
  if (!C.isValidCommand(command)) return 'El comando es inválido (vacío o con saltos de línea)';
  const campos = [['minuto', minute, 'minute'], ['hora', hour, 'hour'], ['día del mes', dom, 'dom'], ['mes', month, 'month'], ['día de la semana', dow, 'dow']];
  for (const [etq, val, field] of campos) {
    if (!C.isValidCronField(val, field)) return `Campo de programación inválido: ${etq}`;
  }
  return null;
}

function serializeJob(job) {
  const log = C.cronLogPath(job.id);
  let stat = null;
  try { stat = fs.statSync(log); } catch (_) {}
  return { ...job, log_exists: !!stat, log_size: stat?.size || 0, log_updated_at: stat?.mtime?.toISOString() || null };
}

function restoreCronRow(row) {
  queries.insertCronJobWithId.run({ id: row.id, name: row.name, command: row.command, minute: row.minute, hour: row.hour, dom: row.dom, month: row.month, dow: row.dow, enabled: row.enabled, created_at: row.created_at });
}

router.get('/', (req, res) => ok(res, { jobs: queries.listCronJobs.all().map(serializeJob) }));

router.post('/', wrap(async (req, res) => {
  const err = validateBody(req.body);
  if (err) return fail(res, 400, err);
  const { name, command, minute, hour, dom, month, dow, enabled = 1 } = req.body;
  const info = queries.insertCronJob.run({ name: name.trim(), command, minute, hour, dom, month, dow, enabled: enabled ? 1 : 0 });
  try { await rewriteCrontab(); } catch (error) { queries.deleteCronJob.run(info.lastInsertRowid); throw error; }
  audit(req.user?.username || 'system', clientIp(req), 'cron.create', name.trim());
  ok(res, { id: info.lastInsertRowid });
}));

router.put('/:id', wrap(async (req, res) => {
  const row = queries.getCronJob.get(+req.params.id);
  if (!row) return fail(res, 404, 'Tarea no encontrada');
  const err = validateBody(req.body);
  if (err) return fail(res, 400, err);
  const { name, command, minute, hour, dom, month, dow, enabled = row.enabled } = req.body;
  queries.updateCronJob.run({ id: row.id, name: name.trim(), command, minute, hour, dom, month, dow, enabled: enabled ? 1 : 0 });
  try { await rewriteCrontab(); } catch (error) { queries.updateCronJob.run(row); throw error; }
  audit(req.user?.username || 'system', clientIp(req), 'cron.update', name.trim());
  ok(res);
}));

router.post('/:id/toggle', wrap(async (req, res) => {
  const row = queries.getCronJob.get(+req.params.id);
  if (!row) return fail(res, 404, 'Tarea no encontrada');
  queries.setCronJobEnabled.run({ id: row.id, enabled: row.enabled ? 0 : 1 });
  try { await rewriteCrontab(); } catch (error) { queries.setCronJobEnabled.run({ id: row.id, enabled: row.enabled }); throw error; }
  audit(req.user?.username || 'system', clientIp(req), 'cron.toggle', `${row.name} -> ${row.enabled ? 'off' : 'on'}`);
  ok(res, { enabled: row.enabled ? 0 : 1 });
}));

router.delete('/:id', wrap(async (req, res) => {
  const row = queries.getCronJob.get(+req.params.id);
  if (!row) return fail(res, 404, 'Tarea no encontrada');
  queries.deleteCronJob.run(row.id);
  try { await rewriteCrontab(); } catch (error) { restoreCronRow(row); throw error; }
  // Borra el log de la tarea (path jail dentro de CRON_LOG_DIR).
  const log = C.cronLogPath(row.id);
  if (log.startsWith(C.CRON_LOG_DIR + '/') && fs.existsSync(log)) { try { fs.unlinkSync(log); } catch (_) {} }
  audit(req.user?.username || 'system', clientIp(req), 'cron.delete', row.name);
  ok(res);
}));

router.post('/:id/run', wrap(async (req, res) => {
  const row = queries.getCronJob.get(+req.params.id);
  if (!row) return fail(res, 404, 'Tarea no encontrada');
  if (runningCronJobs.has(row.id)) return fail(res, 409, 'Esta tarea ya se está ejecutando manualmente. Espera a que termine.');
  runningCronJobs.add(row.id);
  audit(req.user?.username || 'system', clientIp(req), 'cron.run_now', row.name);
  streamStart(res);
  ensureLogDir(); // el lockfile vive junto a los logs; el dir debe existir
  // Igual candado que el cron del sistema (mismo lockfile): flock -n sale al
  // instante si la tarea ya corre. detached: proceso hijo en su propio grupo
  // para poder matar TODO el árbol en el timeout (flock no reenvía la señal).
  const child = spawn('flock', ['-n', '-E', String(C.CRON_CONFLICT_EXIT), C.cronLockPath(row.id), '/bin/sh', '-c', row.command], { cwd: '/', env: { PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: process.env.HOME || '/root', LANG: process.env.LANG || 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const maxOutput = 64 * 1024;
  let outputBytes = 0;
  let timedOut = false;
  const write = (chunk) => {
    if (res.writableEnded || outputBytes >= maxOutput) return;
    const text = String(chunk);
    const remaining = maxOutput - outputBytes;
    const value = text.slice(0, remaining);
    outputBytes += Buffer.byteLength(value);
    res.write(value);
    if (outputBytes >= maxOutput) res.write('\n[Salida truncada a 64 KB]\n');
  };
  child.stdout.on('data', write);
  child.stderr.on('data', write);
  const killTree = (signal) => { try { process.kill(-child.pid, signal); } catch (_) { try { child.kill(signal); } catch (_) {} } };
  const timer = setTimeout(() => { timedOut = true; killTree('SIGTERM'); }, 10 * 60 * 1000);
  child.on('error', (error) => { clearTimeout(timer); runningCronJobs.delete(row.id); if (!res.writableEnded) { res.write('\n[error] ' + error.message + '\n'); streamEnd(res, 1); } });
  child.on('close', (code) => {
    clearTimeout(timer);
    runningCronJobs.delete(row.id);
    if (res.writableEnded) return;
    if (code === C.CRON_CONFLICT_EXIT) { res.write('\n[aviso] La tarea ya se está ejecutando (cron del sistema u otra ejecución). No se lanzó de nuevo.\n'); return streamEnd(res, 1); }
    if (timedOut) res.write('\n[error] La ejecución superó el límite de 10 minutos.\n');
    streamEnd(res, timedOut || code !== 0 ? 1 : 0);
  });
}));

router.get('/:id/log', wrap(async (req, res) => {
  const row = queries.getCronJob.get(+req.params.id);
  if (!row) return fail(res, 404, 'Tarea no encontrada');
  const log = C.cronLogPath(row.id);
  if (!log.startsWith(C.CRON_LOG_DIR + '/')) return fail(res, 400, 'Ruta de log inválida');
  if (!fs.existsSync(log)) return ok(res, { log: '' });
  const r = await runSafe('tail', ['-n', '300', log]);
  ok(res, { log: r.stdout || '' });
}));

module.exports = router;
