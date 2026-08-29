'use strict';
// ============================================================
//  TecXPaneL — lib/apps/preflight.js
//  Comprobaciones PREVIAS al despliegue, PURAS. Reciben el resultado crudo de las
//  sondas (versión de node/npm/python, si hay pip/venv, si queda puerto libre) que
//  ejecuta el motor de deploy, y devuelven checks { id, ok, message, fix }. Matan
//  la mayoría de "errores": avisan en llano de lo que falta antes de tocar nada.
//  Sin I/O → testeable en aislamiento.
// ============================================================

// preflight({ runtime, nodeVersion, npmVersion, pythonVersion, pipOk, portFree })
//   runtime      = 'node' | 'python' | 'unknown' (de detect())
//   nodeVersion  = string o null   npmVersion = string o null
//   pythonVersion= string o null   pipOk = bool o null (venv+pip disponibles)
//   portFree     = bool o null (null = no aplica, p. ej. SPA estática)
function preflight({ runtime, nodeVersion = null, npmVersion = null, pythonVersion = null, pipOk = null, portFree = null } = {}) {
  const checks = [];

  if (runtime === 'node') {
    checks.push(nodeVersion
      ? { id: 'node', ok: true, message: `Node.js ${nodeVersion} disponible.`, fix: null }
      : { id: 'node', ok: false, message: 'Node.js no está instalado en el servidor.', fix: 'Instálalo desde Plugins (Node.js) y reintenta.' });
    checks.push(npmVersion
      ? { id: 'npm', ok: true, message: `npm ${npmVersion} disponible.`, fix: null }
      : { id: 'npm', ok: false, message: 'npm no está disponible.', fix: 'Se instala junto con Node.js (Plugins).' });
  } else if (runtime === 'python') {
    checks.push(pythonVersion
      ? { id: 'python', ok: true, message: `Python ${pythonVersion} disponible.`, fix: null }
      : { id: 'python', ok: false, message: 'Python 3 no está instalado en el servidor.', fix: 'Instálalo desde Plugins (Python) y reintenta.' });
    checks.push(pipOk
      ? { id: 'venv', ok: true, message: 'venv y pip disponibles.', fix: null }
      : { id: 'venv', ok: false, message: 'Falta el módulo venv/pip de Python.', fix: 'Instala python3-venv y python3-pip (apt) y reintenta.' });
  } else {
    checks.push({ id: 'runtime', ok: false, message: 'No se reconoció el tipo de proyecto (ni Node ni Python).', fix: 'Sube un proyecto con package.json o requirements.txt.' });
  }

  // Puerto: solo para apps con servicio (portFree null = no aplica → no se comprueba).
  if (portFree === false) {
    checks.push({ id: 'port', ok: false, message: 'No hay puertos libres para la app.', fix: 'Elimina apps que no uses o libera algún puerto.' });
  }

  return checks;
}

// ¿Se puede desplegar? = ningún check en falso.
function preflightOk(checks) {
  return (checks || []).every((c) => c.ok);
}

module.exports = { preflight, preflightOk };
