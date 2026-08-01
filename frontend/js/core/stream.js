// core/stream.js — streaming de respuestas largas (__TXPL_DONE__)
export async function streamConsole(path, body, el) {
  const DONE = '__TXPL_DONE__';
  const token = localStorage.getItem('txpl_token') || '';
  const r = await fetch(window.location.origin + '/api' + path, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.status === 401) { window.doLogout?.(); return 1; }
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buffer = '', exitCode = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });
    let display = buffer;
    const idx = buffer.indexOf(DONE);
    if (idx >= 0) { exitCode = parseInt(buffer.slice(idx + DONE.length).trim(), 10) || 0; display = buffer.slice(0, idx); }
    el.textContent = display; el.scrollTop = el.scrollHeight;
  }
  return exitCode;
}