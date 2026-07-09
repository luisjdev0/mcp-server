import type { NextFunction, Request, Response } from "express";
import { findToken, tokenAllowsMcp } from "./keys.js";

function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : null;
}

/**
 * Middleware que exige un Bearer token válido con acceso al MCP `mcpName`.
 * Se monta por cada MCP registrado, antes de conectar su transporte HTTP.
 */
export function requireAuth(mcpName: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    const token = extractBearerToken(req.header("authorization"));

    if (!token) {
      res.status(401).json({ error: "unauthorized", message: "Falta el header Authorization: Bearer <token>" });
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
