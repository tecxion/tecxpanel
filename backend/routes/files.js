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

// Normaliza una ruta recibida del usuario. path.resolve('/', input) la convierte
// en absoluta y elimina ".." y barras dobles, evitando rutas malformadas.
// (Nota: este panel corre como root y trabaja sobre todo el sistema de archivos.)
function safePath(input) {
  if (typeof input !== 'string') return null;
  return path.resolve('/', input);
}

// GET /api/files?path=... — Lista el contenido de una carpeta.
// Devuelve cada entrada con nombre, ruta, tipo (file/directory), tamaño y fecha.
// Ordena: primero carpetas, luego archivos, alfabéticamente.
router.get('/', (req, res) => {
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
});

// GET /api/files/read?path=... — Lee el contenido de un archivo de texto
// (máx 5 MB, para no cargar binarios enormes en memoria).
router.get('/read', (req, res) => {
  const target = safePath(req.query.path);
  if (!target) return fail(res, 400, 'Ruta inválida');
  if (!fs.existsSync(target)) return fail(res, 404, 'No existe');
  const stat = fs.statSync(target);
  if (stat.size > 5 * 1024 * 1024) return fail(res, 413, 'Archivo demasiado grande (máx 5 MB)');
  ok(res, { content: fs.readFileSync(target, 'utf8') });
});

// POST /api/files/write — Escribe contenido en un archivo (lo crea si no existe).
// Si encoding es 'base64', decodifica primero (sirve para subir binarios pequeños).
router.post('/write', (req, res) => {
  const target = safePath(req.body?.path);
  if (!target) return fail(res, 400, 'Ruta inválida');
  if (typeof req.body.content !== 'string') return fail(res, 400, 'Contenido requerido');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (req.body.encoding === 'base64') {
    fs.writeFileSync(target, Buffer.from(req.body.content, 'base64'));
  } else {
    fs.writeFileSync(target, req.body.content);
  }
  ok(res);
});

// POST /api/files/mkdir — Crea una carpeta (y las intermedias que falten).
router.post('/mkdir', (req, res) => {
  const target = safePath(req.body?.path);
  if (!target) return fail(res, 400, 'Ruta inválida');
  fs.mkdirSync(target, { recursive: true });
  ok(res);
});

// POST /api/files/mkfile — Crea un archivo vacío (falla si ya existe).
router.post('/mkfile', (req, res) => {
  const target = safePath(req.body?.path);
  if (!target) return fail(res, 400, 'Ruta inválida');
  if (fs.existsSync(target)) return fail(res, 409, 'Ya existe');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '');
  ok(res);
});

// DELETE /api/files — Borra un archivo o carpeta (recursivo si es carpeta).
router.delete('/', (req, res) => {
  const target = safePath(req.body?.path);
  if (!target) return fail(res, 400, 'Ruta inválida');
  if (!fs.existsSync(target)) return fail(res, 404, 'No existe');
  const stat = fs.statSync(target);
  if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
  else fs.unlinkSync(target);
  ok(res);
});

// POST /api/files/rename — Renueva/mueve un archivo o carpeta de "from" a "to".
router.post('/rename', (req, res) => {
  const from = safePath(req.body?.from);
  const to = safePath(req.body?.to);
  if (!from || !to) return fail(res, 400, 'Rutas inválidas');
  if (!fs.existsSync(from)) return fail(res, 404, 'No existe el origen');
  fs.renameSync(from, to);
  ok(res);
});

// POST /api/files/upload?path=... — Sube un archivo por STREAMING binario:
// el cuerpo de la petición se escribe directo al disco, sin pasar por JSON ni
// base64. Así se pueden subir archivos grandes sin agotar la memoria.
// Si algo falla a mitad, "abort" borra el archivo incompleto.
router.post('/upload', (req, res) => {
  const target = safePath(req.query.path);
  if (!target) return fail(res, 400, 'Ruta inválida');
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
