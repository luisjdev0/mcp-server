import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { LocalMcpEntry } from "../registry/types.js";
import { logger } from "../logger.js";

/**
 * Monta un MCP local (implementado en este proyecto) en Express usando
 * Streamable HTTP, con una sesión (y un McpServer) aislada por
 * `Mcp-Session-Id`. El mapa de sesiones vive en memoria: si en el futuro
 * se corre más de una instancia de esta app, ese estado debe moverse a un
 * store compartido (ej. Redis).
 */
export function mountMcp(app: Express, entry: LocalMcpEntry): void {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const postHandler = async (req: Request, res: Response) => {
    const sessionId = req.header("mcp-session-id");

    try {
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports.has(sessionId)) {
        transport = transports.get(sessionId)!;
      } else if (!sessionId && isInitializeRequest(req.body)) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, transport);
          },
        });

        transport.onclose = () => {
          if (transport.sessionId) transports.delete(transport.sessionId);
        };

        const server = entry.createServer();
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid session ID provided" },
          id: null,
        });
        return;
      }

      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error({ err: error, mcp: entry.name }, "Error manejando request MCP");
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  };

  const sessionHandler = async (req: Request, res: Response) => {
    const sessionId = req.header("mcp-session-id");
    const transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      res.status(400).send("Invalid or missing session ID");
      return;
    }

    await transport.handleRequest(req, res);
  };

  app.post(entry.path, postHandler);
  app.get(entry.path, sessionHandler);
  app.delete(entry.path, sessionHandler);
}
