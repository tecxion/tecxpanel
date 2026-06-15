'use strict';

// ============================================================
//  TecXPaneL — Utilidades comunes (helpers)
//
//  Funciones pequeñas que se usan en casi todos los endpoints:
//  responder al cliente, ejecutar comandos del sistema de forma
//  segura y capturar errores sin que el servidor se caiga.
// ============================================================

const { execFile } = require('child_process');
const { promisify } = require('util');
// promisify convierte execFile (que usa callbacks) en una versión que
// devuelve una promesa, para poder usar async/await.
const execFileAsync = promisify(execFile);

// Responde con éxito (HTTP 200) y un cuerpo JSON. Por defecto { success: true }.
const ok = (res, data = { success: true }) => res.json(data);

// Responde con un error: un código HTTP (400, 404, 500...) y un mensaje.
const fail = (res, code, msg) => res.status(code).json({ error: msg });

// Obtiene la IP real del cliente. Si hay un proxy (nginx) delante, la IP
// verdadera viene en la cabecera "x-forwarded-for"; si no, usa req.ip.
const clientIp = (req) => req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip;

// Ejecuta un comando del sistema y devuelve su salida (stdout).
// IMPORTANTE: usamos execFile con un ARRAY de argumentos (no una cadena),
// lo que impide ataques de inyección de comandos. Si el comando falla, lanza.
//  - timeout: corta el comando a los 30 s.
//  - maxBuffer: límite de 8 MB de salida.
async function run(cmd, args = [], opts = {}) {
  const { stdout } = await execFileAsync(cmd, args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, ...opts });
  return stdout;
}

// Igual que run(), pero NO lanza si el comando falla: devuelve un objeto
// { ok, stdout, stderr }. Útil cuando queremos inspeccionar el error en vez
// de abortar (ej. "¿está instalado este programa?").
async function runSafe(cmd, args = [], opts = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, ...opts });
    return { ok: true, stdout, stderr };
  } catch (e) {
    return { ok: false, stdout: e.stdout || '', stderr: e.stderr || e.message };
  }
}

// "Envoltorio" para manejadores de rutas asíncronos. Si la función lanza un
// error, lo captura, lo registra en consola y responde con un 500 genérico
// (en vez de dejar la petición colgada o tumbar el proceso).
const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error(`[api] ${req.method} ${req.path}:`, e.message);
  if (!res.headersSent) fail(res, 500, 'Error interno del servidor');
});

module.exports = { ok, fail, clientIp, run, runSafe, wrap };
