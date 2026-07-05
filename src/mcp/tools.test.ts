import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, test } from "bun:test";
import type { DecisionRow, PlanSlotRow, PlanWithSlots, PriceRow, TelemetryRow } from "../db/repositories";
import { buildMcpServer, type McpToolDeps } from "./server";
import { FakeSettings, fakeForecastService, fakeOverridesRepo, fakePollers, fakeRepos } from "./test-helpers";

/** Connects a fresh in-process client/server pair for one test, using `deps`. */
async function connect(deps: McpToolDeps): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = buildMcpServer(deps);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, close: async () => Promise.all([client.close(), server.close()]).then(() => undefined) };
}

/** Calls a tool and returns its parsed structuredContent (never the raw text blob). */
async function callTool(client: Client, name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError).not.toBe(true);
  return result.structuredContent;
}

function baseDeps(overrides: Partial<McpToolDeps> = {}): McpToolDeps {
  return {
    settings: new FakeSettings(),
    pollers: fakePollers(),
    forecastService: fakeForecastService(),
    repos: fakeRepos(),
    overridesRepo: fakeOverridesRepo(),
    now: () => new Date("2026-07-06T12:00:00.000Z"),
    ...overrides,
  };
}

describe("get_system_status", () => {
  test("reports shadow mode by default and active when mode.shadow=false", async () => {
    const { client, close } = await connect(baseDeps({ settings: new FakeSettings({ mode: { shadow: false } }) }));
    const status = await callTool(client, "get_system_status");
    expect(status.mode).toBe("active");
    expect(status.db.ok).toBe(true);
    await close();
  });

  test("includes executor status when present, null otherwise", async () => {
    const executorStatus = {
      running: true,
      mode: "shadow" as const,
      lastTick: null,
      lastAction: null,
      lastError: null,
      consecutiveModbusFailures: 0,
      failSafeEngaged: false,
    };
    const { client, close } = await connect(baseDeps({ executor: { status: () => executorStatus } }));
    const status = await callTool(client, "get_system_status");
    expect(status.executor).toEqual(executorStatus);
    await close();
  });
});

describe("get_settings", () => {
  test("masks amber.apiToken and mcp.token, drops admin_password_hash entirely", async () => {
    const settings = new FakeSettings({
      admin_password_hash: "argon2-hash-value",
      amber: { apiToken: "sk-live-1234567890", siteId: "site-1", pollIntervalMs: 300000 },
      mcp: { enabled: true, token: "super-secret-token-abcdef" },
    });
    const { client, close } = await connect(baseDeps({ settings }));
    const result = await callTool(client, "get_settings");

    expect(result.admin_password_hash).toBeUndefined();
    expect(result.adminPasswordSet).toBe(true);
    expect(result.amber.apiToken).not.toContain("1234567890");
    expect(result.amber.apiToken).toContain("7890");
    expect(result.mcp.token).not.toContain("super-secret-token-abcdef");
    expect(result.mcp.token).toContain("cdef");
    expect(result.mcp.enabled).toBe(true);
    await close();
  });

  test("the raw secret never appears anywhere in the tool's text content either", async () => {
    const settings = new FakeSettings({
      mcp: { enabled: true, token: "super-secret-token-abcdef" },
    });
    const { client, close } = await connect(baseDeps({ settings }));
    const result = await client.callTool({ name: "get_settings", arguments: {} });
    const text = (result.content as { type: string; text: string }[])[0]!.text;
    expect(text).not.toContain("super-secret-token-abcdef");
    await close();
  });
});

describe("get_current_state", () => {
  test("computes SOC above reserve floor from telemetry + battery settings", async () => {
    const telemetry: TelemetryRow = {
      time: new Date("2026-07-06T11:59:00.000Z"),
      pv_power_w: 2000,
      battery_power_w: -500,
      battery_soc_pct: 42,
      grid_power_w: -100,
      load_power_w: 1400,
      ems_mode: 1,
      extra: null,
    };
    const buyRow: PriceRow = {
      interval_start: new Date("2026-07-06T11:55:00.000Z"),
      channel: "general",
      per_kwh: 25.5,
      spot_per_kwh: 20,
      renewables: 60,
      spike_status: null,
      interval_type: "current",
      estimate: false,
      updated_at: new Date("2026-07-06T11:55:30.000Z"),
    };
    const sellRow: PriceRow = { ...buyRow, channel: "feedIn", per_kwh: 8.2 };

    const deps = baseDeps({
      settings: new FakeSettings({ battery: { capacityWh: 10000, usableMinSocPct: 10, maxChargeW: 5000, maxDischargeW: 5000, roundTripEfficiency: 0.9 } }),
      repos: fakeRepos({
        latestTelemetry: async () => telemetry,
        pricesBetween: async (_from, _to, channel) => (channel === "general" ? [buyRow] : [sellRow]),
      }),
    });
    const { client, close } = await connect(deps);
    const result = await callTool(client, "get_current_state");

    expect(result.telemetry.battery_soc_pct).toBe(42);
    expect(result.prices.buyPerKwh).toBe(25.5);
    expect(result.prices.sellPerKwh).toBe(8.2);
    expect(result.battery.reserveFloorPct).toBe(10);
    expect(result.battery.socAboveReservePct).toBe(32);
    await close();
  });
});

function makeSlot(minutesFromEpoch: number, action: PlanSlotRow["action"] = "idle"): PlanSlotRow {
  return {
    slot_start: new Date(minutesFromEpoch * 60_000),
    action,
    battery_power_w: 0,
    expected_soc_pct: 50,
    buy_price: 20,
    sell_price: 5,
    expected_load_wh: 100,
    expected_solar_wh: 0,
    reason: null,
    expected_grid_wh: 100,
  };
}

