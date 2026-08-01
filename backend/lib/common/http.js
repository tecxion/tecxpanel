'use strict';

// ============================================================
//  TecXPaneL — common/http.js (respuestas HTTP)
//
//  Helpers de respuesta al cliente y captura de errores
//  async con inversion de control (wrap).
//  Extraído de lib/helpers.js v1 (sin cambios de comportamiento).
// ============================================================

const ok = (res, data = { success: true }) => res.json(data);

const fail = (res, code, msg) => res.status(code).json({ error: msg });

const clientIp = (req) => req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip;

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error(`[api] ${req.method} ${req.path}:`, e.message);
  if (!res.headersSent) {
    if (e.http) fail(res, e.http, e.message);
    else fail(res, 500, 'Error interno del servidor');
  }
});

module.exports = { ok, fail, clientIp, wrap };