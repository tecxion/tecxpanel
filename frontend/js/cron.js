// TecXPaneL — cron (tareas programadas)

let cronJobs = [];

function cronPresetChange() {
  const preset = document.getElementById('cron-preset').value;
  document.getElementById('cron-time-wrap').style.display = ['day', 'week', 'month'].includes(preset) ? '' : 'none';
  document.getElementById('cron-dow-wrap').style.display = preset === 'week' ? '' : 'none';
  document.getElementById('cron-dom-wrap').style.display = preset === 'month' ? '' : 'none';
  document.getElementById('cron-custom-wrap').style.display = preset === 'custom' ? '' : 'none';
}

function cronScheduleFromForm() {
  const preset = document.getElementById('cron-preset').value;
  if (preset === 'custom') return {
    minute: document.getElementById('cron-f-min').value.trim(),
    hour: document.getElementById('cron-f-hour').value.trim(),
    dom: document.getElementById('cron-f-dom').value.trim(),
    month: document.getElementById('cron-f-month').value.trim(),
    dow: document.getElementById('cron-f-dow').value.trim(),
  };
  const time = (document.getElementById('cron-time').value || '03:00').split(':');
  const hour = String(Number(time[0]));
  const minute = String(Number(time[1]));
  if (preset === 'minute') return { minute: '*', hour: '*', dom: '*', month: '*', dow: '*' };
  if (preset === 'hour') return { minute: '0', hour: '*', dom: '*', month: '*', dow: '*' };
  if (preset === 'day') return { minute, hour, dom: '*', month: '*', dow: '*' };
  if (preset === 'week') return { minute, hour, dom: '*', month: '*', dow: document.getElementById('cron-dow-sel').value };
  if (preset === 'month') return { minute, hour, dom: document.getElementById('cron-dom-num').value, month: '*', dow: '*' };
  return { minute: '*', hour: '*', dom: '*', month: '*', dow: '*' };
}

function cronResetForm() {
  document.getElementById('cron-id').value = '';
  document.getElementById('cron-name').value = '';
  document.getElementById('cron-command').value = '';
  document.getElementById('cron-preset').value = 'day';
  document.getElementById('cron-time').value = '03:00';
  document.getElementById('cron-form-title').innerHTML = '<i class="ti ti-plus"></i> Nueva tarea';
  cronPresetChange();
}

