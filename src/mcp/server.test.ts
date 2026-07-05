import { describe, expect, test } from "bun:test";
import type { DecisionRow, PlanWithSlots } from "../db/repositories";
import { createApp } from "../server/app";
import { InMemorySessionStore } from "../server/test-helpers";
import type { AppDeps } from "../server/types";
import { FakeSettings, fakeForecastService, fakeOverridesRepo, fakePollers, fakeRepos } from "./test-helpers";

/** bun-types declares Response.json() as Promise<unknown>; this centralises the `any` cast (see src/server/api.test.ts). */
function readJson(res: Response): Promise<any> {
  return res.json();
}

const MCP_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};

function jsonRpc(method: string, params?: Record<string, unknown>, id: number | string = 1) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
}

function baseDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  return {
    settings: new FakeSettings({ mcp: { enabled: true, token: "the-real-token" } }),
    sessions: new InMemorySessionStore(),
    pollers: fakePollers(),
    forecastService: fakeForecastService(),
    repos: fakeRepos(),
    overridesRepo: fakeOverridesRepo(),
    mcp: true,
    ...overrides,
  };
}

async function initialize(app: ReturnType<typeof createApp>, token: string) {
  return app.request("/mcp", {
    method: "POST",
    headers: { ...MCP_HEADERS, authorization: `Bearer ${token}` },
    body: jsonRpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.0.0" },
    }),
  });
}

describe("/mcp auth", () => {
  test("no Authorization header -> 401", async () => {
    const app = createApp(baseDeps());
    const res = await app.request("/mcp", { method: "POST", headers: MCP_HEADERS, body: jsonRpc("tools/list") });
    expect(res.status).toBe(401);
    expect((await readJson(res)).error).toBe("unauthorized");
  });

  test("wrong bearer token -> 403", async () => {
    const app = createApp(baseDeps());
    const res = await initialize(app, "not-the-right-token");
    expect(res.status).toBe(403);
    expect((await readJson(res)).error).toBe("forbidden");
  });

  test("mcp.enabled=false -> 403 even with the right token", async () => {
    const app = createApp(baseDeps({ settings: new FakeSettings({ mcp: { enabled: false, token: "the-real-token" } }) }));
    const res = await initialize(app, "the-real-token");
    expect(res.status).toBe(403);
    expect((await readJson(res)).error).toBe("mcp_disabled");
  });

  test("unset token -> 403 even with an empty bearer treated as no token (401) and a guessed one (403)", async () => {
    const app = createApp(baseDeps({ settings: new FakeSettings({ mcp: { enabled: true, token: "" } }) }));
    const guessed = await initialize(app, "anything");
    expect(guessed.status).toBe(403);
  });

  test("route is not mounted at all when AppDeps.mcp is unset", async () => {
    const app = createApp(baseDeps({ mcp: undefined }));
    const res = await initialize(app, "the-real-token");
    expect(res.status).toBe(404);
  });

  test("correct bearer token -> 200", async () => {
    const app = createApp(baseDeps());
    const res = await initialize(app, "the-real-token");
    expect(res.status).toBe(200);
  });
});

describe("/mcp full roundtrip", () => {
  test("initialize -> tools/list -> tools/call(get_system_status)", async () => {
    const app = createApp(baseDeps());

    const initRes = await initialize(app, "the-real-token");
    expect(initRes.status).toBe(200);
    const initBody = await readJson(initRes);
    expect(initBody.result.serverInfo.name).toBe("SmartSolarEMS");

    const listRes = await app.request("/mcp", {
      method: "POST",
      headers: { ...MCP_HEADERS, authorization: "Bearer the-real-token" },
      body: jsonRpc("tools/list", {}, 2),
    });
    expect(listRes.status).toBe(200);
    const listBody = await readJson(listRes);
    const toolNames: string[] = listBody.result.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toEqual(
      expect.arrayContaining([
        "get_system_status",
        "get_settings",
        "get_current_state",
        "get_latest_plan",
        "get_decisions",
        "get_prices",
        "get_telemetry",
        "get_forecast_accuracy",
        "list_overrides",
        "explain_decision",
      ]),
    );

    const callRes = await app.request("/mcp", {
      method: "POST",
      headers: { ...MCP_HEADERS, authorization: "Bearer the-real-token" },
      body: jsonRpc("tools/call", { name: "get_system_status", arguments: {} }, 3),
    });
    expect(callRes.status).toBe(200);
    const callBody = await readJson(callRes);
    expect(callBody.result.structuredContent.mode).toBe("shadow");
    expect(callBody.result.structuredContent.db.ok).toBe(true);
  });

  test("tools/call(explain_decision) with injected AppDeps fakes, no live DB involved", async () => {
    const decision: DecisionRow = {
      time: new Date("2026-07-06T09:00:00.000Z"),
      slot_start: new Date("2026-07-06T09:00:00.000Z"),
      mode: "shadow",
      action: "discharge_load",
      battery_power_w: -1500,
      soc_pct: 55,
      plan_id: 42,
      reason: "evening peak self-consumption",
      executed: false,
      error: null,
    };
    const plan: PlanWithSlots = {
      id: 42,
      created_at: new Date("2026-07-06T08:55:00.000Z"),
      mode: "shadow",
      current_soc_pct: 60,
      objective_cost_cents: 300,
      summary: { objective: "min_cost" },
      slots: [
        {
          slot_start: new Date("2026-07-06T09:00:00.000Z"),
          action: "discharge_load",
          battery_power_w: -1500,
          expected_soc_pct: 55,
          buy_price: 30,
          sell_price: 6,
          expected_load_wh: 500,
          expected_solar_wh: 0,
          expected_grid_wh: 0,
          reason: "evening peak self-consumption",
        },
      ],
    };

    const app = createApp(
      baseDeps({
        latestDecision: async () => decision,
        planById: async (id) => (id === 42 ? plan : null),
      }),
    );

    const res = await app.request("/mcp", {
      method: "POST",
      headers: { ...MCP_HEADERS, authorization: "Bearer the-real-token" },
      body: jsonRpc("tools/call", { name: "explain_decision", arguments: { at: "latest" } }, 4),
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    const structured = body.result.structuredContent;
    expect(structured.decision.action).toBe("discharge_load");
    expect(structured.decision.executed).toBe(false);
    expect(structured.plan.id).toBe(42);
    expect(structured.plan.surroundingSlots).toHaveLength(1);
  });
});

describe("GET/DELETE /mcp", () => {
  test("GET without text/event-stream Accept header is rejected (still authenticated first)", async () => {
    const app = createApp(baseDeps());
    const res = await app.request("/mcp", { method: "GET", headers: { authorization: "Bearer the-real-token" } });
    expect(res.status).toBe(406);
  });

  test("DELETE with a valid token succeeds (stateless: no session to actually terminate)", async () => {
    const app = createApp(baseDeps());
    const res = await app.request("/mcp", { method: "DELETE", headers: { authorization: "Bearer the-real-token" } });
    expect(res.status).toBe(200);
  });
});
