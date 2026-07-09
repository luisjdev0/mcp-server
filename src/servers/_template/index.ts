import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * Plantilla para crear un MCP nuevo:
 * 1. Copia esta carpeta a src/servers/<nombre>/index.ts.
 * 2. Renombra createTemplateServer y ajusta name/version/tools según el MCP real.
 * 3. Agrega una entrada en src/registry/index.ts con su `path` (ej. "/mi-mcp").
 * 4. Si un token debe quedar limitado a este MCP, usa <nombre> como scope
 *    en MCP_AUTH_TOKENS (ver .env.example).
 */
export function createTemplateServer(): McpServer {
  const server = new McpServer({
    name: "template",
    version: "0.1.0",
  });

  server.registerTool(
    "ping",
    {
      title: "Ping",
      description: "Tool de ejemplo: responde 'pong'.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text", text: "pong" }],
    }),
  );

  return server;
}
