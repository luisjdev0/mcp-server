import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** MCP implementado en este proyecto con el SDK, montado directamente como transporte HTTP. */
export interface LocalMcpEntry {
  kind: "local";
  /** Identificador del MCP, usado como scope de autenticación (ver auth/keys.ts). */
  name: string;
  /** Path público donde se monta, ej. "/echo". */
  path: string;
  /** Crea una instancia nueva del servidor MCP (una por sesión). */
  createServer: () => McpServer;
}

/** MCP de terceros que corre como su propio servicio (ej. contenedor sidecar) y al que solo hacemos reverse proxy. */
export interface ProxiedMcpEntry {
  kind: "proxy";
  name: string;
  /** Path público donde se monta, ej. "/appflowy". */
  path: string;
  /** URL completa del endpoint MCP downstream, ej. "http://appflowy-mcp:8000/mcp". */
  target: string;
  /** Valor completo del header Authorization a inyectar hacia el servicio downstream (su propio esquema de auth). */
  upstreamAuthHeader?: string;
}

export type McpRegistryEntry = LocalMcpEntry | ProxiedMcpEntry;
