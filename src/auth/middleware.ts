import type { NextFunction, Request, Response } from "express";
import { findToken, tokenAllowsMcp } from "./keys.js";
import { isValidOAuthAccessToken } from "./oauth.js";

function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : null;
}

/**
 * Middleware que exige un Bearer token válido con acceso al MCP `mcpName`.
 * Se monta por cada MCP registrado, antes de conectar su transporte HTTP.
 *
 * Acepta dos tipos de token:
 * - Estático, definido en `MCP_AUTH_TOKENS` (con scope por MCP).
 * - Access token JWT emitido por el authorization server OAuth propio
 *   (`auth/oauth.ts` + `http/mountOAuth.ts`), usado por el custom connector de
 *   cuenta en claude.ai. Como solo hay un usuario administrador, un login OAuth
 *   válido implica acceso total (equivalente a scope "*").
 */
export function requireAuth(mcpName: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = extractBearerToken(req.header("authorization"));

    if (!token) {
      res.status(401).json({ error: "unauthorized", message: "Falta el header Authorization: Bearer <token>" });
      return;
    }

    if (isValidOAuthAccessToken(token)) {
      next();
      return;
    }

    const entry = findToken(token);
    if (!entry) {
      res.status(401).json({ error: "unauthorized", message: "Token inválido" });
      return;
    }

    if (!tokenAllowsMcp(entry, mcpName)) {
      res.status(403).json({ error: "forbidden", message: `El token no tiene acceso al MCP "${mcpName}"` });
      return;
    }

    next();
  };
}
