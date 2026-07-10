import type { Express, Request, Response } from "express";
import express from "express";
import { logger } from "../logger.js";
import { registry } from "../registry/index.js";
import {
  oauthConfig,
  registerClient,
  getClient,
  createAuthorizationCode,
  consumeAuthorizationCode,
  verifyPkce,
  verifyAdminCredentials,
  issueTokens,
  verifyRefreshToken,
} from "../auth/oauth.js";

function issuerFrom(req: Request): string {
  return `${req.protocol}://${req.get("host")}`;
}

/** `state`, `code_challenge` (y en teoría `redirect_uri`) vienen del query string del cliente:
 * hay que escaparlos antes de insertarlos en el HTML para no abrir un XSS reflejado. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderLoginPage(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  error?: string;
}): string {
  const clientId = escapeHtml(params.clientId);
  const redirectUri = escapeHtml(params.redirectUri);
  const state = escapeHtml(params.state);
  const codeChallenge = escapeHtml(params.codeChallenge);
  const error = params.error ? escapeHtml(params.error) : undefined;

  return `<!doctype html>
<html lang="es">
<head><meta charset="utf-8"><title>Iniciar sesión — MCP Gateway</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 360px; margin: 4rem auto;">
  <h1 style="font-size: 1.2rem;">Autorizar acceso al MCP Gateway</h1>
  ${error ? `<p style="color: #b00020;">${error}</p>` : ""}
  <form method="post">
    <input type="hidden" name="client_id" value="${clientId}">
    <input type="hidden" name="redirect_uri" value="${redirectUri}">
    <input type="hidden" name="state" value="${state}">
    <input type="hidden" name="code_challenge" value="${codeChallenge}">
    <label>Usuario<br><input type="text" name="username" autofocus required style="width: 100%; margin-bottom: 1rem;"></label>
    <label>Contraseña<br><input type="password" name="password" required style="width: 100%; margin-bottom: 1rem;"></label>
    <button type="submit" style="width: 100%; padding: 0.5rem;">Autorizar</button>
  </form>
</body>
</html>`;
}

/**
 * Monta un authorization server OAuth 2.1 + Dynamic Client Registration (RFC 7591)
 * mínimo, de un solo usuario administrador, para que claude.ai pueda registrar
 * este gateway como *custom connector a nivel de cuenta* (Settings → Connectors).
 * Ese flujo, a diferencia de mcp-remote en `claude_desktop_config.json`, solo
 * sabe hablar OAuth: no hay forma de pegar un Bearer token estático ahí.
 *
 * Si OAUTH_JWT_SECRET/OAUTH_ADMIN_USER/OAUTH_ADMIN_PASSWORD no están definidos,
 * no se monta nada y el gateway sigue funcionando solo con MCP_AUTH_TOKENS.
 */
