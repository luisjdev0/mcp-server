import { z } from "zod";
import type { ProxiedMcpEntry } from "../../registry/types.js";
import { logger } from "../../logger.js";

/**
 * Integra https://github.com/googleanalytics/google-analytics-mcp (oficial de
 * Google, paquete "analytics-mcp" en PyPI) como MCP de terceros. Ese servidor
 * solo habla stdio, así que corre envuelto en un sidecar propio (contenedor
 * `analytics-mcp`, ver docker/analytics-mcp/) que reexpone el mismo Server
 * object sobre Streamable HTTP con el SDK oficial de MCP para Python — no es
 * un binario de terceros que ya hable HTTP como appflowy/dbhub, sino nuestro
 * wrapper alrededor de un paquete oficial. El sidecar le añade además tools
 * de escritura propias (ver docker/analytics-mcp/admin_write_tools.py) que el
 * paquete oficial no trae, así que el acceso combina reporting de solo
 * lectura (scope analytics.readonly) con administración vía Admin API
 * (scope analytics.edit), ambos con una service account de GCP dedicada.
 */
const analyticsEnvSchema = z.object({
  ANALYTICS_MCP_TARGET: z.string().url().default("http://analytics-mcp:8080/mcp"),
  ANALYTICS_MCP_INTERNAL_TOKEN: z.string().min(1),
});

function loadAnalyticsProxyEntry(): ProxiedMcpEntry | null {
  const parsed = analyticsEnvSchema.safeParse(process.env);

  if (!parsed.success) {
    logger.warn(
      'MCP "analytics" deshabilitado: define ANALYTICS_MCP_INTERNAL_TOKEN (y opcionalmente ANALYTICS_MCP_TARGET) para activarlo.',
    );
    return null;
  }

  return {
    kind: "proxy",
    name: "analytics",
    path: "/analytics",
    target: parsed.data.ANALYTICS_MCP_TARGET,
    upstreamAuthHeader: `Bearer ${parsed.data.ANALYTICS_MCP_INTERNAL_TOKEN}`,
  };
}

export const analyticsProxyEntry = loadAnalyticsProxyEntry();
