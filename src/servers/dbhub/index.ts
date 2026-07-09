import { z } from "zod";
import type { ProxiedMcpEntry } from "../../registry/types.js";
import { logger } from "../../logger.js";

/**
 * Integra https://github.com/bytebase/dbhub como MCP de terceros.
 * DBHub corre aparte (contenedor `dbhub-mcp` en docker-compose, imagen
 * bytebase/dbhub) en modo `--transport http`, expone el protocolo MCP en
 * /mcp y, por diseño, NO autentica a sus clientes HTTP (ver su propio
 * README: "DBHub does not authenticate HTTP clients"). Por eso nunca debe
 * exponerse directamente: nuestro middleware de auth (scope "dbhub" en
 * MCP_AUTH_TOKENS) es la única capa de protección delante de él.
 *
 * A diferencia de appflowy, no hace falta inyectar ningún token hacia el
 * downstream: basta con el reverse proxy.
 */
const dbhubEnvSchema = z.object({
  DBHUB_MCP_TARGET: z.string().url().default("http://dbhub-mcp:8080/mcp"),
  // No la usamos directamente (la consume el contenedor dbhub-mcp vía
  // docker-compose), pero su presencia es la señal de que este MCP está
  // configurado para esta instancia.
  DBHUB_DSN: z.string().min(1),
});

function loadDbhubProxyEntry(): ProxiedMcpEntry | null {
  const parsed = dbhubEnvSchema.safeParse(process.env);

  if (!parsed.success) {
    logger.warn(
      'MCP "dbhub" deshabilitado: define DBHUB_DSN (y opcionalmente DBHUB_MCP_TARGET) para activarlo.',
    );
    return null;
  }

  return {
    kind: "proxy",
    name: "dbhub",
    path: "/dbhub",
    target: parsed.data.DBHUB_MCP_TARGET,
  };
}

export const dbhubProxyEntry = loadDbhubProxyEntry();
