#!/usr/bin/env node
// ============================================================
//  TecXPaneL MCP — servidor (stdio, solo lectura)
//
//  Corre en el ordenador del usuario (no en el VPS): el cliente MCP (p. ej.
//  Claude) lo lanza como proceso y habla con él por stdin/stdout. Cada
//  herramienta de tools.js se traduce a una llamada HTTPS al panel con el
//  token de API. Configuración por entorno: TXPL_URL y TXPL_TOKEN.
//  IMPORTANTE: stdout es SOLO protocolo MCP; los logs van a stderr y jamás
//  incluyen el token ni la URL.
// ============================================================
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createClient } from './client.js';
import { TOOLS } from './tools.js';

let client;
try {
  client = createClient({ url: process.env.TXPL_URL, token: process.env.TXPL_TOKEN });
} catch (e) {
  console.error(`txpl-mcp: ${e.message}`);
  process.exit(1);
}

const server = new McpServer({ name: 'txpl-mcp', version: '0.1.0' });

for (const t of TOOLS) {
  server.registerTool(
    t.name,
    { description: t.description, inputSchema: t.input, annotations: { readOnlyHint: true } },
    async (args) => {
      try {
        return { content: [{ type: 'text', text: await client.call(t.method, t.path(args)) }] };
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: e.message }] };
      }
    },
  );
}

await server.connect(new StdioServerTransport());
console.error('txpl-mcp: listo (solo lectura)');