describe("get_latest_plan", () => {
  test("returns null plan when none exists", async () => {
    const { client, close } = await connect(baseDeps());
    const result = await callTool(client, "get_latest_plan");
    expect(result.plan).toBeNull();
    await close();
  });

  test("defaults to 48 slots and respects max_slots", async () => {
    const slots = Array.from({ length: 100 }, (_, i) => makeSlot(i * 5));
    const plan: PlanWithSlots = {
      id: 7,
      created_at: new Date("2026-07-06T12:00:00.000Z"),
      mode: "shadow",
      current_soc_pct: 50,
      objective_cost_cents: 123.4,
      summary: { objective: "min_cost" },
      slots,
    };
    const { client, close } = await connect(baseDeps({ repos: fakeRepos({ latestPlan: async () => plan }) }));

    const withDefault = await callTool(client, "get_latest_plan");
    expect(withDefault.totalSlots).toBe(100);
    expect(withDefault.slots).toHaveLength(48);

    const withMax = await callTool(client, "get_latest_plan", { max_slots: 5 });
    expect(withMax.slots).toHaveLength(5);
    await close();
  });
});

describe("get_decisions", () => {
  test("defaults to the last 24h ending at `now`, capped at 7 days", async () => {
    let seenFrom: Date | null = null;
    let seenTo: Date | null = null;
    const deps = baseDeps({
      repos: fakeRepos({
        decisionsBetween: async (from, to) => {
          seenFrom = from;
          seenTo = to;
          return [];
        },
      }),
    });
    const { client, close } = await connect(deps);
    await callTool(client, "get_decisions");
    expect(seenTo!.toISOString()).toBe("2026-07-06T12:00:00.000Z");
    expect(seenFrom!.toISOString()).toBe("2026-07-05T12:00:00.000Z");

    await callTool(client, "get_decisions", { from: "2000-01-01T00:00:00.000Z" });
    expect(seenFrom!.toISOString()).toBe("2026-06-29T12:00:00.000Z"); // clamped to 7 days before `to`
    await close();
  });
});

describe("get_prices", () => {
  test("defaults channel to general and passes it through", async () => {
    const captured: { channel: string | null } = { channel: null };
    const deps = baseDeps({
      repos: fakeRepos({
        pricesBetween: async (_f, _t, channel) => {
          captured.channel = channel;
          return [];
        },
      }),
    });
    const { client, close } = await connect(deps);
    await callTool(client, "get_prices");
    expect(captured.channel).toBe("general");

    await callTool(client, "get_prices", { channel: "feedIn" });
    expect(captured.channel).toBe("feedIn");
    await close();
  });
});

describe("list_overrides", () => {
  test("passes a single status filter through to the repo", async () => {
    let seenOpts: unknown = null;
    const deps = baseDeps({
      overridesRepo: fakeOverridesRepo({
        listOverrides: async (opts) => {
          seenOpts = opts;
          return [];
        },
      }),
    });
    const { client, close } = await connect(deps);
    await callTool(client, "list_overrides", { status: "active" });
    expect(seenOpts).toEqual({ statuses: ["active"] });
    await close();
  });
});

describe("explain_decision", () => {
  const decision: DecisionRow = {
    time: new Date("2026-07-06T11:30:00.000Z"),
    slot_start: new Date("2026-07-06T11:30:00.000Z"),
    mode: "shadow",
    action: "charge_grid",
    battery_power_w: 2000,
    soc_pct: 40,
    plan_id: 9,
    reason: "cheapest overnight window",
    executed: false,
    error: null,
  };
  const plan: PlanWithSlots = {
    id: 9,
    created_at: new Date("2026-07-06T11:00:00.000Z"),
    mode: "shadow",
    current_soc_pct: 38,
    objective_cost_cents: 50,
    summary: { objective: "min_cost" },
    slots: Array.from({ length: 20 }, (_, i) => makeSlot(new Date("2026-07-06T11:00:00.000Z").getTime() / 60_000 + i * 5)),
  };

  test("\"latest\" resolves via the injected latestDecision seam and matches the plan by plan_id", async () => {
    const deps = baseDeps({
      latestDecision: async () => decision,
      planById: async (id) => (id === 9 ? plan : null),
    });
    const { client, close } = await connect(deps);
    const result = await callTool(client, "explain_decision", { at: "latest" });

    expect(result.decision.action).toBe("charge_grid");
    expect(result.decision.executed).toBe(false);
    expect(result.plan.id).toBe(9);
    expect(result.plan.surroundingSlots.length).toBeGreaterThan(0);
    expect(result.plan.surroundingSlots.length).toBeLessThanOrEqual(13); // +/-6 plus the matched slot
    await close();
  });

  test("explicit ISO time resolves via nearestDecision", async () => {
    let seenTarget: Date | null = null;
    const deps = baseDeps({
      nearestDecision: async (target) => {
        seenTarget = target;
        return decision;
      },
      planById: async () => plan,
    });
    const { client, close } = await connect(deps);
    await callTool(client, "explain_decision", { at: "2026-07-06T11:31:00.000Z" });
    expect(seenTarget!.toISOString()).toBe("2026-07-06T11:31:00.000Z");
    await close();
  });

  test("returns decision: null with a message when no decisions exist", async () => {
    const deps = baseDeps({ latestDecision: async () => null });
    const { client, close } = await connect(deps);
    const result = await callTool(client, "explain_decision", {});
    expect(result.decision).toBeNull();
    expect(typeof result.message).toBe("string");
    await close();
  });
});
