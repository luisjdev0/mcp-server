import { env } from "../config/env.js";

export interface TokenEntry {
  token: string;
  scopes: string[]; // nombres de MCP permitidos, o ["*"] para acceso total
}

/**
 * Formato de MCP_AUTH_TOKENS: lista separada por comas de "token" o "token:scope1|scope2".
 * Sin scope explícito, el token tiene acceso a todos los MCPs registrados.
 * Ejemplo: MCP_AUTH_TOKENS=abc123:*,def456:echo
 */
function parseTokens(raw: string): Map<string, TokenEntry> {
  const entries = new Map<string, TokenEntry>();

  for (const chunk of raw.split(",")) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;

    const separatorIndex = trimmed.indexOf(":");
    const token = separatorIndex === -1 ? trimmed : trimmed.slice(0, separatorIndex);
    const scopesRaw = separatorIndex === -1 ? "*" : trimmed.slice(separatorIndex + 1);

    if (!token) continue;

    const scopes = scopesRaw
      .split("|")
      .map((scope) => scope.trim())
      .filter(Boolean);

    entries.set(token, { token, scopes: scopes.length > 0 ? scopes : ["*"] });
  }

  return entries;
}

const tokens = parseTokens(env.MCP_AUTH_TOKENS);

export function findToken(token: string): TokenEntry | undefined {
  return tokens.get(token);
}

export function tokenAllowsMcp(entry: TokenEntry, mcpName: string): boolean {
  return entry.scopes.includes("*") || entry.scopes.includes(mcpName);
}
