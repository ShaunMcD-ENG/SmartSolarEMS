import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import pkg from "../../package.json" with { type: "json" };
import type { OverrideStatus } from "../db/overrides";
import type { DecisionRow, PlanSlotRow, PriceRow } from "../db/repositories";
import { redactSettingsForClient } from "../server/api";
import type { McpToolDeps } from "./server";
import { latestDecision as dbLatestDecision, nearestDecision as dbNearestDecision, planById as dbPlanById } from "./queries";

const DAY_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * DAY_MS;
const THIRTY_DAYS_MS = 30 * DAY_MS;

/** Wraps a JSON-serialisable payload as both human-readable text and structured content. */
function jsonResult(data: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function parseDateOrThrow(label: string, value: string): Date {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid "${label}": ${value}`);
  return d;
}

/**
 * Resolves an optional from/to pair to concrete Dates: `to` defaults to now,
 * `from` defaults to `now - defaultSpanMs`, and the resulting span is clamped
 * to `capMs` (keeping the same `to`) so a caller can't request an
 * unboundedly large query.
 */
function resolveRange(
  from: string | undefined,
  to: string | undefined,
  now: Date,
  defaultSpanMs: number,
  capMs: number,
): { from: Date; to: Date } {
  const toDate = to ? parseDateOrThrow("to", to) : now;
  let fromDate = from ? parseDateOrThrow("from", from) : new Date(toDate.getTime() - defaultSpanMs);
  if (toDate.getTime() - fromDate.getTime() > capMs) {
    fromDate = new Date(toDate.getTime() - capMs);
  }
  return { from: fromDate, to: toDate };
}

/**
 * Finds the price row (of `channel`) that was in effect at `at`: prefers an
 * `interval_type: "current"` row, else the most recent row starting at or
 * before `at`, else the earliest row in the fetched window (covers the
 * "at" == very start of history edge case).
 */
async function priceAt(deps: McpToolDeps, channel: string, at: Date): Promise<PriceRow | null> {
  const windowMs = 35 * 60 * 1000; // Amber intervals are 5 min; 35 min covers clock skew + slow polling.
  const rows = await deps.repos.pricesBetween(new Date(at.getTime() - windowMs), new Date(at.getTime() + windowMs), channel);
  if (rows.length === 0) return null;
  const current = rows.find((r) => r.interval_type === "current");
  if (current) return current;
  const atOrBefore = rows
    .filter((r) => r.interval_start.getTime() <= at.getTime())
    .sort((a, b) => b.interval_start.getTime() - a.interval_start.getTime())[0];
  return atOrBefore ?? rows[0] ?? null;
}

function serializePlanSlot(slot: PlanSlotRow): Record<string, unknown> {
  return { ...slot, slot_start: slot.slot_start.toISOString() };
}

/** Registers every read-only audit tool on `server`. See src/mcp/server.ts for deps wiring. */
export function registerTools(server: McpServer, deps: McpToolDeps): void {
  const now = () => (deps.now ?? (() => new Date()))();
  const planById = deps.planById ?? dbPlanById;
  const latestDecision = deps.latestDecision ?? dbLatestDecision;
  const nearestDecision = deps.nearestDecision ?? dbNearestDecision;

  server.registerTool(
    "get_system_status",
    {
      title: "Get system status",
      description:
        "Current operating mode (shadow = decisions are computed and logged but NEVER sent to the " +
        "inverter; active = the executor writes real charge/discharge commands), Modbus telemetry " +
        "poller and Amber price poller health, executor status (including any engaged fail-safe), " +
        "database reachability, first-boot state, process uptime (seconds), and app version. Start " +
        "here to establish overall context before auditing specific decisions.",
    },
    async () => {
      let mode: "shadow" | "active" = "shadow";
      let dbOk = true;
      let firstBoot = true;
      try {
        const modeSetting = await deps.settings.get("mode");
        mode = modeSetting?.shadow === false ? "active" : "shadow";
        firstBoot = await deps.settings.isFirstBoot();
      } catch {
        dbOk = false;
      }

      return jsonResult({
        mode,
        modbus: deps.pollers.modbus.status(),
        amber: deps.pollers.amber.status(),
        executor: deps.executor?.status() ?? null,
        db: { ok: dbOk },
        firstBoot,
        version: deps.version ?? pkg.version ?? "0.0.0",
        uptimeSeconds: Math.floor(process.uptime()),
      });
    },
  );

  server.registerTool(
    "get_settings",
    {
      title: "Get settings",
      description:
        "All configured settings (Sigenergy connection, Amber account, battery capacity/limits, " +
        "goals, demand window, mode, pricing, MCP audit access) with every secret field masked to " +
        "its last 4 characters (empty string if unset) — the admin password hash is never returned " +
        "at all. Use this to audit *configuration* (is the reserve SOC sane? is the demand window " +
        "correct?), not to retrieve credentials.",
    },
    async () => {
      const all = await deps.settings.getAll();
      return jsonResult(redactSettingsForClient(all));
    },
  );

  server.registerTool(
    "get_current_state",
    {
      title: "Get current state",
      description:
        "Latest telemetry sample plus the buy/sell prices currently in effect and the battery's " +
        "state of charge relative to its configured reserve floor. Units: power in watts " +
        "(battery_power_w: +charge / -discharge; grid_power_w: +import / -export), battery_soc_pct " +
        "in percent (0-100), prices in cents/kWh AUD (sellPerKwh is normalised positive = you EARN " +
        "that much per kWh exported, not a cost).",
    },
    async () => {
      const at = now();
      const [telemetry, buy, sell, battery] = await Promise.all([
        deps.repos.latestTelemetry(),
        priceAt(deps, "general", at),
        priceAt(deps, "feedIn", at),
        deps.settings.get("battery"),
      ]);

      const socPct = telemetry?.battery_soc_pct ?? null;
      const reserveFloorPct = battery?.usableMinSocPct ?? null;

      return jsonResult({
        telemetry: telemetry ? { ...telemetry, time: telemetry.time.toISOString() } : null,
        prices: {
          buyPerKwh: buy?.per_kwh ?? null,
          sellPerKwh: sell?.per_kwh ?? null,
        },
        battery: {
          socPct,
          reserveFloorPct,
          socAboveReservePct: socPct !== null && reserveFloorPct !== null ? socPct - reserveFloorPct : null,
        },
      });
    },
  );

  server.registerTool(
    "get_latest_plan",
    {
      title: "Get latest plan",
      description:
        "The most recently computed 24h rolling plan (replanned every 5 minutes) — this is the " +
        "system's intent, not necessarily what was executed (see get_decisions/explain_decision for " +
        "that). Each slot is 5 minutes: action is one of charge_solar/charge_grid/discharge_load/" +
        "discharge_grid/idle/self_consume; battery_power_w follows +charge/-discharge; buy_price and " +
        "sell_price are cents/kWh (sell positive = earn); expected_*_wh are forecast energy in " +
        "watt-hours for that slot.",
      inputSchema: {
        max_slots: z
          .number()
          .int()
          .positive()
          .max(288)
          .optional()
          .describe("Max number of slots to return, earliest-first. Defaults to 48 (4 hours)."),
      },
    },
    async ({ max_slots }) => {
      const plan = await deps.repos.latestPlan();
      if (!plan) return jsonResult({ plan: null });

      const limit = max_slots ?? 48;
      return jsonResult({
        id: plan.id,
        created_at: plan.created_at.toISOString(),
        mode: plan.mode,
        current_soc_pct: plan.current_soc_pct,
        objective_cost_cents: plan.objective_cost_cents,
        summary: plan.summary,
        totalSlots: plan.slots.length,
        slots: plan.slots.slice(0, limit).map(serializePlanSlot),
      });
    },
  );

  server.registerTool(
    "get_decisions",
    {
      title: "Get decisions",
      description:
        "What the executor actually did each tick (as opposed to get_latest_plan's intent). " +
        "executed=false means the decision was logged only (shadow mode, or a safety/error abort) — " +
        "it was NEVER sent to the inverter. battery_power_w: +charge/-discharge, soc_pct: percent. " +
        "Defaults to the last 24 hours; range is capped at 7 days.",
      inputSchema: {
        from: z.string().optional().describe("ISO 8601 start time. Defaults to 24h before `to`."),
        to: z.string().optional().describe("ISO 8601 end time. Defaults to now."),
      },
    },
    async ({ from, to }) => {
      const range = resolveRange(from, to, now(), DAY_MS, SEVEN_DAYS_MS);
      const rows = await deps.repos.decisionsBetween(range.from, range.to);
      return jsonResult({
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        rows: rows.map(serializeDecision),
      });
    },
  );

  server.registerTool(
    "get_prices",
    {
      title: "Get prices",
      description:
        "Amber price rows for a channel over a time range. per_kwh is normalised so buy = cost you " +
        "pay and sell (channel=feedIn) is positive = cents you EARN per kWh exported (Amber's raw " +
        "feedIn sign is inverted at ingest). interval_type is 'forecast' | 'current' | 'actual'. " +
        "Defaults to the last 24 hours; range is capped at 31 days.",
      inputSchema: {
        from: z.string().optional().describe("ISO 8601 start time. Defaults to 24h before `to`."),
        to: z.string().optional().describe("ISO 8601 end time. Defaults to now."),
        channel: z.enum(["general", "feedIn", "controlledLoad"]).optional().describe("Defaults to 'general'."),
      },
    },
    async ({ from, to, channel }) => {
      const range = resolveRange(from, to, now(), DAY_MS, 31 * DAY_MS);
      const rows = await deps.repos.pricesBetween(range.from, range.to, channel ?? "general");
      return jsonResult({
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        channel: channel ?? "general",
        rows: rows.map((r) => ({ ...r, interval_start: r.interval_start.toISOString(), updated_at: r.updated_at.toISOString() })),
      });
    },
  );

  server.registerTool(
    "get_telemetry",
    {
      title: "Get telemetry",
      description:
        "5-minute aggregated telemetry (avg power per channel plus integrated energy in Wh). " +
        "Units: power in watts (battery: +charge/-discharge, grid: +import/-export), " +
        "battery_soc_pct_avg/last in percent. Defaults to the last 24 hours; range is capped at 7 days.",
      inputSchema: {
        from: z.string().optional().describe("ISO 8601 start time. Defaults to 24h before `to`."),
        to: z.string().optional().describe("ISO 8601 end time. Defaults to now."),
      },
    },
    async ({ from, to }) => {
      const range = resolveRange(from, to, now(), DAY_MS, SEVEN_DAYS_MS);
      const rows = await deps.repos.telemetry5mBetween(range.from, range.to);
      return jsonResult({
        from: range.from.toISOString(),
        to: range.to.toISOString(),
        rows: rows.map((r) => ({ ...r, bucket: r.bucket.toISOString() })),
      });
    },
  );

  server.registerTool(
    "get_forecast_accuracy",
    {
      title: "Get forecast accuracy",
      description:
        "Scores previously-snapshotted load/solar forecasts against actual telemetry, grouped by " +
        "horizon bucket (0-1h/1-4h/4-12h/12-24h). mape is mean absolute percentage error (percent); " +
        "biasWh is mean (forecast - actual) in Wh, positive = over-forecasting. Defaults to the last " +
        "7 days; range is capped at 30 days.",
      inputSchema: {
        from: z.string().optional().describe("ISO 8601 start time. Defaults to 7 days before `to`."),
        to: z.string().optional().describe("ISO 8601 end time. Defaults to now."),
      },
    },
    async ({ from, to }) => {
      const range = resolveRange(from, to, now(), SEVEN_DAYS_MS, THIRTY_DAYS_MS);
      const result = await deps.forecastService.accuracy(range.from, range.to);
      return jsonResult({ from: range.from.toISOString(), to: range.to.toISOString(), ...result });
    },
  );

  server.registerTool(
    "list_overrides",
    {
      title: "List overrides",
      description:
        "User-scheduled manual overrides (e.g. \"charge 9 kWh starting 01:00\"). These beat all " +
        "automatic planner behaviour EXCEPT the configured demand window, unless the override was " +
        "explicitly double-confirmed to continue into it (override_demand_window=true). " +
        "status: pending|active|completed|cancelled|expired.",
      inputSchema: {
        status: z
          .enum(["pending", "active", "completed", "cancelled", "expired"])
          .optional()
          .describe("Filter to a single status; omit to list all (most recent first)."),
      },
    },
    async ({ status }) => {
      const rows = await deps.overridesRepo.listOverrides(status ? { statuses: [status as OverrideStatus] } : {});
      return jsonResult({
        rows: rows.map((r) => ({
          ...r,
          created_at: r.created_at.toISOString(),
          start_time: r.start_time.toISOString(),
          end_time: r.end_time ? r.end_time.toISOString() : null,
        })),
      });
    },
  );

  server.registerTool(
    "explain_decision",
    {
      title: "Explain decision",
      description:
        "The single most useful audit tool: given a decision time (or \"latest\"), returns that " +
        "decision row, the plan that produced it (matched via plan_id) with the ±6 surrounding slots, " +
        "the buy/sell prices in effect at that time, and nearby telemetry — everything needed to judge " +
        "whether the executor's logic was sound. executed=false means shadow-mode/logged-only (never " +
        "sent to the inverter). Sign conventions: battery_power_w +charge/-discharge, grid_power_w " +
        "+import/-export, sell price positive = earn.",
      inputSchema: {
        at: z
          .string()
          .optional()
          .describe('ISO 8601 timestamp to find the nearest decision to, or "latest" (default) for the most recent decision.'),
      },
    },
    async ({ at }) => {
      const target = !at || at === "latest" ? null : parseDateOrThrow("at", at);
      const decision = target === null ? await latestDecision() : await nearestDecision(target);

      if (!decision) {
        return jsonResult({ query: { at: at ?? "latest" }, decision: null, message: "no decision rows found" });
      }

      const decisionTime = decision.time;
      const [plan, buy, sell, telemetryWindow] = await Promise.all([
        decision.plan_id !== null ? planById(decision.plan_id) : Promise.resolve(null),
        priceAt(deps, "general", decisionTime),
        priceAt(deps, "feedIn", decisionTime),
        deps.repos.telemetryBetween(new Date(decisionTime.getTime() - 15 * 60 * 1000), new Date(decisionTime.getTime() + 15 * 60 * 1000)),
      ]);

      let planSummary: Record<string, unknown> | null = null;
      if (plan) {
        const targetSlotTime = decision.slot_start?.getTime() ?? decisionTime.getTime();
        let matchIdx = plan.slots.findIndex((s) => s.slot_start.getTime() === targetSlotTime);
        if (matchIdx === -1) {
          // Fall back to the slot closest in time, so a decision whose slot_start
          // doesn't exactly line up with the plan (clock skew, replanning) still
          // gets useful surrounding context rather than none at all.
          let bestDiff = Infinity;
          plan.slots.forEach((s, i) => {
            const diff = Math.abs(s.slot_start.getTime() - targetSlotTime);
            if (diff < bestDiff) {
              bestDiff = diff;
              matchIdx = i;
            }
          });
        }
        const windowSlots =
          matchIdx === -1 ? plan.slots : plan.slots.slice(Math.max(0, matchIdx - 6), matchIdx + 7);

        planSummary = {
          id: plan.id,
          created_at: plan.created_at.toISOString(),
          mode: plan.mode,
          current_soc_pct: plan.current_soc_pct,
          objective_cost_cents: plan.objective_cost_cents,
          summary: plan.summary,
          matchedSlotStart: matchIdx !== -1 ? plan.slots[matchIdx]?.slot_start.toISOString() : null,
          surroundingSlots: windowSlots.map(serializePlanSlot),
        };
      }

      return jsonResult({
        query: { at: at ?? "latest", resolvedTime: decisionTime.toISOString() },
        decision: serializeDecision(decision),
        plan: planSummary,
        prices: { buyPerKwh: buy?.per_kwh ?? null, sellPerKwh: sell?.per_kwh ?? null },
        telemetryContext: telemetryWindow.map((t) => ({ ...t, time: t.time.toISOString() })),
      });
    },
  );
}

function serializeDecision(row: DecisionRow): Record<string, unknown> {
  return {
    ...row,
    time: row.time.toISOString(),
    slot_start: row.slot_start ? row.slot_start.toISOString() : null,
  };
}
