#!/usr/bin/env node
// ============================================================
//  TecXPaneL MCP — servidor (stdio)
//
//  Corre en el ordenador del usuario (no en el VPS): el cliente MCP (p. ej.
//  Claude) lo lanza como proceso y habla con él por stdin/stdout. Cada
//  herramienta de tools.js se traduce a una llamada HTTPS al panel con el
//  token de API. Configuración por entorno: TXPL_URL y TXPL_TOKEN; las
//  herramientas de escritura y de control total solo se registran con
//  TXPL_ENABLE_WRITE=1 y TXPL_ENABLE_ADMIN=1 (además el token debe tener ese ámbito).
//  IMPORTANTE: stdout es SOLO protocolo MCP; los logs van a stderr y jamás
//  incluyen el token ni la URL.
// ============================================================
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createClient } from './client.js';
import { toolsFor } from './tools.js';

let client;
try {
  client = createClient({ url: process.env.TXPL_URL, token: process.env.TXPL_TOKEN });
} catch (e) {
  console.error(`txpl-mcp: ${e.message}`);
  process.exit(1);
}

const server = new McpServer({ name: 'txpl-mcp', version: '0.2.0' });

const tools = toolsFor(process.env);
for (const t of tools) {
  const annotations = t.scope === 'read' ? { readOnlyHint: true } : { readOnlyHint: false, destructiveHint: true };
  server.registerTool(
    t.name,
    { description: t.description, inputSchema: t.input, annotations },
    async (args) => {
      try {
        return { content: [{ type: 'text', text: await client.call(t.method(args), t.path(args), t.body?.(args)) }] };
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: e.message }] };
      }
    },
  );
}

await server.connect(new StdioServerTransport());
const NOMBRES = { read: 'lectura', write: 'escritura', admin: 'control total' };
const ambitos = [...new Set(tools.map((t) => NOMBRES[t.scope]))];
console.error(`txpl-mcp: listo (${ambitos.length === 1 ? 'solo lectura' : ambitos.join(' + ')})`);
