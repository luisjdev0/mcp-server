import { createEchoServer } from "../servers/echo/index.js";
import { appflowyProxyEntry } from "../servers/appflowy/index.js";
import { dbhubProxyEntry } from "../servers/dbhub/index.js";
import { analyticsProxyEntry } from "../servers/analytics/index.js";
import type { McpRegistryEntry } from "./types.js";

export type { LocalMcpEntry, ProxiedMcpEntry, McpRegistryEntry } from "./types.js";

/**
 * Lista de MCPs activos. Para agregar uno propio (implementado con el SDK):
 * copia src/servers/_template, impleméntalo, e importa/agrega su entrada aquí
 * con `kind: "local"`. Para integrar un MCP de terceros que corre como su
 * propio servicio, agrega una entrada `kind: "proxy"` (ver src/servers/appflowy
 * como ejemplo).
 */
export const registry: McpRegistryEntry[] = [
  {
    kind: "local",
    name: "echo",
    path: "/echo",
    createServer: createEchoServer,
  },
  ...(appflowyProxyEntry ? [appflowyProxyEntry] : []),
  ...(dbhubProxyEntry ? [dbhubProxyEntry] : []),
  ...(analyticsProxyEntry ? [analyticsProxyEntry] : []),
];
