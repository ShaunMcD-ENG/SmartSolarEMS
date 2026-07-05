import { Hono } from "hono";

// Bun embeds package.json contents at build time when imported with the
// `with { type: "json" }` attribute, giving us the version without a fs read.
import pkg from "../../package.json" with { type: "json" };

const startedAt = Date.now();

/** Builds the Hono application. Kept as a factory so tests/index.ts can each create their own instance. */
export function createApp(): Hono {
  const app = new Hono();

  app.get("/api/health", (c) => {
    return c.json({
      status: "ok",
      version: pkg.version ?? "0.0.0",
      uptime: Math.floor((Date.now() - startedAt) / 1000),
    });
  });

  return app;
}
