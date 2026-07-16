// TecXPaneL — notifications (Telegram + SMTP, autodetección chat)

// loadNotifyConfig: rellena la tarjeta con la config guardada (sin secretos).
async function loadNotifyConfig() {
  const r = await req('GET', '/notifications/config');
  if (!r?.success || r.configured === false) return;
  document.getElementById('ntf-tg-enabled').checked = !!r.telegram_enabled;
  document.getElementById('ntf-tg-token').placeholder = r.telegram_token_set ? '•••••••• (guardado, escribe para cambiarlo)' : '123456:ABC…';
  document.getElementById('ntf-tg-chat').value = r.telegram_chat_id || '';
  document.getElementById('ntf-smtp-enabled').checked = !!r.smtp_enabled;
  document.getElementById('ntf-smtp-host').value = r.smtp_host || '';
  document.getElementById('ntf-smtp-port').value = r.smtp_port || 587;
  document.getElementById('ntf-smtp-secure').checked = !!r.smtp_secure;
  document.getElementById('ntf-smtp-user').value = r.smtp_user || '';
  document.getElementById('ntf-smtp-pass').placeholder = r.smtp_pass_set ? '•••••••• (guardada, escribe para cambiarla)' : '';
  document.getElementById('ntf-smtp-from').value = r.smtp_from || '';
  document.getElementById('ntf-smtp-to').value = r.smtp_to || '';
  document.getElementById('ntf-ev-disk').checked = !!r.ev_disk_enabled;
  document.getElementById('ntf-ev-disk-th').value = r.ev_disk_threshold || 90;
  document.getElementById('ntf-ev-services').checked = !!r.ev_services_enabled;
  document.getElementById('ntf-ev-security').checked = !!r.ev_security_enabled;
  document.getElementById('ntf-ev-ssl').checked = !!r.ev_ssl_enabled;
}

// collectNotifyForm: lee la tarjeta entera (token/contraseña vacíos = conservar).
function collectNotifyForm() {
  return {
    telegram_enabled: document.getElementById('ntf-tg-enabled').checked,
    telegram_token: document.getElementById('ntf-tg-token').value.trim(),
    telegram_chat_id: document.getElementById('ntf-tg-chat').value.trim(),
    smtp_enabled: document.getElementById('ntf-smtp-enabled').checked,
    smtp_host: document.getElementById('ntf-smtp-host').value.trim(),
    smtp_port: parseInt(document.getElementById('ntf-smtp-port').value, 10) || 587,
    smtp_secure: document.getElementById('ntf-smtp-secure').checked,
    smtp_user: document.getElementById('ntf-smtp-user').value.trim(),
    smtp_pass: document.getElementById('ntf-smtp-pass').value,
    smtp_from: document.getElementById('ntf-smtp-from').value.trim(),
    smtp_to: document.getElementById('ntf-smtp-to').value.trim(),
    ev_disk_enabled: document.getElementById('ntf-ev-disk').checked,
    ev_disk_threshold: parseInt(document.getElementById('ntf-ev-disk-th').value, 10) || 90,
    ev_services_enabled: document.getElementById('ntf-ev-services').checked,
    ev_security_enabled: document.getElementById('ntf-ev-security').checked,
    ev_ssl_enabled: document.getElementById('ntf-ev-ssl').checked,
  };
}

// syncSmtpPort: al marcar/desmarcar "TLS directa", ajusta el puerto al estándar
// que le corresponde (465 con TLS directo, 587 con STARTTLS). Respeta un puerto
// personalizado: solo autoajusta si el actual es uno de los dos estándar o está vacío.
function syncSmtpPort() {
  const secure = document.getElementById('ntf-smtp-secure').checked;
  const portEl = document.getElementById('ntf-smtp-port');
  const cur = parseInt(portEl.value, 10);
  if (!cur || cur === 587 || cur === 465) portEl.value = secure ? 465 : 587;
}

// saveNotifyConfig: guarda y limpia los campos de secretos.
async function saveNotifyConfig() {
  const r = await req('POST', '/notifications/config', collectNotifyForm());
  if (r?.success) {
    toast('Notificaciones guardadas', 'success');
    document.getElementById('ntf-tg-token').value = '';
    document.getElementById('ntf-smtp-pass').value = '';
    loadNotifyConfig();
  } else toast(r?.error || 'Error al guardar las notificaciones', 'error');
}

// testNotify: prueba de envío con lo que hay en el formulario (sin guardar).
async function testNotify(channel) {
  toast('Enviando prueba…', 'info');
  const r = await req('POST', `/notifications/test/${channel}`, collectNotifyForm());
  if (r?.success) toast('Prueba enviada, revisa ' + (channel === 'telegram' ? 'Telegram' : 'tu correo'), 'success');
  else toast(r?.error || 'La prueba falló', 'error');
}

// detectTgChat: autodetecta el chat_id (requiere /start previo en el bot).
async function detectTgChat() {
  const r = await req('POST', '/notifications/telegram/detect-chat', collectNotifyForm());
  if (r?.success && r.chatId) {
    document.getElementById('ntf-tg-chat').value = r.chatId;
    toast('Chat detectado' + (r.name ? ': ' + r.name : ''), 'success');
  } else toast(r?.error || 'No se pudo detectar el chat', 'error');
}
