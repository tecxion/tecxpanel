'use strict';

// ============================================================
//  TecXPaneL — common — streaming de respuestas largas
//
//  Patrón centinela __TXPL_DONE__<código> usado por 8 routers
//  (plugins, n8n, mail, dns, ssl, backups, catalog, docker).
//  Ayuda estandarizada: streamStart / streamWrite / streamEnd.
//
//  El frontend también espera este centinela para detener el
//  spinner y saber si falló (código != 0).
// ============================================================

const DONE_MARKER = '__TXPL_DONE__';

// Configura la response para streaming de texto plano.
// Llama a res.flushHeaders() para que el frontend empiece a
// recibir chunks sin esperar a que el handler termine.
function streamStart(res) {
  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  return res;
}

// Escribe un chunk de texto.
// Soporta tanto strings como buffers. Si es string añade '\n'
// automáticamente para separarlo del siguiente chunk.
function streamWrite(res, chunk) {
  const lines = Array.isArray(chunk) ? chunk.join('\n') : String(chunk);
  res.write(lines + '\n');
}

// Finaliza el stream con el centinela __TXPL_DONE__<code>.
// El frontend usa este string para saber que la operación acabó
// y si fue éxito (code=0) o error (code!=0).
function streamEnd(res, code = 0) {
  res.end(`\n${DONE_MARKER}${code}`);
}

module.exports = { streamStart, streamWrite, streamEnd, DONE_MARKER };