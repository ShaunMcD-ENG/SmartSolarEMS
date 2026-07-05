import { existsSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { z } from "zod";
import { createLogger } from "../lib/logger";
import { handleMcpRequest } from "../mcp/server";
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

  // Read-only MCP audit endpoint (POST/GET/DELETE /mcp), mounted only when
  // explicitly opted into (see AppDeps.mcp doc comment in ./types). Bearer
  // token is checked against settings.mcp on every request rather than once
  // at startup, so regenerating/disabling it via the API takes effect
  // immediately without a restart.
  if (deps.mcp) {
    app.all("/mcp", async (c) => {
      const mcpSettings = await deps.settings.get("mcp").catch(() => null);
      if (!mcpSettings?.enabled) return c.json({ error: "mcp_disabled" }, 403);

      const authHeader = c.req.header("authorization") ?? "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
      if (!token) return c.json({ error: "unauthorized" }, 401);
      if (!mcpSettings.token || token !== mcpSettings.token) return c.json({ error: "forbidden" }, 403);

      return handleMcpRequest(c.req.raw, deps);
    });
  }

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
