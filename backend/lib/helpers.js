'use strict';

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const ok = (res, data = { success: true }) => res.json(data);
const fail = (res, code, msg) => res.status(code).json({ error: msg });
const clientIp = (req) => req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip;

async function run(cmd, args = [], opts = {}) {
  const { stdout } = await execFileAsync(cmd, args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, ...opts });
  return stdout;
}

async function runSafe(cmd, args = [], opts = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, ...opts });
    return { ok: true, stdout, stderr };
  } catch (e) {
    return { ok: false, stdout: e.stdout || '', stderr: e.stderr || e.message };
  }
}

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  console.error(`[api] ${req.method} ${req.path}:`, e.message);
  if (!res.headersSent) fail(res, 500, 'Error interno del servidor');
});

module.exports = { ok, fail, clientIp, run, runSafe, wrap };
