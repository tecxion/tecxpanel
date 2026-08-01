'use strict';

// ============================================================
//  TecXPaneL — common — ejecución segura de comandos (execFile)
//
//  run()     → devuelve stdout, lanza si falla.
//  runSafe() → devuelve { ok, stdout, stderr }, nunca lanza.
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
    return { ok: true, stdout, stderr };
  } catch (e) {
    return { ok: false, stdout: e.stdout || '', stderr: e.stderr || e.message };
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

module.exports = { run, runSafe, runInput };