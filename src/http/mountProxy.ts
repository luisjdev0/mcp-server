import type { Express } from "express";
import { createProxyMiddleware } from "http-proxy-middleware";
import type { ProxiedMcpEntry } from "../registry/types.js";

/**
 * Monta un reverse proxy hacia un MCP de terceros que corre como su propio
 * servicio (ej. un contenedor sidecar). No se parsea el body de la request
 * en ningún middleware previo para este path: se reenvía el stream crudo tal
 * cual llega, para no romper el framing HTTP que espera el servicio downstream.
 */
export function mountProxy(app: Express, entry: ProxiedMcpEntry): void {
  const targetUrl = new URL(entry.target);

  app.use(
    entry.path,
    createProxyMiddleware({
      target: `${targetUrl.protocol}//${targetUrl.host}`,
      changeOrigin: true,
      pathRewrite: () => targetUrl.pathname,
      on: {
        proxyReq: (proxyReq) => {
          if (entry.upstreamAuthHeader) {
            proxyReq.setHeader("authorization", entry.upstreamAuthHeader);
          }
        },
      },
    }),
  );
}
