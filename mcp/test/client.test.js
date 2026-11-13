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

test('tiempo agotado (TimeoutError/AbortError, al pedir o al leer) -> mensaje claro', async () => {
  const MSG = 'Tiempo de espera agotado: la operación puede seguir ejecutándose en el panel';
  const err = (name) => Object.assign(new Error('x txpl_x'), { name });
  for (const name of ['TimeoutError', 'AbortError']) {
    const alPedir = createClient({ url: URL_OK, token: TOKEN, fetchImpl: async () => { throw err(name); } });
    await assert.rejects(alPedir.call('POST', '/api/backups', { kind: 'full' }), { message: MSG });
    const alLeer = createClient({ url: URL_OK, token: TOKEN, fetchImpl: async () => ({ status: 200, ok: true, text: async () => { throw err(name); } }) });
    await assert.rejects(alLeer.call('POST', '/api/backups', { kind: 'full' }), { message: MSG });
  }
});

test('cuerpo cortado con 200 -> No se pudo leer la respuesta del panel (no éxito vacío)', async () => {
  const c = createClient({ url: URL_OK, token: TOKEN, fetchImpl: async () => ({ status: 200, ok: true, text: async () => { throw new Error('cortado'); } }) });
  await assert.rejects(c.call('GET', '/x'), { message: 'No se pudo leer la respuesta del panel' });
});

test('204 sin cuerpo -> texto vacío', async () => {
  const c = createClient({ url: URL_OK, token: TOKEN, fetchImpl: async () => new Response(null, { status: 204 }) });
  assert.equal(await c.call('DELETE', '/api/x/1'), '');
});

test('no sigue redirecciones (redirect: error)', async () => {
  let seen;
  const c = createClient({ url: URL_OK, token: TOKEN, fetchImpl: async (u, o) => { seen = o; return resp(200, {}); } });
  await c.call('POST', '/api/backups', { kind: 'full' });
  assert.equal(seen.redirect, 'error');
});

test('valida url y token al construir', () => {
  assert.throws(() => createClient({ url: 'http://panel.ejemplo.com', token: TOKEN }));
  assert.throws(() => createClient({ url: undefined, token: TOKEN }));
  assert.doesNotThrow(() => createClient({ url: 'http://localhost:8585', token: TOKEN }));
  assert.doesNotThrow(() => createClient({ url: 'http://127.0.0.1:8585', token: TOKEN }));
  assert.throws(() => createClient({ url: URL_OK, token: 'abc' }));
  assert.throws(() => createClient({ url: URL_OK, token: undefined }));
});

test('POST envía JSON con Content-Type y GET no lleva cuerpo', async () => {
  const seen = [];
  const c = createClient({ url: URL_OK, token: TOKEN, fetchImpl: async (u, o) => { seen.push(o); return resp(200, { ok: true }); } });
  await c.call('POST', '/api/system/exec', { command: 'echo hola' });
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(seen[0].body), { command: 'echo hola' });
  await c.call('POST', '/api/apps/1/restart');
  assert.equal(seen[1].body, '{}');
  await c.call('GET', '/api/apps');
  assert.equal(seen[2].body, undefined);
  assert.equal(seen[2].headers['Content-Type'], undefined);
});

test('streaming: quita el centinela __TXPL_DONE__0', async () => {
  const c = createClient({ url: URL_OK, token: TOKEN, fetchImpl: async () => resp(200, 'línea\n__TXPL_DONE__0', 'text/plain') });
  assert.equal(await c.call('POST', '/api/ssl/a.com/renew'), 'línea');
});

test('streaming: centinela con código ≠ 0 -> La operación terminó con error (con la salida)', async () => {
  const c = createClient({ url: URL_OK, token: TOKEN, fetchImpl: async () => resp(200, 'fallo\n__TXPL_DONE__1', 'text/plain') });
  await assert.rejects(c.call('POST', '/api/ssl/a.com/renew'), (e) => {
    assert.match(e.message, /^La operación terminó con error/);
    assert.ok(e.message.includes('fallo'));
    assert.ok(!e.message.includes('__TXPL_DONE__'));
    return true;
  });
});

test('los errores de construcción no incluyen el token', () => {
  try { createClient({ url: 'http://malo.example', token: 'txpl_secreto' }); } catch (e) { assert.ok(!e.message.includes('txpl_secreto')); }
});
