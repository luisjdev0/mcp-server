import { randomBytes, randomUUID, timingSafeEqual, createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { logger } from "../logger.js";

/**
 * Authorization Server OAuth 2.1 + Dynamic Client Registration (RFC 7591) mínimo,
 * pensado para un único usuario administrador (no hay noción de "cuentas").
 * Habilita que claude.ai registre este gateway como *custom connector* a nivel
 * de cuenta (Settings → Connectors), algo que el esquema de Bearer estático no
 * permite porque esa UI solo sabe hacer el handshake OAuth.
 *
 * Si las variables de entorno no están definidas, el AS queda deshabilitado y
 * el gateway sigue funcionando solo con `MCP_AUTH_TOKENS` (ver auth/middleware.ts).
 */

const oauthEnvSchema = z.object({
  OAUTH_JWT_SECRET: z.string().min(32),
  OAUTH_ADMIN_USER: z.string().min(1),
  OAUTH_ADMIN_PASSWORD: z.string().min(1),
  OAUTH_CLIENTS_FILE: z.string().default("./data/oauth-clients.json"),
});

export interface OAuthConfig {
  jwtSecret: string;
  adminUser: string;
  adminPassword: string;
  clientsFile: string;
}

function loadOAuthConfig(): OAuthConfig | null {
  const parsed = oauthEnvSchema.safeParse(process.env);

  if (!parsed.success) {
    logger.warn(
      "OAuth (custom connector de cuenta en claude.ai) deshabilitado: define OAUTH_JWT_SECRET, OAUTH_ADMIN_USER y OAUTH_ADMIN_PASSWORD para activarlo.",
    );
    return null;
  }

  return {
    jwtSecret: parsed.data.OAUTH_JWT_SECRET,
    adminUser: parsed.data.OAUTH_ADMIN_USER,
    adminPassword: parsed.data.OAUTH_ADMIN_PASSWORD,
    clientsFile: parsed.data.OAUTH_CLIENTS_FILE,
  };
}

export const oauthConfig = loadOAuthConfig();

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60; // 1h
const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 días
const AUTH_CODE_TTL_MS = 60_000; // 1 minuto, de un solo uso

interface RegisteredClient {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
  createdAt: string;
}

interface AuthCodeEntry {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
  expiresAt: number;
}

// Los clientes registrados dinámicamente se persisten a disco: si el proceso
// se reinicia, claude.ai no debería tener que volver a registrarse/reconectar.
// Los códigos de autorización son de vida muy corta (se canjean en segundos),
// así que basta con guardarlos en memoria.
const authCodes = new Map<string, AuthCodeEntry>();
let clients = new Map<string, RegisteredClient>();

function loadClientsFromDisk(file: string): Map<string, RegisteredClient> {
  try {
    if (!existsSync(file)) return new Map();
    const raw = JSON.parse(readFileSync(file, "utf-8")) as RegisteredClient[];
    return new Map(raw.map((c) => [c.clientId, c]));
  } catch (error) {
    logger.warn({ err: error, file }, "No se pudo leer el archivo de clientes OAuth, se ignora");
    return new Map();
  }
}

function persistClientsToDisk(file: string, all: Map<string, RegisteredClient>): void {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify([...all.values()], null, 2), "utf-8");
  } catch (error) {
    logger.error({ err: error, file }, "No se pudo persistir el archivo de clientes OAuth");
  }
}

if (oauthConfig) {
  clients = loadClientsFromDisk(oauthConfig.clientsFile);
}

export function registerClient(redirectUris: string[], clientName?: string): RegisteredClient {
  if (!oauthConfig) throw new Error("OAuth deshabilitado");

  const client: RegisteredClient = {
    clientId: randomUUID(),
    clientName,
    redirectUris,
    createdAt: new Date().toISOString(),
  };

  clients.set(client.clientId, client);
  persistClientsToDisk(oauthConfig.clientsFile, clients);
  return client;
}

export function getClient(clientId: string): RegisteredClient | undefined {
  return clients.get(clientId);
}

export function createAuthorizationCode(entry: AuthCodeEntry): string {
  const code = randomBytes(32).toString("base64url");
  authCodes.set(code, entry);
  setTimeout(() => authCodes.delete(code), AUTH_CODE_TTL_MS).unref();
  return code;
}

/** Consume (de un solo uso) un código de autorización previamente emitido. */
export function consumeAuthorizationCode(code: string): AuthCodeEntry | undefined {
  const entry = authCodes.get(code);
  if (!entry) return undefined;

  authCodes.delete(code);
  if (Date.now() > entry.expiresAt) return undefined;

  return entry;
}

/** Verifica el `code_verifier` de PKCE (S256) contra el `code_challenge` guardado. */
export function verifyPkce(codeVerifier: string, codeChallenge: string): boolean {
  const computed = createHash("sha256").update(codeVerifier).digest("base64url");
  return timingSafeEqual(Buffer.from(computed), Buffer.from(codeChallenge));
}

export function verifyAdminCredentials(user: string, password: string): boolean {
  if (!oauthConfig) return false;

  const userBuf = Buffer.from(user);
  const expectedUserBuf = Buffer.from(oauthConfig.adminUser);
  const passBuf = Buffer.from(password);
  const expectedPassBuf = Buffer.from(oauthConfig.adminPassword);

  const userMatches =
    userBuf.length === expectedUserBuf.length && timingSafeEqual(userBuf, expectedUserBuf);
  const passMatches =
    passBuf.length === expectedPassBuf.length && timingSafeEqual(passBuf, expectedPassBuf);

  return userMatches && passMatches;
}

interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export function issueTokens(): TokenPair {
  if (!oauthConfig) throw new Error("OAuth deshabilitado");

  const accessToken = jwt.sign({ type: "access" }, oauthConfig.jwtSecret, {
    subject: oauthConfig.adminUser,
    issuer: "mcp-gateway",
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
  });

  const refreshToken = jwt.sign({ type: "refresh" }, oauthConfig.jwtSecret, {
    subject: oauthConfig.adminUser,
    issuer: "mcp-gateway",
    expiresIn: REFRESH_TOKEN_TTL_SECONDS,
  });

  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

export function verifyRefreshToken(token: string): boolean {
  if (!oauthConfig) return false;

  try {
    const payload = jwt.verify(token, oauthConfig.jwtSecret, { issuer: "mcp-gateway" });
    return typeof payload === "object" && payload.type === "refresh";
  } catch {
    return false;
  }
}

/** Usado por auth/middleware.ts: ¿este Bearer token es un access token válido emitido por nuestro AS? */
export function isValidOAuthAccessToken(token: string): boolean {
  if (!oauthConfig) return false;

  try {
    const payload = jwt.verify(token, oauthConfig.jwtSecret, { issuer: "mcp-gateway" });
    return typeof payload === "object" && payload.type === "access";
  } catch {
    return false;
  }
}
