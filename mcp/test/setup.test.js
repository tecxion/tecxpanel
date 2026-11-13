// ============================================================
//  Tests de mcp/setup.js — fusión de la config de Claude Desktop sin pisar
//  otros servidores, copia de seguridad, JSON inválido y rutas por sistema.
// ============================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mergeServer, writeDesktopConfig, desktopConfigPath, buildEntry, buildEnv, SERVER_NAME } from '../setup.js';

const entry = buildEntry({ url: 'https://p.test', token: 'txpl_x' });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'txpl-setup-'));

test('mergeServer conserva otros servidores y otras claves', () => {
  const out = mergeServer({ theme: 'dark', mcpServers: { otro: { command: 'x' } } }, entry);
  assert.equal(out.theme, 'dark');
  assert.deepEqual(out.mcpServers.otro, { command: 'x' });
  assert.deepEqual(out.mcpServers[SERVER_NAME], entry);
});

test('mergeServer acepta config vacía o inválida', () => {
  assert.deepEqual(mergeServer(null, entry).mcpServers[SERVER_NAME], entry);
  assert.deepEqual(mergeServer([], entry).mcpServers[SERVER_NAME], entry);
});

test('buildEntry usa rutas absolutas y el entorno del panel', () => {
  assert.ok(path.isAbsolute(entry.args[0]) && entry.args[0].endsWith('index.js'));
  assert.deepEqual(entry.env, { TXPL_URL: 'https://p.test', TXPL_TOKEN: 'txpl_x' });
});

test('writeDesktopConfig crea el fichero y la carpeta si no existen', () => {
  const f = path.join(tmp(), 'Claude', 'claude_desktop_config.json');
  writeDesktopConfig(f, entry);
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')).mcpServers[SERVER_NAME], entry);
});

test('writeDesktopConfig hace copia .bak y mantiene lo que había', () => {
  const f = path.join(tmp(), 'c.json');
  fs.writeFileSync(f, JSON.stringify({ mcpServers: { otro: { command: 'x' } } }));
  writeDesktopConfig(f, entry);
  const now = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.ok(now.mcpServers.otro && now.mcpServers[SERVER_NAME]);
  assert.ok(JSON.parse(fs.readFileSync(f + '.bak', 'utf8')).mcpServers.otro);
});

test('writeDesktopConfig no toca un JSON inválido', () => {
  const f = path.join(tmp(), 'c.json');
  fs.writeFileSync(f, '{ roto');
  assert.throws(() => writeDesktopConfig(f, entry), /no es un JSON válido/);
  assert.equal(fs.readFileSync(f, 'utf8'), '{ roto');
});

test('desktopConfigPath según sistema', () => {
  assert.equal(desktopConfigPath('darwin', {}, '/h'), '/h/Library/Application Support/Claude/claude_desktop_config.json');
  assert.equal(desktopConfigPath('linux', {}, '/h'), '/h/.config/Claude/claude_desktop_config.json');
  assert.match(desktopConfigPath('win32', { APPDATA: 'C:\\A' }, 'C:\\h'), /Claude.claude_desktop_config\.json$/);
});

test('buildEnv: sin flags solo lectura; --write y --admin añaden interruptores (admin implica write)', () => {
  const base = { url: 'https://p.test', token: 'txpl_x' };
  assert.deepEqual(buildEnv(base), { TXPL_URL: base.url, TXPL_TOKEN: base.token });
  assert.deepEqual(buildEnv({ ...base, write: true }), { ...buildEnv(base), TXPL_ENABLE_WRITE: '1' });
  assert.deepEqual(buildEnv({ ...base, admin: true }), { ...buildEnv(base), TXPL_ENABLE_WRITE: '1', TXPL_ENABLE_ADMIN: '1' });
  assert.deepEqual(buildEntry({ ...base, admin: true }).env, buildEnv({ ...base, admin: true }));
});
