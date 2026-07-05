import { existsSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { z } from "zod";
import { createLogger } from "../lib/logger";
import { registerApiRoutes } from "./api";
import type { AppDeps } from "./types";

const log = createLogger("http");

const DEFAULT_WEB_DIST_DIR = join(import.meta.dir, "..", "web", "dist");

/**
 * Builds the Hono application. Kept as a factory (rather than a module-level
 * singleton) so tests/index.ts can each create their own instance with their
 * own injected dependencies (real DB/pollers in index.ts, fakes in tests).
 */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  registerApiRoutes(app, deps);

  // Static frontend (src/web/dist), once it exists — built later (Phase 7).
  // Guarded so its absence during earlier phases doesn't error; registered
  // after all /api/* routes so it never shadows them.
  const webDistDir = deps.webDistDir ?? DEFAULT_WEB_DIST_DIR;
  if (existsSync(webDistDir)) {
    app.use("/*", serveStatic({ root: webDistDir }));
    app.get("*", serveStatic({ root: webDistDir, path: "index.html" }));
  }

  app.notFound((c) => c.json({ error: "not_found" }, 404));

  app.onError((err, c) => {
    if (err instanceof z.ZodError) {
      return c.json({ error: "validation_error", detail: err.issues }, 400);
    }
    log.error("unhandled request error", {
      error: err instanceof Error ? err.message : String(err),
      path: c.req.path,
    });
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
