'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const { ok, fail, wrap } = require('../lib/helpers');

const router = express.Router();

function safePath(input) {
  if (typeof input !== 'string') return null;
  return path.resolve('/', input);
}

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

router.get('/read', (req, res) => {
  const target = safePath(req.query.path);
  if (!target) return fail(res, 400, 'Ruta inválida');
  if (!fs.existsSync(target)) return fail(res, 404, 'No existe');
  const stat = fs.statSync(target);
  if (stat.size > 5 * 1024 * 1024) return fail(res, 413, 'Archivo demasiado grande (máx 5 MB)');
  ok(res, { content: fs.readFileSync(target, 'utf8') });
});

router.post('/write', (req, res) => {
  const target = safePath(req.body?.path);
  if (!target) return fail(res, 400, 'Ruta inválida');
  if (typeof req.body.content !== 'string') return fail(res, 400, 'Contenido requerido');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, req.body.content);
  ok(res);
});

router.post('/mkdir', (req, res) => {
  const target = safePath(req.body?.path);
  if (!target) return fail(res, 400, 'Ruta inválida');
  fs.mkdirSync(target, { recursive: true });
  ok(res);
});

router.post('/mkfile', (req, res) => {
  const target = safePath(req.body?.path);
  if (!target) return fail(res, 400, 'Ruta inválida');
  if (fs.existsSync(target)) return fail(res, 409, 'Ya existe');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, '');
  ok(res);
});

router.delete('/', (req, res) => {
  const target = safePath(req.body?.path);
  if (!target) return fail(res, 400, 'Ruta inválida');
  if (!fs.existsSync(target)) return fail(res, 404, 'No existe');
  const stat = fs.statSync(target);
  if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
  else fs.unlinkSync(target);
  ok(res);
});

router.post('/rename', (req, res) => {
  const from = safePath(req.body?.from);
  const to = safePath(req.body?.to);
  if (!from || !to) return fail(res, 400, 'Rutas inválidas');
  if (!fs.existsSync(from)) return fail(res, 404, 'No existe el origen');
  fs.renameSync(from, to);
  ok(res);
});

module.exports = router;
