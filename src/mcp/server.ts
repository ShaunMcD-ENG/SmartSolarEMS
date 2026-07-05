import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import pkg from "../../package.json" with { type: "json" };
import type { DecisionRow, PlanWithSlots } from "../db/repositories";
import { createLogger } from "../lib/logger";
import type {
  ExecutorStatusLike,
  ForecastServiceLike,
  OverridesRepoLike,
  PollersLike,
  ReposLike,
  SettingsLike,
} from "../server/types";
import { registerTools } from "./tools";

const log = createLogger("mcp");

/**
 * Everything the MCP audit tools (src/mcp/tools.ts) read. Deliberately a
 * structural subset of AppDeps (src/server/types.ts) — the concrete
 * `AppDeps` object satisfies this directly, so src/index.ts doesn't need to
 * construct anything new to wire /mcp up; it only needs to opt in via
 * `AppDeps.mcp = true` (see src/server/app.ts).
 *
 * `planById`/`latestDecision`/`nearestDecision` are test seams for
 * explain_decision: fetching an arbitrary plan by id (rather than only the
 * latest) isn't part of ReposLike, so the default implementation queries the
 * DB directly (src/mcp/queries.ts) without touching src/db/repositories.ts.
 * Real wiring never needs to provide these — the defaults just work.
 */
export interface McpToolDeps {
  settings: SettingsLike;
  pollers: PollersLike;
  forecastService: ForecastServiceLike;
  repos: ReposLike;
  overridesRepo: OverridesRepoLike;
  executor?: { status(): ExecutorStatusLike };
  now?: () => Date;
  version?: string;
  planById?: (id: number) => Promise<PlanWithSlots | null>;
  latestDecision?: () => Promise<DecisionRow | null>;
  nearestDecision?: (target: Date) => Promise<DecisionRow | null>;
}

/** Builds a fresh MCP server instance (name/version fixed, tools registered against `deps`). */
export function buildMcpServer(deps: McpToolDeps): McpServer {
  const server = new McpServer({
    name: "SmartSolarEMS",
    version: deps.version ?? pkg.version ?? "0.0.0",
    title: "SmartSolarEMS audit server",
  });
  registerTools(server, deps);
  return server;
}

/**
 * Handles one HTTP request against the MCP Streamable HTTP transport
 * (POST/GET/DELETE), in stateless mode: a fresh McpServer + transport per
 * request, per the SDK's own requirement ("Stateless transport cannot be
 * reused across requests" — see webStandardStreamableHttp.js). v1 is
 * strictly read-only: every registered tool only reads data, never mutates
 * settings/overrides/the inverter.
 *
 * Callers (src/server/app.ts) are responsible for authenticating the request
 * (bearer token check against settings.mcp) before calling this.
 */
export async function handleMcpRequest(req: Request, deps: McpToolDeps): Promise<Response> {
  const server = buildMcpServer(deps);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless: no session tracking
    enableJsonResponse: true, // plain JSON responses for POST instead of SSE — simpler for audit clients
  });

  try {
    await server.connect(transport);
    return await transport.handleRequest(req);
  } catch (err) {
    log.error("mcp request failed", { error: err instanceof Error ? err.message : String(err) });
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32603, message: "internal_error" }, id: null },
      { status: 500 },
    );
  } finally {
    // POST (JSON response mode) and DELETE responses are already fully
    // materialised by the time handleRequest resolves, so it's safe to close
    // immediately. GET opens a long-lived SSE stream for server-initiated
    // notifications (which these read-only tools never send); closing it
    // here would tear that stream down immediately, so it's left to the
    // client disconnecting / GC instead.
    if (req.method !== "GET") {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  }
}
