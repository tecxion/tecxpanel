// ============================================================
//  Tests de mcp/client.js — cliente HTTPS del panel (con fetch falso).
//  Comprueba cabecera Bearer, recorte de respuestas, mensajes de error en
//  español y validación de url/token al construir.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, MAX_CHARS, recortar } from '../client.js';

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

test('POST envía cuerpo JSON y Content-Type; GET no', async () => {
  let seen;
  const c = createClient({ url: URL_OK, token: TOKEN, fetchImpl: async (u, o) => { seen = o; return resp(200, { ok: true }); } });
  await c.call('POST', '/api/backups', { kind: 'full' });
  assert.equal(seen.body, '{"kind":"full"}');
  assert.equal(seen.headers['Content-Type'], 'application/json');
  await c.call('GET', '/api/apps');
  assert.equal(seen.body, undefined);
  assert.equal(seen.headers['Content-Type'], undefined);
});

test('POST sin cuerpo no envía body', async () => {
  let seen;
  const c = createClient({ url: URL_OK, token: TOKEN, fetchImpl: async (u, o) => { seen = o; return resp(200, {}); } });
  await c.call('POST', '/api/apps/1/restart');
  assert.equal(seen.body, undefined);
});

test('timeout: 30 s en GET y 120 s en el resto', async () => {
  const orig = AbortSignal.timeout;
  const vistos = [];
  AbortSignal.timeout = (ms) => { vistos.push(ms); return orig.call(AbortSignal, ms); };
  try {
    const c = createClient({ url: URL_OK, token: TOKEN, fetchImpl: async () => resp(200, {}) });
    await c.call('GET', '/x');
    await c.call('POST', '/x', {});
    assert.deepEqual(vistos, [30000, 120000]);
  } finally { AbortSignal.timeout = orig; }
});

test('streaming: centinela 0 se quita y se devuelve el texto', async () => {
  const c = createClient({ url: URL_OK, token: TOKEN, fetchImpl: async () => resp(200, 'línea\n__TXPL_DONE__0', 'text/plain') });
  assert.equal(await c.call('POST', '/api/ssl/a.com/renew'), 'línea');
});

test('streaming: centinela distinto de 0 lanza con el texto como detalle', async () => {
  const c = createClient({ url: URL_OK, token: TOKEN, fetchImpl: async () => resp(200, 'fallo\n__TXPL_DONE__1', 'text/plain') });
  await assert.rejects(c.call('POST', '/x'), (e) => {
    assert.match(e.message, /^La operación terminó con error/);
    assert.match(e.message, /fallo/);
    assert.doesNotMatch(e.message, /TXPL_DONE/);
    return true;
  });
});

test('503/504 -> El panel no respondió a tiempo', async () => {
  for (const st of [503, 504]) {
    const c = createClient({ url: URL_OK, token: TOKEN, fetchImpl: async () => resp(st, 'x', 'text/plain') });
    await assert.rejects(c.call('POST', '/x'), { message: 'El panel no respondió a tiempo' });
  }
});

test('recortar acota a MAX_CHARS y marca el corte', () => {
  assert.equal(recortar('abc'), 'abc');
  assert.ok(recortar('a'.repeat(MAX_CHARS + 5)).endsWith('\n…[recortado]'));
});

test('call() no recorta JSON correcto (lo hace quien lo formatea) pero sí el texto', async () => {
  const c = createClient({ url: URL_OK, token: TOKEN, fetchImpl: async () => resp(200, { output: 'a'.repeat(50000) }) });
  assert.ok((await c.call('POST', '/x')).length > MAX_CHARS);
});

test('TimeoutError al conectar o al leer -> mensaje de espera agotada', async () => {
  const esperado = /^Tiempo de espera agotado: la operación puede seguir en curso en el panel \(compruébalo con listar_backups\)$/;
  const te = () => Object.assign(new Error('t'), { name: 'TimeoutError' });
  const c1 = createClient({ url: URL_OK, token: TOKEN, fetchImpl: async () => { throw te(); } });
  await assert.rejects(c1.call('POST', '/x'), { message: esperado });
  const c2 = createClient({ url: URL_OK, token: TOKEN, fetchImpl: async () => ({ status: 200, ok: true, text: async () => { throw te(); } }) });
  await assert.rejects(c2.call('POST', '/x'), { message: esperado });
});

test('error de stream: el detalle es la COLA del texto (la causa) y va acotado', async () => {
  const c = createClient({ url: URL_OK, token: TOKEN, fetchImpl: async () => resp(200, 'E'.repeat(25000) + 'CAUSA\n__TXPL_DONE__1', 'text/plain') });
  await assert.rejects(c.call('POST', '/x'), (e) => {
    assert.match(e.message, /CAUSA$/);
    assert.ok(e.message.length < 2300);
    return true;
  });
});

test('502/503/504 con JSON {error} usan ese error; sin él, "no respondió a tiempo"', async () => {
  const c = createClient({ url: URL_OK, token: TOKEN, fetchImpl: async () => resp(503, { error: 'ufw no está instalado' }) });
  await assert.rejects(c.call('POST', '/x'), { message: 'Error 503: ufw no está instalado' });
  for (const st of [502, 503, 504]) {
    const c2 = createClient({ url: URL_OK, token: TOKEN, fetchImpl: async () => resp(st, '<html>gateway</html>', 'text/html') });
    await assert.rejects(c2.call('POST', '/x'), { message: 'El panel no respondió a tiempo' });
  }
});

test('POST con texto sin centinela o con código no numérico -> sin confirmación; GET de texto no se ve afectado', async () => {
  for (const body of ['hola', 'hola\n__TXPL_DONE__x']) {
    const c = createClient({ url: URL_OK, token: TOKEN, fetchImpl: async () => resp(200, body, 'text/plain') });
    await assert.rejects(c.call('POST', '/x'), { message: 'La operación terminó sin confirmación' });
  }
  const g = createClient({ url: URL_OK, token: TOKEN, fetchImpl: async () => resp(200, 'logs', 'text/plain') });
  assert.equal(await g.call('GET', '/x'), 'logs');
});
