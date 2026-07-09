import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  // Formato: "token1:scope1|scope2,token2:*" — ver auth/keys.ts para el parseo.
  MCP_AUTH_TOKENS: z.string().min(1, "Define al menos un token en MCP_AUTH_TOKENS"),
});

export const env = envSchema.parse(process.env);
