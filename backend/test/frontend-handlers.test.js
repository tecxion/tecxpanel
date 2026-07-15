// Test de red de seguridad para el split de frontend/js/app.js:
// (a) todo handler inline (onclick=, onchange=, ...) usado en las vistas o en
//     templates JS debe estar definido en algún fichero de frontend/js/
// (b) ninguna función puede estar definida más de una vez en el conjunto
//     (detecta bloques movidos sin borrar el original, o borrados sin mover)
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '..', '..', 'frontend');

function walk(dir, ext) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p, ext));
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

// Nombres que pueden aparecer invocados en un handler pero no son funciones nuestras
const BUILTINS = new Set(['event', 'this', 'window', 'document', 'alert', 'confirm', 'prompt']);

// Extrae nombres de función invocados dentro de atributos on*="..."
function handlerCalls(text) {
  const names = new Set();
  const attrRe = /\bon(?:click|change|input|submit|keyup|keydown|blur|load)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = attrRe.exec(text))) {
    const body = m[1];
    const callRe = /(^|[^\w$.])([a-zA-Z_$][\w$]*)\s*\(/g;
    let c;
    while ((c = callRe.exec(body))) {
      const name = c[2];
      if (!BUILTINS.has(name)) names.add(name);
    }
  }
  return names;
}

// Extrae nombres de función definidos a nivel superior en un fichero JS
function definedFunctions(text) {
  const names = [];
  const declRe = /^(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)/gm;
  const arrowRe = /^(?:const|let)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s*)?\(/gm;
  let m;
  while ((m = declRe.exec(text))) names.push(m[1]);
  while ((m = arrowRe.exec(text))) names.push(m[1]);
  return names;
}

test('handlers inline: definidos exactamente una vez en frontend/js/', () => {
  const htmlFiles = [
    path.join(FRONTEND, 'index.html'),
    ...walk(path.join(FRONTEND, 'views'), '.html'),
  ];
  const jsFiles = walk(path.join(FRONTEND, 'js'), '.js');

  // Handlers usados: en HTML estático y en templates dentro del propio JS
  const used = new Set();
  for (const f of [...htmlFiles, ...jsFiles]) {
    for (const n of handlerCalls(fs.readFileSync(f, 'utf8'))) used.add(n);
  }

  // Definiciones: conteo global por nombre en todos los JS del frontend
  const defCount = new Map();
  for (const f of jsFiles) {
    for (const n of definedFunctions(fs.readFileSync(f, 'utf8'))) {
      defCount.set(n, (defCount.get(n) || 0) + 1);
    }
  }

  const missing = [...used].filter((n) => !defCount.has(n));
  assert.deepStrictEqual(missing, [], `Handlers sin definición: ${missing.join(', ')}`);

  const dupes = [...defCount].filter(([, c]) => c > 1).map(([n]) => n);
  assert.deepStrictEqual(dupes, [], `Funciones definidas más de una vez: ${dupes.join(', ')}`);
});
