'use strict';

// ============================================================
//  TecXPaneL — Tareas Programadas (Cron)
//  Gestiona SOLO las tareas marcadas (# txpl-cron:) del crontab
//  de root; conserva el resto (incluida la línea de backups).
// ============================================================

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { ok, fail, clientIp, run, runSafe, wrap } = require('../lib/helpers');
const { queries, audit } = require('../database');
const C = require('../lib/cron');

const router = express.Router();

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
  if (!C.isValidCommand(command)) return 'El comando es inválido (vacío o con saltos de línea)';
  const campos = [['minuto', minute], ['hora', hour], ['día del mes', dom], ['mes', month], ['día de la semana', dow]];
  for (const [etq, val] of campos) {
    if (!C.isValidCronField(val)) return `Campo de programación inválido: ${etq}`;
  }
  return null;
}

router.get('/', (req, res) => ok(res, { jobs: queries.listCronJobs.all() }));

router.post('/', wrap(async (req, res) => {
  const err = validateBody(req.body);
  if (err) return fail(res, 400, err);
  const { name, command, minute, hour, dom, month, dow, enabled = 1 } = req.body;
  const info = queries.insertCronJob.run({ name: name.trim(), command, minute, hour, dom, month, dow, enabled: enabled ? 1 : 0 });
  await rewriteCrontab();
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
  await rewriteCrontab();
  audit(req.user?.username || 'system', clientIp(req), 'cron.update', name.trim());
  ok(res);
}));

router.post('/:id/toggle', wrap(async (req, res) => {
  const row = queries.getCronJob.get(+req.params.id);
  if (!row) return fail(res, 404, 'Tarea no encontrada');
  queries.setCronJobEnabled.run({ id: row.id, enabled: row.enabled ? 0 : 1 });
  await rewriteCrontab();
  audit(req.user?.username || 'system', clientIp(req), 'cron.toggle', `${row.name} -> ${row.enabled ? 'off' : 'on'}`);
  ok(res, { enabled: row.enabled ? 0 : 1 });
}));

router.delete('/:id', wrap(async (req, res) => {
  const row = queries.getCronJob.get(+req.params.id);
  if (!row) return fail(res, 404, 'Tarea no encontrada');
  queries.deleteCronJob.run(row.id);
  await rewriteCrontab();
  // Borra el log de la tarea (path jail dentro de CRON_LOG_DIR).
  const log = C.cronLogPath(row.id);
  if (log.startsWith(C.CRON_LOG_DIR + '/') && fs.existsSync(log)) { try { fs.unlinkSync(log); } catch (_) {} }
  audit(req.user?.username || 'system', clientIp(req), 'cron.delete', row.name);
  ok(res);
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
