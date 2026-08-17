'use strict';

// ============================================================
//  TecXPaneL — Gestor de archivos
//
//  Explorador de archivos del servidor: navegar carpetas, leer/escribir
//  ficheros, subir (por streaming), crear, renombrar, borrar y extraer
//  comprimidos. Cada operación normaliza la ruta con safePath().
// ============================================================

const path = require('path');
const fs = require('fs');
const express = require('express');
const { ok, fail, wrap, runSafe } = require('../lib/helpers');

const router = express.Router();
const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const EDITABLE_EXTENSIONS = new Set([
  '.bash', '.cjs', '.conf', '.css', '.csv', '.env', '.gitignore', '.go', '.htm', '.html',
  '.ini', '.java', '.js', '.json', '.jsx', '.md', '.markdown', '.mjs', '.php', '.py',
  '.rb', '.rs', '.sh', '.sql', '.svg', '.svelte', '.toml', '.ts', '.tsx', '.txt', '.vue',
  '.xml', '.yaml', '.yml',
]);

// Normaliza una ruta recibida del usuario. path.resolve('/', input) la convierte
// en absoluta y elimina ".." y barras dobles, evitando rutas malformadas.
// (Nota: este panel corre como root y trabaja sobre todo el sistema de archivos.)
function safePath(input) {
  if (typeof input !== 'string' || input.includes(String.fromCharCode(0))) return null;
  return path.resolve('/', input);
}

function isRoot(target) { return target === path.parse(target).root; }

function isEditableText(target, buffer) {
  if (buffer.includes(0)) return false;
  const name = path.basename(target).toLowerCase();
  return EDITABLE_EXTENSIONS.has(path.extname(name)) || !path.extname(name);
}

function languageFor(target) {
  const ext = path.extname(target).toLowerCase();
  return ({ '.html': 'html', '.htm': 'html', '.css': 'css', '.js': 'javascript', '.mjs': 'javascript',
    '.json': 'json', '.jsonc': 'json', '.md': 'markdown', '.markdown': 'markdown', '.php': 'php',
    '.py': 'python', '.sh': 'shell', '.yaml': 'yaml', '.yml': 'yaml', '.xml': 'xml', '.svg': 'xml' })[ext] || 'text';
}

function writeAtomic(target, data, options = {}) {
  const temp = path.join(path.dirname(target), '.' + path.basename(target) + '.txpl-' + process.pid + '-' + Date.now() + '.tmp');
  const previous = fs.existsSync(target) ? fs.statSync(target) : null;
  try {
    fs.writeFileSync(temp, data, { ...options, mode: previous?.mode || 0o600 });
    if (previous && process.getuid?.() === 0) fs.chownSync(temp, previous.uid, previous.gid);
    fs.renameSync(temp, target);
  } finally {
    try { fs.unlinkSync(temp); } catch (_) {}
  }
}

// GET /api/files?path=... — Lista el contenido de una carpeta.
// Devuelve cada entrada con nombre, ruta, tipo (file/directory), tamaño y fecha.
// Ordena: primero carpetas, luego archivos, alfabéticamente.
router.get('/', wrap((req, res) => {
  const target = safePath(req.query.path || '/');
  if (!target) return fail(res, 400, 'Ruta inválida');
  if (!fs.existsSync(target)) return fail(res, 404, 'No existe');
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) return fail(res, 400, 'No es un directorio');

  const entries = fs.readdirSync(target, { withFileTypes: true });
  const items = entries.map((e) => {
    const full = path.join(target, e.name);
    let size = 0, modified = null;
    try { const st = fs.statSync(full); size = st.size; modified = st.mtime; } catch (_) {}
    return { name: e.name, path: full, type: e.isDirectory() ? 'directory' : 'file', size, modified };
  }).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1));
  ok(res, { path: target, items });
}));

// GET /api/files/read?path=... — Lee el contenido de un archivo de texto
// (máx 5 MB, para no cargar binarios enormes en memoria).
router.get('/read', wrap((req, res) => {
  const target = safePath(req.query.path);
  if (!target) return fail(res, 400, 'Ruta inválida');
  if (!fs.existsSync(target)) return fail(res, 404, 'No existe');
  const stat = fs.statSync(target);
  if (!stat.isFile()) return fail(res, 400, 'No es un archivo');
  if (stat.size > MAX_TEXT_BYTES) return fail(res, 413, 'Archivo demasiado grande (máx 5 MB)');
  const buffer = fs.readFileSync(target);
  if (!isEditableText(target, buffer)) return fail(res, 415, 'Archivo binario no editable desde el panel');
  ok(res, { content: buffer.toString('utf8'), size: stat.size, modified: stat.mtime, language: languageFor(target), editable: true });
}));

// POST /api/files/write — Escribe contenido en un archivo (lo crea si no existe).
// Si encoding es 'base64', decodifica primero (sirve para subir binarios pequeños).
router.post('/write', wrap((req, res) => {
  const target = safePath(req.body?.path);
  if (!target) return fail(res, 400, 'Ruta inválida');
  if (typeof req.body.content !== 'string') return fail(res, 400, 'Contenido requerido');
  if (isRoot(target)) return fail(res, 400, 'No se puede escribir sobre la raíz');
  if (req.body.encoding !== 'base64' && Buffer.byteLength(req.body.content, 'utf8') > MAX_TEXT_BYTES) return fail(res, 413, 'Contenido demasiado grande (máx 5 MB)');
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) return fail(res, 400, 'La ruta es una carpeta');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (req.body.encoding === 'base64') {
    const decoded = Buffer.from(req.body.content, 'base64');
    if (decoded.length > MAX_TEXT_BYTES) return fail(res, 413, 'Contenido demasiado grande (máx 5 MB)');
    writeAtomic(target, decoded);
  } else {
    writeAtomic(target, req.body.content, { encoding: 'utf8' });
  }
  ok(res);
}));

