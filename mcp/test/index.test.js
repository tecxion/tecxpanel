// ============================================================
//  Smoke de mcp/index.js — cliente MCP stdio real contra el servidor, con un
//  panel falso en http://localhost. Comprueba que las herramientas write/admin
//  solo aparecen con TXPL_ENABLE_WRITE/ADMIN, sus annotations, y que
//  ejecutar_comando devuelve la salida o el 403 del panel.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const INDEX = fileURLToPath(new URL('../index.js', import.meta.url));

// Panel falso: el token "txpl_admin" puede ejecutar; cualquier otro recibe 403.
const panel = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const admin = req.headers.authorization === 'Bearer txpl_admin';
    const json = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.method === 'POST' && req.url === '/api/system/exec' && admin && JSON.parse(body).command === 'echo hola') {
      return json(200, { success: true, ok: true, code: 0, output: 'hola\n' });
    }
    json(admin ? 404 : 403, { error: 'no' });
  });
});

async function conectar(env) {
  const { port } = panel.address();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [INDEX],
    env: { PATH: process.env.PATH, TXPL_URL: `http://localhost:${port}`, ...env },
    stderr: 'ignore',
  });
  const client = new Client({ name: 'smoke', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

test('smoke stdio: registro condicionado y ejecutar_comando', async (t) => {
  await new Promise((r) => panel.listen(0, '127.0.0.1', r));
  t.after(() => panel.close());

  const soloLectura = await conectar({ TXPL_TOKEN: 'txpl_admin' });
  try {
    const { tools } = await soloLectura.listTools();
    assert.equal(tools.length, 13);
    assert.ok(tools.every((x) => x.annotations?.readOnlyHint === true));
  } finally { await soloLectura.close(); }

  const total = await conectar({ TXPL_TOKEN: 'txpl_admin', TXPL_ENABLE_WRITE: '1', TXPL_ENABLE_ADMIN: '1' });
  try {
    const { tools } = await total.listTools();
    assert.equal(tools.length, 19);
    const ex = tools.find((x) => x.name === 'ejecutar_comando');
    assert.equal(ex.annotations.destructiveHint, true);
    assert.notEqual(ex.annotations.readOnlyHint, true);
    const r = await total.callTool({ name: 'ejecutar_comando', arguments: { comando: 'echo hola' } });
    assert.ok(!r.isError);
    assert.match(r.content[0].text, /hola/);
  } finally { await total.close(); }

  const sinPermiso = await conectar({ TXPL_TOKEN: 'txpl_read', TXPL_ENABLE_ADMIN: '1' });
  try {
    const r = await sinPermiso.callTool({ name: 'ejecutar_comando', arguments: { comando: 'echo hola' } });
    assert.equal(r.isError, true);
    assert.equal(r.content[0].text, 'El token no tiene permiso para esta operación');
  } finally { await sinPermiso.close(); }
});