function cronStartNew() {
  cronResetForm();
  document.getElementById('cron-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.getElementById('cron-name')?.focus();
}

function cronUpdateMetrics() {
  const active = cronJobs.filter(job => job.enabled).length;
  const logs = cronJobs.filter(job => job.log_exists).length;
  document.getElementById('cron-stat-total').textContent = String(cronJobs.length);
  document.getElementById('cron-stat-active').textContent = String(active);
  document.getElementById('cron-stat-inactive').textContent = String(cronJobs.length - active);
  document.getElementById('cron-stat-logs').textContent = String(logs);
}

function cronHumanSchedule(job) {
  const expression = [job.minute, job.hour, job.dom, job.month, job.dow].join(' ');
  if (expression === '* * * * *') return 'Cada minuto';
  if (expression === '0 * * * *') return 'Cada hora';
  if (job.dom === '*' && job.month === '*' && job.dow === '*') return 'Cada día · ' + String(job.hour).padStart(2, '0') + ':' + String(job.minute).padStart(2, '0');
  if (job.dom === '*' && job.month === '*' && job.dow !== '*') return 'Semanal · ' + expression;
  if (job.dom !== '*' && job.month === '*') return 'Mensual · día ' + job.dom + ' · ' + String(job.hour).padStart(2, '0') + ':' + String(job.minute).padStart(2, '0');
  return expression;
}

function cronFilterJobs() {
  const query = (document.getElementById('cron-search')?.value || '').trim().toLowerCase();
  const status = document.getElementById('cron-status-filter')?.value || 'all';
  const filtered = cronJobs.filter(job => {
    const matchesQuery = !query || String(job.name).toLowerCase().includes(query) || String(job.command).toLowerCase().includes(query);
    const matchesStatus = status === 'all' || (status === 'active' && job.enabled) || (status === 'inactive' && !job.enabled);
    return matchesQuery && matchesStatus;
  });
  const list = document.getElementById('cron-list');
  if (!filtered.length) {
    list.innerHTML = '<div class="cron-empty"><i class="ti ti-search-off"></i><strong>No hay tareas que coincidan</strong><span>Prueba otro término o crea una tarea nueva.</span></div>';
    return;
  }
  list.innerHTML = '<div class="cron-job-list">' + filtered.map(job => {
    const schedule = cronHumanSchedule(job);
    const statusClass = job.enabled ? 'cron-status-active' : 'cron-status-inactive';
    const logInfo = job.log_exists ? 'Salida: ' + fmtBytes(job.log_size || 0) : 'Sin salida todavía';
    return '<article class="cron-job-item"><div class="cron-job-main"><div class="cron-job-title"><span class="cron-status-dot ' + statusClass + '"></span><strong>' + esc(job.name) + '</strong><span class="cron-status-label ' + statusClass + '">' + (job.enabled ? 'Activa' : 'Inactiva') + '</span></div><div class="cron-job-command"><i class="ti ti-terminal-2"></i><code>' + esc(job.command) + '</code></div><div class="cron-job-meta"><span><i class="ti ti-calendar-event"></i>' + esc(schedule) + '</span><span><i class="ti ti-file-text"></i>' + esc(logInfo) + '</span></div></div><div class="cron-job-actions"><button class="btn btn-sm btn-primary" data-cron-run onclick="cronRunNow(' + job.id + ')" title="Ejecutar ahora"><i class="ti ti-player-play"></i><span>Ejecutar</span></button><button class="btn btn-sm" onclick="cronEdit(' + job.id + ')" title="Editar tarea"><i class="ti ti-edit"></i></button><button class="btn btn-sm" onclick="cronToggle(' + job.id + ')" title="Activar o desactivar"><i class="ti ti-power"></i></button><button class="btn btn-sm" onclick="cronViewLog(' + job.id + ')" title="Ver log"><i class="ti ti-file-text"></i></button><button class="btn btn-sm btn-danger" onclick="cronDelete(' + job.id + ')" title="Eliminar tarea"><i class="ti ti-trash"></i></button></div></article>';
  }).join('') + '</div>';
}

async function loadCron() {
  cronPresetChange();
  const data = await req('GET', '/cron');
  if (!data) return;
  cronJobs = Array.isArray(data.jobs) ? data.jobs : [];
  window._cronJobs = cronJobs;
  cronUpdateMetrics();
  cronFilterJobs();
}

async function cronSave() {
  const id = document.getElementById('cron-id').value;
  const body = { name: document.getElementById('cron-name').value.trim(), command: document.getElementById('cron-command').value, ...cronScheduleFromForm() };
  if (!body.name || !body.command.trim()) { toast('Nombre y comando son obligatorios', 'error'); return; }
  const response = id ? await req('PUT', '/cron/' + id, body) : await req('POST', '/cron', body);
  if (response?.error) { toast(response.error, 'error'); return; }
  toast(id ? 'Tarea actualizada' : 'Tarea creada', 'success');
  cronResetForm();
  await loadCron();
}

function cronEdit(id) {
  const job = cronJobs.find(item => item.id === id);
  if (!job) return;
  document.getElementById('cron-id').value = job.id;
  document.getElementById('cron-name').value = job.name;
  document.getElementById('cron-command').value = job.command;
  document.getElementById('cron-preset').value = 'custom';
  cronPresetChange();
  document.getElementById('cron-f-min').value = job.minute;
  document.getElementById('cron-f-hour').value = job.hour;
  document.getElementById('cron-f-dom').value = job.dom;
  document.getElementById('cron-f-month').value = job.month;
  document.getElementById('cron-f-dow').value = job.dow;
  document.getElementById('cron-form-title').innerHTML = '<i class="ti ti-edit"></i> Editar tarea';
  document.getElementById('cron-editor')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.getElementById('cron-name')?.focus();
}

async function cronToggle(id) {
  const response = await req('POST', '/cron/' + id + '/toggle');
  if (response?.error) toast(response.error, 'error');
  else toast(response?.enabled ? 'Tarea activada' : 'Tarea pausada', 'success');
  loadCron();
}

async function cronDelete(id) {
  if (!confirm('¿Borrar esta tarea programada y su log?')) return;
  const response = await req('DELETE', '/cron/' + id);
  if (response?.error) toast(response.error, 'error');
  else toast('Tarea eliminada', 'success');
  loadCron();
}

async function cronViewLog(id) {
  const job = cronJobs.find(item => item.id === id);
  const response = await req('GET', '/cron/' + id + '/log');
  if (!response) return;
  document.getElementById('cron-log-card').style.display = 'block';
  document.getElementById('cron-log-meta').textContent = job ? job.name + ' · últimas 300 líneas' : 'Últimas 300 líneas';
  document.getElementById('cron-log-output').textContent = response.log || '(sin salida registrada todavía)';
  document.getElementById('cron-log-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function cronCloseLog() { document.getElementById('cron-log-card').style.display = 'none'; }
function cronCloseRun() { document.getElementById('cron-run-card').style.display = 'none'; }

// Cerrojo de reentrada: la consola de ejecución es única, así que solo una
// ejecución manual a la vez. Se comprueba de forma síncrona antes del await.
let cronRunBusy = false;
function setCronRunLock(on) {
  document.querySelectorAll('[data-cron-run]').forEach((el) => { el.disabled = on; });
}

async function cronRunNow(id) {
  if (cronRunBusy) { toast('Ya hay una ejecución manual en curso', 'info'); return; }
  const job = cronJobs.find(item => item.id === id);
  if (!job || !confirm('¿Ejecutar ahora la tarea "' + job.name + '"?')) return;
  cronRunBusy = true;
  setCronRunLock(true);
  try {
    const consoleEl = document.getElementById('cron-run-console');
    document.getElementById('cron-run-card').style.display = 'block';
    consoleEl.textContent = 'Iniciando ejecución…\n';
    document.getElementById('cron-run-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    const code = await streamConsole('/cron/' + id + '/run', {}, consoleEl);
    toast(code === 0 ? 'Ejecución manual finalizada' : 'La tarea terminó con errores (código ' + code + ')', code === 0 ? 'success' : 'error');
  } finally {
    cronRunBusy = false;
    setCronRunLock(false);
  }
  loadCron();
}

Object.assign(window, {
  cronCloseLog, cronCloseRun, cronDelete, cronEdit, cronFilterJobs, cronPresetChange, cronResetForm, cronRunNow, cronSave, cronScheduleFromForm, cronStartNew, cronToggle, cronViewLog, loadCron,
});
