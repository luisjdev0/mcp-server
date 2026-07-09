import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

/**
 * MCP de ejemplo para validar el pipeline completo (auth -> transporte HTTP -> tools).
 * Registrado en src/registry/index.ts bajo el path "/echo".
 */
export function createEchoServer(): McpServer {
  const server = new McpServer({
    name: "echo",
    version: "0.1.0",
  });

  server.registerTool(
    "echo",
    {
      title: "Echo",
      description: "Devuelve el mismo texto recibido. Útil para probar la conexión MCP.",
      inputSchema: {
        text: z.string().describe("Texto a repetir"),
      },
    },
    async ({ text }) => ({
      content: [{ type: "text", text }],
    }),
  );

  server.registerTool(
    "server_time",
    {
      title: "Hora del servidor",
      description: "Devuelve la fecha y hora actual del servidor en formato ISO 8601.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text", text: new Date().toISOString() }],
    }),
  );

  return server;
}
