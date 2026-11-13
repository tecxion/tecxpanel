#!/usr/bin/env node
// ============================================================
//  TecXPaneL MCP — instalador por consola
//
//  Registra el servidor MCP en Claude Desktop (edita su JSON por ti, con copia
//  de seguridad) y/o en Claude Code, sin tocar ningún fichero a mano.
//
//  Uso:   npm run setup                      (pregunta URL y token)
//         npm run setup -- --url https://vps.tu-dominio.com --code
//  Flags: --url <https://…>   --token <txpl_…>   (si faltan, se preguntan)
//         --desktop (por defecto) | --code | --both
//         --write  (activa las herramientas de acciones: reiniciar, backup, SSL)
//         --admin  (control total: ejecutar comandos y llamar a cualquier API; implica --write)
//         --no-check  (no probar el token contra el panel)
// ============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createClient } from './client.js';

export const SERVER_NAME = 'tecxpanel';
const INDEX_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'index.js');

// Ruta del claude_desktop_config.json según el sistema operativo.
export function desktopConfigPath(platform = process.platform, env = process.env, home = os.homedir()) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Claude', 'claude_desktop_config.json');
}

// Devuelve una copia de `config` con la entrada `tecxpanel` añadida o reemplazada,
// respetando el resto de servidores MCP que ya tuviera el usuario.
export function mergeServer(config, entry) {
  const base = config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  return { ...base, mcpServers: { ...(base.mcpServers || {}), [SERVER_NAME]: entry } };
}

// Variables de entorno del servidor MCP. --admin implica --write; sin flags solo hay lectura.
export const buildEnv = ({ url, token, write = false, admin = false }) => ({
  TXPL_URL: url,
  TXPL_TOKEN: token,
  ...((write || admin) && { TXPL_ENABLE_WRITE: '1' }),
  ...(admin && { TXPL_ENABLE_ADMIN: '1' }),
});

// Entrada que Claude Desktop lanzará: este mismo Node + index.js con rutas absolutas.
export const buildEntry = (opts) => ({
  command: process.execPath,
  args: [INDEX_JS],
  env: buildEnv(opts),
});

// Escribe la config de Claude Desktop. Si el JSON actual no es válido NO lo toca.
export function writeDesktopConfig(file, entry) {
  let current = {};
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, 'utf8');
    try { current = raw.trim() ? JSON.parse(raw) : {}; }
    catch { throw new Error(`${file} no es un JSON válido: arréglalo o bórralo y repite`); }
    fs.copyFileSync(file, `${file}.bak`); // copia de seguridad antes de cambiar nada
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  fs.writeFileSync(file, JSON.stringify(mergeServer(current, entry), null, 2) + '\n', { mode: 0o600 });
}

// Pregunta por consola; con `hidden` no muestra lo que se escribe (el token).
function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); };
    rl.question(question, (a) => { rl.close(); if (hidden) process.stdout.write('\n'); resolve(a.trim()); });
  });
}

function parseArgs(argv) {
  const o = { target: 'desktop', check: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') o.url = argv[++i];
    else if (a === '--token') o.token = argv[++i];
    else if (a === '--code') o.target = 'code';
    else if (a === '--both') o.target = 'both';
    else if (a === '--desktop') o.target = 'desktop';
    else if (a === '--write') o.write = true;
    else if (a === '--admin') o.admin = true;
    else if (a === '--no-check') o.check = false;
    else throw new Error(`Opción desconocida: ${a}`);
  }
  return o;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const url = o.url || await ask('URL del panel (https://…): ');
  const token = o.token || await ask('Token de API (txpl_…, no se muestra): ', { hidden: true });

  // Valida formato y, salvo --no-check, que el panel acepta el token.
  const client = createClient({ url, token });
  if (o.check) {
    await client.call('GET', '/api/system/stats');
    console.log('✔ El panel ha aceptado el token.');
  }

  const entry = buildEntry({ url, token, write: o.write, admin: o.admin });
  if (o.target === 'desktop' || o.target === 'both') {
    const file = desktopConfigPath();
    writeDesktopConfig(file, entry);
    console.log(`✔ Claude Desktop configurado (${file}). Ciérralo del todo y ábrelo de nuevo.`);
  }
  if (o.target === 'code' || o.target === 'both') {
    // Reemplaza un registro anterior con el mismo nombre (ignora el error si no existía).
    spawnSync('claude', ['mcp', 'remove', SERVER_NAME, '--scope', 'user'], { stdio: 'ignore' });
    const r = spawnSync('claude', ['mcp', 'add', '--scope', 'user', SERVER_NAME,
      ...Object.entries(entry.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), '--', process.execPath, INDEX_JS], { stdio: 'inherit' });
    if (r.error || r.status !== 0) throw new Error('No se pudo ejecutar «claude mcp add» (¿está instalado Claude Code?)');
    console.log('✔ Claude Code configurado (ámbito de usuario).');
  }
}

// Solo se ejecuta al lanzarlo por consola (no al importarlo en los tests).
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((e) => { console.error('✘ ' + e.message); process.exit(1); });
}
