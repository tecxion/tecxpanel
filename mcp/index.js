#!/usr/bin/env node
// ============================================================
//  TecXPaneL MCP — servidor (stdio)
//
//  Corre en el ordenador del usuario (no en el VPS): el cliente MCP (p. ej.
//  Claude) lo lanza como proceso y habla con él por stdin/stdout. Cada
//  herramienta de tools.js se traduce a una llamada HTTPS al panel con el
//  token de API. Configuración por entorno: TXPL_URL y TXPL_TOKEN; con
//  TXPL_ENABLE_WRITE=1 / TXPL_ENABLE_ADMIN=1 se registran además las
//  herramientas de acciones / de control total (por defecto solo lectura).
//  IMPORTANTE: stdout es SOLO protocolo MCP; los logs van a stderr y jamás
//  incluyen el token ni la URL.
// ============================================================
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createClient } from './client.js';
import { selectTools, modoDe, annotationsDe } from './tools.js';

let client;
try {
  client = createClient({ url: process.env.TXPL_URL, token: process.env.TXPL_TOKEN });
} catch (e) {
  console.error(`txpl-mcp: ${e.message}`);
  process.exit(1);
}

const server = new McpServer({ name: 'txpl-mcp', version: '0.1.0' });

for (const t of selectTools(process.env)) {
  server.registerTool(
    t.name,
    { description: t.description, inputSchema: t.input, annotations: annotationsDe(t) },
    async (args) => {
      try {
        const method = typeof t.method === 'function' ? t.method(args) : t.method;
        const text = await client.call(method, t.path(args), t.body?.(args));
        return { content: [{ type: 'text', text: t.format ? t.format(text) : text }] };
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: e.message }] };
      }
    },
  );
}

await server.connect(new StdioServerTransport());
console.error(`txpl-mcp: listo (${modoDe(process.env)})`);
