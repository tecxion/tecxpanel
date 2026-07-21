// TecXPaneL — cron (tareas programadas)
// Muestra/oculta los campos del constructor guiado según el preset elegido.
function cronPresetChange() {
  const p = document.getElementById('cron-preset').value;
  document.getElementById('cron-time-wrap').style.display = (p === 'day' || p === 'week' || p === 'month') ? '' : 'none';
  document.getElementById('cron-dow-wrap').style.display = (p === 'week') ? '' : 'none';
  document.getElementById('cron-dom-wrap').style.display = (p === 'month') ? '' : 'none';
  document.getElementById('cron-custom-wrap').style.display = (p === 'custom') ? '' : 'none';
}

// Traduce el constructor guiado a los 5 campos cron.
function cronScheduleFromForm() {
  const p = document.getElementById('cron-preset').value;
  if (p === 'custom') {
    return {
      minute: document.getElementById('cron-f-min').value.trim(),
      hour: document.getElementById('cron-f-hour').value.trim(),
      dom: document.getElementById('cron-f-dom').value.trim(),
      month: document.getElementById('cron-f-month').value.trim(),
      dow: document.getElementById('cron-f-dow').value.trim(),
    };
  }
  const [hh, mm] = (document.getElementById('cron-time').value || '03:00').split(':');
  if (p === 'minute') return { minute: '*', hour: '*', dom: '*', month: '*', dow: '*' };
  if (p === 'hour') return { minute: '0', hour: '*', dom: '*', month: '*', dow: '*' };
  if (p === 'day') return { minute: String(+mm), hour: String(+hh), dom: '*', month: '*', dow: '*' };
  if (p === 'week') return { minute: String(+mm), hour: String(+hh), dom: '*', month: '*', dow: document.getElementById('cron-dow-sel').value };
  if (p === 'month') return { minute: String(+mm), hour: String(+hh), dom: document.getElementById('cron-dom-num').value, month: '*', dow: '*' };
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

async function loadCron() {
  cronPresetChange();
  const data = await req('GET', '/cron');
  if (!data) return;
  const list = document.getElementById('cron-list');
  if (!data.jobs.length) { list.innerHTML = '<div class="empty-state">' + emptyState('clock-off', 'Sin tareas programadas — usa el formulario para crear la primera') + '</div>'; return; }
  list.innerHTML = '<div class="table-wrap"><table class="table"><thead><tr><th>Nombre</th><th>Programación</th><th>Comando</th><th>Estado</th><th></th></tr></thead><tbody>' +
    data.jobs.map((j) => `<tr>
      <td>${esc(j.name)}</td>
      <td><code>${esc(`${j.minute} ${j.hour} ${j.dom} ${j.month} ${j.dow}`)}</code></td>
      <td><code>${esc(j.command)}</code></td>
      <td>${j.enabled ? '🟢 activa' : '⚪ inactiva'}</td>
      <td>
        <button class="btn btn-sm" onclick="cronEdit(${j.id})"><i class="ti ti-edit"></i></button>
        <button class="btn btn-sm" onclick="cronToggle(${j.id})"><i class="ti ti-power"></i></button>
        <button class="btn btn-sm" onclick="cronViewLog(${j.id})"><i class="ti ti-file-text"></i></button>
        <button class="btn btn-sm btn-danger" onclick="cronDelete(${j.id})"><i class="ti ti-trash"></i></button>
      </td></tr>`).join('') + '</tbody></table></div>';
  window._cronJobs = data.jobs;
}

async function cronSave() {
  const id = document.getElementById('cron-id').value;
  const body = {
    name: document.getElementById('cron-name').value.trim(),
    command: document.getElementById('cron-command').value,
    ...cronScheduleFromForm(),
  };
  if (!body.name || !body.command.trim()) { alert('Nombre y comando son obligatorios'); return; }
  const r = id ? await req('PUT', `/cron/${id}`, body) : await req('POST', '/cron', body);
  if (r && r.error) { alert(r.error); return; }
  cronResetForm();
  loadCron();
}

function cronEdit(id) {
  const j = (window._cronJobs || []).find((x) => x.id === id);
  if (!j) return;
  document.getElementById('cron-id').value = j.id;
  document.getElementById('cron-name').value = j.name;
  document.getElementById('cron-command').value = j.command;
  document.getElementById('cron-preset').value = 'custom';
  cronPresetChange();
  document.getElementById('cron-f-min').value = j.minute;
  document.getElementById('cron-f-hour').value = j.hour;
  document.getElementById('cron-f-dom').value = j.dom;
  document.getElementById('cron-f-month').value = j.month;
  document.getElementById('cron-f-dow').value = j.dow;
  document.getElementById('cron-form-title').innerHTML = '<i class="ti ti-edit"></i> Editar tarea';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function cronToggle(id) {
  const r = await req('POST', `/cron/${id}/toggle`);
  if (r && r.error) toast(r.error, 'error');
  loadCron();
}

async function cronDelete(id) {
  if (!confirm('¿Borrar esta tarea programada?')) return;
  const r = await req('DELETE', `/cron/${id}`);
  if (r && r.error) toast(r.error, 'error');
  loadCron();
}

async function cronViewLog(id) {
  const r = await req('GET', `/cron/${id}/log`);
  if (!r) return;
  document.getElementById('cron-log-card').style.display = 'block';
  document.getElementById('cron-log-output').textContent = r.log || '(sin salida registrada todavía)';
  document.getElementById('cron-log-card').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
