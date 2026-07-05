import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  PORT: z.coerce.number().int().positive().default(8080),
  TZ: z.string().min(1).default("Australia/Sydney"),
  SESSION_SECRET: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parses and validates process.env on every call (rather than caching at
 * import time) so tests can mutate process.env and re-load a fresh config.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${message}`);
  }
  return result.data;
}

/**
 * Lazily-evaluated env accessor for application code. Call `env()` to get
 * the current validated environment rather than importing a static object,
 * so tests can override process.env before first use.
 */
export function env(): Env {
  return loadEnv();
}
