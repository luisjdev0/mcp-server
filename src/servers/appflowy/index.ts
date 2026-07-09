import { z } from "zod";
import type { ProxiedMcpEntry } from "../../registry/types.js";
import { logger } from "../../logger.js";

/**
 * Integra https://github.com/CAREEMER/appflowy-mcp como MCP de terceros.
 * Ese servidor corre aparte (contenedor `appflowy-mcp` en docker-compose,
 * imagen m2n2/appflowy-mcp) y expone su propio endpoint HTTP en /mcp con
 * su propio esquema de tokens (APPFLOWY_MCP_TOKENS). Aquí solo hacemos
 * reverse proxy desde /appflowy, protegido primero por nuestro propio
 * middleware de auth (scope "appflowy" en MCP_AUTH_TOKENS) y luego
 * inyectamos un token interno fijo para hablar con el sidecar.
 */
const appflowyEnvSchema = z.object({
  APPFLOWY_MCP_TARGET: z.string().url().default("http://appflowy-mcp:8000/mcp"),
  APPFLOWY_MCP_INTERNAL_TOKEN: z.string().min(1),
});

function loadAppflowyProxyEntry(): ProxiedMcpEntry | null {
  const parsed = appflowyEnvSchema.safeParse(process.env);

  if (!parsed.success) {
    logger.warn(
      'MCP "appflowy" deshabilitado: define APPFLOWY_MCP_INTERNAL_TOKEN (y opcionalmente APPFLOWY_MCP_TARGET) para activarlo.',
    );
    return null;
  }

  return {
    kind: "proxy",
    name: "appflowy",
    path: "/appflowy",
    target: parsed.data.APPFLOWY_MCP_TARGET,
    upstreamAuthHeader: `Bearer ${parsed.data.APPFLOWY_MCP_INTERNAL_TOKEN}`,
  };
}

export const appflowyProxyEntry = loadAppflowyProxyEntry();
