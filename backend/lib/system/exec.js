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

const FALLO = 'No se pudo ejecutar el comando'; // sin rutas ni detalles internos

function runShell(command, { cwd, timeoutMs, tailBytes = TAIL_BYTES }) {
  return new Promise((resolve) => {
    let tail = Buffer.alloc(0);
    let truncated = false;
    let timedOut = false;
    let done = false;
    let timer;

    // Resultado final; el TOTAL (aviso incluido) nunca supera tailBytes caracteres.
    const finish = (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      let text = tail.toString('utf8');
      if (truncated) text = TRUNCATED_MARK + text.slice(-(tailBytes - TRUNCATED_MARK.length));
      resolve({ ok: !timedOut && code === 0, code: timedOut ? null : code, output: text });
    };
    const fail = () => { if (!done) { done = true; clearTimeout(timer); resolve({ ok: false, code: null, output: FALLO }); } };

    // spawn lanza síncrono con argumentos inválidos (p. ej. NUL en el comando) o si el cwd dejó de ser un directorio.
    let child;
    try {
      child = spawn('bash', ['-lc', command], { cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (_) { return fail(); }

    const collect = (chunk) => {
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > tailBytes) { truncated = true; tail = tail.subarray(tail.length - tailBytes); }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    // Grupo de procesos entero (pid negativo): bash y todo lo que haya lanzado.
    // Un nieto con `setsid` escapa del grupo y puede retener las tuberías, y `close`
    // no llegaría: por eso se destruyen y se responde sin esperar a `close`.
    timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { /* ya terminó */ }
      child.stdout.destroy();
      child.stderr.destroy();
      finish(null);
    }, timeoutMs);

    child.on('error', fail);
    child.on('close', (code) => {
      // Si el comando terminó solo pero dejó procesos en segundo plano, no los dejamos huérfanos.
      try { process.kill(-child.pid, 'SIGKILL'); } catch (_) { /* grupo ya vacío */ }
      finish(code);
    });
  });
}

module.exports = { runShell, TAIL_BYTES };