export function mountOAuth(app: Express): void {
  if (!oauthConfig) return;

  const jsonBody = express.json();
  const formBody = express.urlencoded({ extended: false });

  app.get("/.well-known/oauth-authorization-server", (req: Request, res: Response) => {
    const issuer = issuerFrom(req);
    res.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
  });

  const protectedResourceHandler = (req: Request, res: Response) => {
    const issuer = issuerFrom(req);
    res.json({
      resource: issuer,
      authorization_servers: [issuer],
    });
  };

  app.get("/.well-known/oauth-protected-resource", protectedResourceHandler);
  for (const entry of registry) {
    app.get(`/.well-known/oauth-protected-resource${entry.path}`, protectedResourceHandler);
  }

  app.post("/register", jsonBody, (req: Request, res: Response) => {
    const redirectUris = req.body?.redirect_uris;

    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      res.status(400).json({ error: "invalid_client_metadata", error_description: "redirect_uris es requerido" });
      return;
    }

    const client = registerClient(redirectUris, req.body?.client_name);

    res.status(201).json({
      client_id: client.clientId,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  app.get("/authorize", (req: Request, res: Response) => {
    const { response_type, client_id, redirect_uri, state, code_challenge, code_challenge_method } = req.query;

    if (response_type !== "code") {
      res.status(400).json({ error: "unsupported_response_type" });
      return;
    }
    if (code_challenge_method && code_challenge_method !== "S256") {
      res.status(400).json({ error: "invalid_request", error_description: "Solo se soporta code_challenge_method=S256" });
      return;
    }
    if (typeof client_id !== "string" || typeof redirect_uri !== "string" || typeof code_challenge !== "string") {
      res.status(400).json({ error: "invalid_request" });
      return;
    }

    const client = getClient(client_id);
    if (!client || !client.redirectUris.includes(redirect_uri)) {
      res.status(400).json({ error: "invalid_request", error_description: "client_id o redirect_uri desconocidos" });
      return;
    }

    res.type("html").send(
      renderLoginPage({
        clientId: client_id,
        redirectUri: redirect_uri,
        state: typeof state === "string" ? state : "",
        codeChallenge: code_challenge,
      }),
    );
  });

  app.post("/authorize", formBody, (req: Request, res: Response) => {
    const { client_id, redirect_uri, state, code_challenge, username, password } = req.body ?? {};

    const client = getClient(client_id);
    if (!client || !client.redirectUris.includes(redirect_uri)) {
      res.status(400).json({ error: "invalid_request", error_description: "client_id o redirect_uri desconocidos" });
      return;
    }

    if (!verifyAdminCredentials(username ?? "", password ?? "")) {
      res.status(401).type("html").send(
        renderLoginPage({
          clientId: client_id,
          redirectUri: redirect_uri,
          state: state ?? "",
          codeChallenge: code_challenge,
          error: "Usuario o contraseña incorrectos.",
        }),
      );
      return;
    }

    const code = createAuthorizationCode({
      clientId: client_id,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      codeChallengeMethod: "S256",
      expiresAt: Date.now() + 60_000,
    });

    const redirectUrl = new URL(redirect_uri);
    redirectUrl.searchParams.set("code", code);
    if (state) redirectUrl.searchParams.set("state", state);

    res.redirect(302, redirectUrl.toString());
  });

  app.post("/token", formBody, (req: Request, res: Response) => {
    const grantType = req.body?.grant_type;

    if (grantType === "authorization_code") {
      const { code, redirect_uri, code_verifier, client_id } = req.body ?? {};

      const entry = consumeAuthorizationCode(code ?? "");
      if (!entry) {
        res.status(400).json({ error: "invalid_grant", error_description: "Código inválido, expirado o ya usado" });
        return;
      }
      if (entry.clientId !== client_id || entry.redirectUri !== redirect_uri) {
        res.status(400).json({ error: "invalid_grant" });
        return;
      }
      if (!code_verifier || !verifyPkce(code_verifier, entry.codeChallenge)) {
        res.status(400).json({ error: "invalid_grant", error_description: "code_verifier no coincide con code_challenge" });
        return;
      }

      const tokens = issueTokens();
      res.json({
        access_token: tokens.accessToken,
        token_type: "Bearer",
        expires_in: tokens.expiresIn,
        refresh_token: tokens.refreshToken,
      });
      return;
    }

    if (grantType === "refresh_token") {
      const refreshToken = req.body?.refresh_token;
      if (!refreshToken || !verifyRefreshToken(refreshToken)) {
        res.status(400).json({ error: "invalid_grant" });
        return;
      }

      const tokens = issueTokens();
      res.json({
        access_token: tokens.accessToken,
        token_type: "Bearer",
        expires_in: tokens.expiresIn,
        refresh_token: tokens.refreshToken,
      });
      return;
    }

    res.status(400).json({ error: "unsupported_grant_type" });
  });

  logger.info("OAuth authorization server (custom connector de cuenta) montado en /.well-known, /register, /authorize y /token");
}
