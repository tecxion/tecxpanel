const { test } = require('node:test');
const assert = require('node:assert');
const n8n = require('../lib/n8n');

test('n8n exporta los helpers y constantes esperados', () => {
  for (const fn of ['buildN8nContainerConfig', 'buildPullPath', 'n8nApi', 'computeN8nStatus']) {
    assert.strictEqual(typeof n8n[fn], 'function', `falta ${fn}`);
  }
  assert.strictEqual(n8n.N8N_CONTAINER, 'txpl-n8n');
  assert.strictEqual(n8n.N8N_VOLUME, 'n8n_data');
  assert.strictEqual(n8n.N8N_IMAGE, 'n8nio/n8n');
  assert.strictEqual(n8n.N8N_TAG, 'latest');
  assert.strictEqual(n8n.N8N_PORT, 5678);
});

test('buildPullPath: incluye SIEMPRE el tag (no descarga todas las etiquetas)', () => {
  const p = n8n.buildPullPath('n8nio/n8n', 'latest');
  assert.match(p, /^\/images\/create\?fromImage=/);
  assert.match(p, /[?&]tag=latest(?:&|$)/);
  // Regresión del bug: la ruta NUNCA puede quedar sin parámetro tag.
  assert.ok(/[?&]tag=/.test(p), 'la ruta de pull debe llevar tag');
});

test('buildLocalApiBase: siempre loopback (127.0.0.1) con el puerto host', () => {
  assert.strictEqual(n8n.buildLocalApiBase(5678), 'http://127.0.0.1:5678');
  assert.strictEqual(n8n.buildLocalApiBase(9000), 'http://127.0.0.1:9000');
  // Sin puerto cae al 5678 por defecto.
  assert.strictEqual(n8n.buildLocalApiBase(), 'http://127.0.0.1:5678');
});

test('buildN8nContainerConfig: sin dominio => http, cookie insegura, puerto host', () => {
  const c = n8n.buildN8nContainerConfig({ hostPort: 5678, domain: null, timezone: 'Europe/Madrid' });
  assert.strictEqual(c.Image, 'n8nio/n8n:latest');
  assert.deepStrictEqual(c.HostConfig.RestartPolicy, { Name: 'unless-stopped' });
  assert.deepStrictEqual(c.HostConfig.Binds, ['n8n_data:/home/node/.n8n']);
  assert.deepStrictEqual(c.HostConfig.PortBindings, { '5678/tcp': [{ HostPort: '5678' }] });
  assert.deepStrictEqual(c.ExposedPorts, { '5678/tcp': {} });
  assert.ok(c.Env.includes('N8N_PROTOCOL=http'));
  assert.ok(c.Env.includes('N8N_SECURE_COOKIE=false'));
  assert.ok(c.Env.includes('GENERIC_TIMEZONE=Europe/Madrid'));
  assert.ok(c.Env.some((e) => e.startsWith('WEBHOOK_URL=http://localhost:5678')));
});

test('buildN8nContainerConfig: con dominio => https y cookie segura', () => {
  const c = n8n.buildN8nContainerConfig({ hostPort: 5678, domain: 'n8n.midominio.com' });
  assert.ok(c.Env.includes('N8N_HOST=n8n.midominio.com'));
  assert.ok(c.Env.includes('N8N_PROTOCOL=https'));
  assert.ok(c.Env.includes('N8N_SECURE_COOKIE=true'));
  assert.ok(c.Env.some((e) => e === 'WEBHOOK_URL=https://n8n.midominio.com/'));
});

test('computeN8nStatus: transiciones de estado', () => {
  assert.strictEqual(n8n.computeN8nStatus({ containerExists: false, running: false, hasApiKey: false }).state, 'not_installed');
  assert.strictEqual(n8n.computeN8nStatus({ containerExists: true, running: false, hasApiKey: true }).state, 'stopped');
  assert.strictEqual(n8n.computeN8nStatus({ containerExists: true, running: true, hasApiKey: false }).state, 'needs_config');
  const ready = n8n.computeN8nStatus({ containerExists: true, running: true, hasApiKey: true });
  assert.strictEqual(ready.state, 'ready');
  assert.deepStrictEqual(ready, { state: 'ready', installed: true, running: true, configured: true });
});

test('n8nApi: construye URL y cabecera X-N8N-API-KEY, parsea JSON', async () => {
  let captured = null;
  const fakeFetch = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ id: '1' }] }) };
  };
  const out = await n8n.n8nApi('https://n8n.test/', 'KEY123', 'GET', '/api/v1/workflows?limit=1', null, fakeFetch);
  assert.strictEqual(captured.url, 'https://n8n.test/api/v1/workflows?limit=1');
  assert.strictEqual(captured.opts.headers['X-N8N-API-KEY'], 'KEY123');
  assert.deepStrictEqual(out, { data: [{ id: '1' }] });
});

test('n8nApi: respuesta no-2xx lanza Error con .status', async () => {
  const fakeFetch = async () => ({ ok: false, status: 401, text: async () => JSON.stringify({ message: 'unauthorized' }) });
  await assert.rejects(
    () => n8n.n8nApi('https://n8n.test', 'BAD', 'GET', '/api/v1/workflows', null, fakeFetch),
    (e) => e.status === 401 && /401/.test(e.message)
  );
});

test('accumulatePullProgress: dos capas descargando => pct combinado', () => {
  const state = { layers: {} };
  n8n.accumulatePullProgress(state, { status: 'Downloading', id: 'a', progressDetail: { current: 50, total: 100 } });
  const p = n8n.accumulatePullProgress(state, { status: 'Downloading', id: 'b', progressDetail: { current: 0, total: 100 } });
  // (50 + 0) / (100 + 100) = 25%
  assert.strictEqual(p.pct, 25);
  assert.strictEqual(p.phase, 'descarga');
  assert.strictEqual(p.error, null);
});

test('accumulatePullProgress: actualizar una capa recalcula el total combinado', () => {
  const state = { layers: {} };
  n8n.accumulatePullProgress(state, { status: 'Downloading', id: 'a', progressDetail: { current: 50, total: 100 } });
  n8n.accumulatePullProgress(state, { status: 'Downloading', id: 'b', progressDetail: { current: 0, total: 100 } });
  const p = n8n.accumulatePullProgress(state, { status: 'Downloading', id: 'b', progressDetail: { current: 100, total: 100 } });
  // (50 + 100) / 200 = 75%
  assert.strictEqual(p.pct, 75);
});

test('accumulatePullProgress: evento Extracting => fase extracción', () => {
  const state = { layers: { a: { current: 100, total: 100 } } };
  const p = n8n.accumulatePullProgress(state, { status: 'Extracting', id: 'a', progressDetail: { current: 10, total: 100 } });
  assert.strictEqual(p.phase, 'extracción');
});

test('accumulatePullProgress: evento con error lo propaga', () => {
  const state = { layers: {} };
  const p = n8n.accumulatePullProgress(state, { error: 'toomanyrequests: rate limit' });
  assert.strictEqual(p.error, 'toomanyrequests: rate limit');
});

test('accumulatePullProgress: sin totales => pct 0, nunca > 100', () => {
  const state = { layers: {} };
  const p0 = n8n.accumulatePullProgress(state, { status: 'Pulling fs layer', id: 'a' });
  assert.strictEqual(p0.pct, 0);
  const state2 = { layers: { a: { current: 999, total: 100 } } };
  const p1 = n8n.accumulatePullProgress(state2, { status: 'Downloading', id: 'a', progressDetail: { current: 999, total: 100 } });
  assert.ok(p1.pct <= 100);
});