// POST /api/files/mkdir — Crea una carpeta (y las intermedias que falten).
router.post('/mkdir', wrap((req, res) => {
  const target = safePath(req.body?.path);
  if (!target) return fail(res, 400, 'Ruta inválida');
  fs.mkdirSync(target, { recursive: true });
  ok(res);
}));

// POST /api/files/mkfile — Crea un archivo vacío (falla si ya existe).
router.post('/mkfile', wrap((req, res) => {
  const target = safePath(req.body?.path);
  if (!target) return fail(res, 400, 'Ruta inválida');
  if (fs.existsSync(target)) return fail(res, 409, 'Ya existe');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '');
  ok(res);
}));

// DELETE /api/files — Borra un archivo o carpeta (recursivo si es carpeta).
router.delete('/', wrap((req, res) => {
  const target = safePath(req.body?.path);
  if (!target) return fail(res, 400, 'Ruta inválida');
  if (isRoot(target)) return fail(res, 400, 'No se puede eliminar la raíz');
  if (!fs.existsSync(target)) return fail(res, 404, 'No existe');
  const stat = fs.statSync(target);
  if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
  else fs.unlinkSync(target);
  ok(res);
}));

// POST /api/files/rename — Renueva/mueve un archivo o carpeta de "from" a "to".
router.post('/rename', wrap((req, res) => {
  const from = safePath(req.body?.from);
  const to = safePath(req.body?.to);
  if (!from || !to) return fail(res, 400, 'Rutas inválidas');
  if (isRoot(from) || isRoot(to)) return fail(res, 400, 'No se puede mover la raíz');
  if (!fs.existsSync(from)) return fail(res, 404, 'No existe el origen');
  if (fs.existsSync(to)) return fail(res, 409, 'Ya existe el destino');
  fs.renameSync(from, to);
  ok(res);
}));

// POST /api/files/upload?path=... — Sube un archivo por STREAMING binario:
// el cuerpo de la petición se escribe directo al disco, sin pasar por JSON ni
// base64. Así se pueden subir archivos grandes sin agotar la memoria.
// Si algo falla a mitad, "abort" borra el archivo incompleto.
router.post('/upload', (req, res) => {
  const target = safePath(req.query.path);
  if (!target) return fail(res, 400, 'Ruta inválida');
  if (isRoot(target)) return fail(res, 400, 'Falta el nombre del archivo');
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) return fail(res, 400, 'La ruta es una carpeta');
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
  } catch (e) {
    return fail(res, 500, 'No se pudo crear la carpeta destino');
  }
  const ws = fs.createWriteStream(target);
  let failed = false;
  const abort = (code, msg) => {
    if (failed) return;
    failed = true;
    try { ws.destroy(); } catch (_) {}
    try { fs.unlinkSync(target); } catch (_) {}
    if (!res.headersSent) fail(res, code, msg);
  };
  ws.on('error', () => abort(500, 'Error al escribir el archivo'));
  req.on('error', () => abort(400, 'Error en la transferencia'));
  ws.on('finish', () => { if (!failed && !res.headersSent) ok(res); });
  req.pipe(ws); // conecta la entrada de la petición directamente al archivo
});

// POST /api/files/extract — Descomprime un .zip/.tar.gz/.tgz/.tar en su carpeta.
// Si falta "unzip", lo instala al vuelo.
router.post('/extract', wrap(async (req, res) => {
  const target = safePath(req.body?.path);
  if (!target) return fail(res, 400, 'Ruta inválida');
  if (!fs.existsSync(target)) return fail(res, 404, 'No existe el archivo');
  if (fs.statSync(target).isDirectory()) return fail(res, 400, 'Es una carpeta, no un archivo');

  const destDir = path.dirname(target);
  const lower = target.toLowerCase();
  let r;

  if (lower.endsWith('.zip')) {
    let probe = await runSafe('unzip', ['-v']);
    if (!probe.ok) await runSafe('apt-get', ['install', '-y', 'unzip'], { timeout: 120_000 });
    r = await runSafe('unzip', ['-o', target, '-d', destDir], { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
  } else if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    r = await runSafe('tar', ['-xzf', target, '-C', destDir], { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
  } else if (lower.endsWith('.tar')) {
    r = await runSafe('tar', ['-xf', target, '-C', destDir], { timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
  } else {
    return fail(res, 400, 'Formato no soportado (usa .zip, .tar.gz o .tar)');
  }

  if (!r.ok) return fail(res, 500, r.stderr.split('\n').filter(Boolean).slice(-2).join(' ') || 'Error al extraer');
  ok(res, { success: true, extractedTo: destDir });
}));

module.exports = router;
module.exports.safePath = safePath;
module.exports.isEditableText = isEditableText;
module.exports.languageFor = languageFor;
