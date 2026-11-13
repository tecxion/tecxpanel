'use strict';

// ============================================================
//  TecXPaneL — system — ejecución de un comando de shell con tope
//
//  runShell() lanza `bash -lc <command>` y devuelve { ok, code, output }
//  sin lanzar nunca. Lo usa POST /api/system/exec (tokens `admin`).
//
//  Por qué no runSafe(): runSafe no devuelve el código de salida, aborta
//  al superar maxBuffer conservando el PRINCIPIO de la salida (aquí
//  interesa el final) y, al vencer el timeout, solo mata al `bash` padre,
//  dejando huérfanos a sus hijos. Aquí:
//    - el proceso va en su propio grupo (detached) y el timeout hace
//      kill(-pid, SIGKILL): muere todo el árbol;
//    - stdout y stderr se mezclan en orden de llegada y solo se
//      conservan los ÚLTIMOS `tailBytes` bytes (sin límite de memoria);
//    - la salida se decodifica como UTF-8 (bytes inválidos → U+FFFD),
//      así el JSON de la respuesta es siempre válido.
//  El comando es un único argumento de bash (execFile-style, sin
//  interpolar en ninguna cadena del panel).
// ============================================================

const { spawn } = require('child_process');

const TAIL_BYTES = 64 * 1024;
const TRUNCATED_MARK = '[…recortado…]\n';

function runShell(command, { cwd, timeoutMs, tailBytes = TAIL_BYTES }) {
  return new Promise((resolve) => {
    let tail = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let done = false;

    const child = spawn('bash', ['-lc', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });

    const finish = (res) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(res);
    };
    const collect = (chunk) => {
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > tailBytes) { truncated = true; tail = tail.subarray(tail.length - tailBytes); }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    // Grupo de procesos entero (pid negativo): bash y todo lo que haya lanzado.
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { /* ya terminó */ }
    }, timeoutMs);

    child.on('error', (err) => finish({ ok: false, code: null, output: err.message }));
    child.on('close', (code) => {
      // Si el comando terminó solo pero dejó procesos en segundo plano, no los dejamos huérfanos.
      try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { /* grupo ya vacío */ }
      const text = (truncated ? TRUNCATED_MARK : '') + tail.toString('utf8');
      finish({ ok: !timedOut && code === 0, code: timedOut ? null : code, output: text });
    });
  });
}

module.exports = { runShell, TAIL_BYTES };
