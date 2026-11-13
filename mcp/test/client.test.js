// ============================================================
//  Tests de mcp/client.js — cliente HTTPS del panel (con fetch falso).
//  Comprueba cabecera Bearer, recorte de respuestas, mensajes de error en
//  español y validación de url/token al construir.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, MAX_CHARS } from '../client.js';

const URL_OK = 'https://p.test';
const TOKEN = 'txpl_x';
const resp = (status, body, type = 'application/json') =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': type } });

test('envía Authorization Bearer y la URL completa', async () => {
  let seen;
  const c = createClient({ url: URL_OK, token: TOKEN, fetchImpl: async (u, o) => { seen = { u, o }; return resp(200, { a: 1 }); } });
  const out = await c.call('GET', '/api/apps');
  assert.equal(seen.u, 'https://p.test/api/apps');
  assert.equal(seen.o.method, 'GET');
  assert.equal(seen.o.headers.Authorization, 'Bearer txpl_x');
  assert.equal(out, JSON.stringify({ a: 1 }, null, 2));
});

test('devuelve texto plano tal cual', async () => {
  const c = createClient({ url: URL_OK, token: TOKEN, fetchImpl: async () => resp(200, 'hola', 'text/plain') });
  assert.equal(await c.call('GET', '/x'), 'hola');
});

test('recorta cuerpos enormes y termina en …[recortado]', async () => {
  const c = createClient({ url: URL_OK, token: TOKEN, fetchImpl: async () => resp(200, 'a'.repeat(50000), 'text/plain') });
  const out = await c.call('GET', '/x');
  assert.ok(out.endsWith('\n…[recortado]'));
  assert.ok(out.length <= MAX_CHARS + '\n…[recortado]'.length);
});

test('401 -> Token inválido o caducado', async () => {
  const c = createClient({ url: URL_OK, token: TOKEN, fetchImpl: async () => resp(401, { error: 'No autorizado' }) });
  await assert.rejects(c.call('GET', '/x'), { message: 'Token inválido o caducado' });
});

test('403 -> sin permiso', async () => {
  const c = createClient({ url: URL_OK, token: TOKEN, fetchImpl: async () => resp(403, { error: 'x' }) });
  await assert.rejects(c.call('GET', '/x'), { message: 'El token no tiene permiso para esta operación' });
});

test('otros errores incluyen estado y mensaje del panel', async () => {
  const c = createClient({ url: URL_OK, token: TOKEN, fetchImpl: async () => resp(404, { error: 'No encontrado' }) });
  await assert.rejects(c.call('GET', '/x'), { message: 'Error 404: No encontrado' });
});

test('fallo de red -> No se pudo conectar con el panel (sin filtrar token ni URL)', async () => {
  const c = createClient({ url: URL_OK, token: TOKEN, fetchImpl: async () => { throw new Error('boom https://p.test txpl_x'); } });
  await assert.rejects(c.call('GET', '/x'), (e) => {
    assert.equal(e.message, 'No se pudo conectar con el panel');
    return true;
  });
});

test('cuerpo cortado con 200 -> No se pudo leer la respuesta del panel (no éxito vacío)', async () => {
  const c = createClient({ url: URL_OK, token: TOKEN, fetchImpl: async () => ({ status: 200, ok: true, text: async () => { throw new Error('cortado'); } }) });
  await assert.rejects(c.call('GET', '/x'), { message: 'No se pudo leer la respuesta del panel' });
});

test('valida url y token al construir', () => {
  assert.throws(() => createClient({ url: 'http://panel.ejemplo.com', token: TOKEN }));
  assert.throws(() => createClient({ url: undefined, token: TOKEN }));
  assert.doesNotThrow(() => createClient({ url: 'http://localhost:8585', token: TOKEN }));
  assert.doesNotThrow(() => createClient({ url: 'http://127.0.0.1:8585', token: TOKEN }));
  assert.throws(() => createClient({ url: URL_OK, token: 'abc' }));
  assert.throws(() => createClient({ url: URL_OK, token: undefined }));
});

test('los errores de construcción no incluyen el token', () => {
  try { createClient({ url: 'http://malo.example', token: 'txpl_secreto' }); } catch (e) { assert.ok(!e.message.includes('txpl_secreto')); }
});
