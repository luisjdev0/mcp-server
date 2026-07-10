import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { pinoHttp } from "pino-http";
import { env } from "./config/env.js";
import { logger } from "./logger.js";
import { registry } from "./registry/index.js";
import { mountMcp } from "./http/mountMcp.js";
import { mountProxy } from "./http/mountProxy.js";
import { mountOAuth } from "./http/mountOAuth.js";
import { requireAuth } from "./auth/middleware.js";

const app = express();

// Detrás de un reverse proxy (Caddy) que ya maneja TLS y el dominio.
app.set("trust proxy", 1);

app.use(helmet());
app.use(pinoHttp({ logger }));

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Authorization server OAuth 2.1 + DCR (opcional, ver auth/oauth.ts): habilita
// registrar este gateway como custom connector de cuenta en claude.ai.
mountOAuth(app);

for (const entry of registry) {
  const mcpLimiter = rateLimit({ windowMs: 60_000, limit: 120 });
  app.use(entry.path, mcpLimiter, requireAuth(entry.name));

  if (entry.kind === "local") {
    // El body-parser solo se aplica a los MCPs locales: nuestro propio
    // transporte espera `req.body` ya parseado (ver http/mountMcp.ts).
    app.use(entry.path, express.json());
    mountMcp(app, entry);
  } else {
    // Los MCPs proxied reenvían el stream crudo sin tocarlo.
    mountProxy(app, entry);
  }

  logger.info(`MCP "${entry.name}" (${entry.kind}) montado en ${entry.path}`);
}

app.listen(env.PORT, () => {
  logger.info(`MCP gateway escuchando en el puerto ${env.PORT}`);
});
