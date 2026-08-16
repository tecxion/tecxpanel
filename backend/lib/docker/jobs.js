'use strict';

const { randomUUID } = require('crypto');
const { queries } = require('../../database');

const activeProcesses = new Map();
const pendingLogs = new Map();  // id -> texto de log pendiente de volcar
const logTimers = new Map();    // id -> temporizador de volcado
const LOG_FLUSH_MS = 500;

queries.markInterruptedDockerJobs.run();

function createJob({ kind, containerName, userName, imageTag = null }) {
  const id = randomUUID();
  queries.createDockerJob.run({ id, kind, container_name: containerName, user_name: userName, image_tag: imageTag });
  return id;
}

function updateJob(id, fields) {
  queries.updateDockerJob.run({
    id,
    status: fields.status || null,
    image_tag: fields.imageTag || null,
    container_id: fields.containerId || null,
    error_text: fields.errorText || null,
    finished_at: fields.finishedAt || null,
    cancel_requested: fields.cancelRequested === undefined ? null : fields.cancelRequested,
  });
}

function finishJob(id, status, errorText = null) {
  flushLog(id);
  const cancelled = queries.getDockerJob.get(id)?.cancel_requested;
  updateJob(id, { status: cancelled ? 'cancelled' : status, errorText, finishedAt: new Date().toISOString() });
}

function flushLog(id) {
  const timer = logTimers.get(id);
  if (timer) { clearTimeout(timer); logTimers.delete(id); }
  const chunk = pendingLogs.get(id);
  if (chunk === undefined) return;
  pendingLogs.delete(id);
  queries.appendDockerJobLog.run({ id, chunk });
}

function appendLog(id, chunk) {
  if (!chunk) return;
  pendingLogs.set(id, (pendingLogs.get(id) || '') + String(chunk));
  if (!logTimers.has(id)) {
    logTimers.set(id, setTimeout(() => { logTimers.delete(id); flushLog(id); }, LOG_FLUSH_MS));
  }
}

function registerProcess(id, child) {
  activeProcesses.set(id, child);
}

function unregisterProcess(id, child) {
  if (activeProcesses.get(id) === child) activeProcesses.delete(id);
}

function cancelJob(id) {
  const job = queries.getDockerJob.get(id);
  if (!job || !['running', 'cancelling'].includes(job.status)) return false;
  queries.requestDockerJobCancel.run(id);
  const child = activeProcesses.get(id);
  if (!child) {
    finishJob(id, 'cancelled');
    return true;
  }
  if (child) {
    try { child.kill('SIGTERM'); } catch (_) {}
    setTimeout(() => { try { if (!child.killed) child.kill('SIGKILL'); } catch (_) {} }, 5000).unref();
  }
  return true;
}

module.exports = {
  createJob, updateJob, finishJob, appendLog, registerProcess, unregisterProcess, cancelJob,
};
