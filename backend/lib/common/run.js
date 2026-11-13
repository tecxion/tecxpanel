'use strict';

// ============================================================
//  TecXPaneL — common — ejecución segura de comandos (execFile)
//
//  run()     → devuelve stdout, lanza si falla.
//  runSafe() → devuelve { ok, stdout, stderr, code }, nunca lanza
//              (code: exit code, o null si se mató por timeout/señal).
//  runInput()→ como runSafe pero pasa datos por stdin vía spawn.
//              El CLI js/bash lo usaban/dev para restore de SQL.
//
//  IMPORTANTE: execFile con array de args (nunca string) impide
//  inyección de comandos. Sin shell involucrado.
// ============================================================

const { execFile } = require('child_process');
const { spawn } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

async function run(cmd, args = [], opts = {}) {
  const { stdout } = await execFileAsync(cmd, args, {
    timeout: 30_000,
    maxBuffer: 8 * 1024 * 1024,
    ...opts,
  });
  return stdout;
}

async function runSafe(cmd, args = [], opts = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      ...opts,
    });
    return { ok: true, stdout, stderr, code: 0 };
  } catch (e) {
    return { ok: false, stdout: e.stdout || '', stderr: e.stderr || e.message, code: typeof e.code === 'number' ? e.code : null };
  }
}

// Ejecuta un proceso y pasa data por stdin (spawn, no execFile).
// Útil para scripts que esperan entrada (ej. mysql < dump.sql) y para
// comandos que no ofrecen forma de pasar datos por argumento.
// Devuelve { ok, stdout, stderr, exitCode }.
// NOTA: execFile no soporta stdin; este helper es LA alternativa.
function runInput(cmd, args, input, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
      ...opts,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (err) => resolve({ ok: false, stdout, stderr: err.message, exitCode: 1 }));
    child.on('close', (code) => resolve({ ok: code === 0, stdout, stderr, exitCode: code }));
    // Escribe el input al stdin del hijo y lo cierra para que el proceso hijo
    // sepa que no va a recibir más datos.
    child.stdin.write(input);
    child.stdin.end();
  });
}

// Ejecuta `bash -lc command` para /api/system/exec. Diferencias con runSafe:
//  - Grupo de procesos propio (detached): al vencer el timeout se mata el
//    GRUPO entero con SIGKILL, así no quedan hijos vivos ni vale `trap '' TERM`.
//  - Sin maxBuffer: solo se guardan los últimos `tailBytes` de stdout+stderr
//    (en orden de llegada), así una salida enorme no mata el comando.
// Devuelve { ok, code, output (Buffer), timedOut }; code es null si hubo señal.
function runShellTail(command, { cwd, timeoutMs, tailBytes }) {
  return new Promise((resolve) => {
    // Entorno mínimo: el del panel lleva JWT_SECRET, ADMIN_PASS, TXPL_SECRET_KEY...
    const env = {
      PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      HOME: process.env.HOME || '/root',
      LANG: process.env.LANG || 'C.UTF-8',
    };
    const child = spawn('bash', ['-lc', command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = Buffer.alloc(0);
    let timedOut = false;
    const keep = (chunk) => {
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > tailBytes) tail = tail.subarray(-tailBytes);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { /* el grupo ya no existe */ }
      // Un proceso escapado del grupo (setsid) podría mantener los pipes abiertos.
      child.stdout.destroy();
      child.stderr.destroy();
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, output: Buffer.from(err.message), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: !timedOut && code === 0, code: timedOut ? null : code, output: tail, timedOut });
    });
  });
}

module.exports = { run, runSafe, runInput, runShellTail };