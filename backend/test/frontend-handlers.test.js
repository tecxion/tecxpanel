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
const BUILTINS = new Set(['event', 'this', 'window', 'document', 'alert', 'confirm', 'prompt', 'if']);

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

// Extrae nombres definidos a nivel superior: funciones, arrow-functions y
// bindings globales (`let dbTools = {...}`, `const SSL_CAT = ...`). Todos
// comparten el mismo scope global entre <script>, así que un duplicado
// de cualquiera de ellos rompe la app (SyntaxError al parsear el segundo
// let/const, o handler colgado si es una función).
function definedTopLevel(text) {
  const names = [];
  const declRe = /^(?:async\s+)?function\s+([a-zA-Z_$][\w$]*)/gm;
  const bindingRe = /^(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=/gm;
  let m;
  while ((m = declRe.exec(text))) names.push(m[1]);
  while ((m = bindingRe.exec(text))) names.push(m[1]);
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
    for (const n of definedTopLevel(fs.readFileSync(f, 'utf8'))) {
      defCount.set(n, (defCount.get(n) || 0) + 1);
    }
  }

  const missing = [...used].filter((n) => !defCount.has(n));
  assert.deepStrictEqual(missing, [], `Handlers sin definición: ${missing.join(', ')}`);

  const dupes = [...defCount].filter(([, c]) => c > 1).map(([n]) => n);
  assert.deepStrictEqual(dupes, [], `Nombres definidos más de una vez a nivel superior: ${dupes.join(', ')}`);
});

test('palette: acciones referencian funciones, páginas y modales existentes', () => {
  const paletteSrc = fs.readFileSync(path.join(FRONTEND, 'js', 'palette.js'), 'utf8');
  const m = paletteSrc.match(/const PALETTE_ACTIONS = (\[[\s\S]*?\n\]);/);
  assert.ok(m, 'PALETTE_ACTIONS no encontrado en palette.js');
  const actions = new Function(`return ${m[1]}`)(); // array literal, sin referencias externas

  const jsFiles = walk(path.join(FRONTEND, 'js'), '.js');
  const defined = new Set();
  for (const f of jsFiles) for (const n of definedTopLevel(fs.readFileSync(f, 'utf8'))) defined.add(n);

  const htmlAll = [path.join(FRONTEND, 'index.html'), ...walk(path.join(FRONTEND, 'views'), '.html')]
    .map((f) => fs.readFileSync(f, 'utf8')).join('\n');

  for (const a of actions) {
    assert.ok(a.label && a.page, `Acción sin label/page: ${JSON.stringify(a)}`);
    assert.ok(htmlAll.includes(`id="page-${a.page}"`), `Página inexistente: ${a.page}`);
    if (a.fn) assert.ok(defined.has(a.fn), `Función inexistente en acción "${a.label}": ${a.fn}`);
    if (a.modal) assert.ok(htmlAll.includes(`id="${a.modal}"`), `Modal inexistente en acción "${a.label}": ${a.modal}`);
  }
});
