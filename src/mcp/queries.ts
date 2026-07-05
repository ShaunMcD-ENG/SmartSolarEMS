import type { Sql } from "../db/client";
import { getDb } from "../db/client";
import type { DecisionRow, Json, PlanSlotRow, PlanWithSlots } from "../db/repositories";

// Small, read-only queries the MCP audit tools need that aren't already
// exposed by src/db/repositories.ts (which this file deliberately does not
// modify — see src/mcp/server.ts doc comment for why). Mirrors the query
// shape of latestPlan()/decisionsBetween() in repositories.ts exactly, just
// keyed differently (by id / nearest-time rather than "latest").

/** bigint columns (oid 20) come back from `postgres` as strings; normalise to number. */
function toNum(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

/** Fetches one plan (with its slots) by id, for explain_decision's plan_id match. Null if not found. */
export async function planById(id: number, sql: Sql = getDb()): Promise<PlanWithSlots | null> {
  const [plan] = await sql<
    {
      id: string;
      created_at: Date;
      mode: string;
      current_soc_pct: number | null;
      objective_cost_cents: number | null;
      summary: Json;
    }[]
  >`
    SELECT id, created_at, mode, current_soc_pct, objective_cost_cents, summary
    FROM plans
    WHERE id = ${id}
  `;
  if (!plan) return null;

  const slots = await sql<PlanSlotRow[]>`
    SELECT slot_start, action, battery_power_w, expected_soc_pct, buy_price, sell_price,
           expected_load_wh, expected_solar_wh, expected_grid_wh, reason
    FROM plan_slots
    WHERE plan_id = ${plan.id}
    ORDER BY slot_start
  `;

  return {
    id: Number(plan.id),
    created_at: plan.created_at,
    mode: plan.mode,
    current_soc_pct: plan.current_soc_pct,
    objective_cost_cents: plan.objective_cost_cents,
    summary: plan.summary,
    slots,
  };
}

/** Most recent decision row, or null if the decisions table is empty. */
export async function latestDecision(sql: Sql = getDb()): Promise<DecisionRow | null> {
  const [row] = await sql<(Omit<DecisionRow, "plan_id"> & { plan_id: string | null })[]>`
    SELECT time, slot_start, mode, action, battery_power_w, soc_pct, plan_id, reason, executed, error
    FROM decisions
    ORDER BY time DESC
    LIMIT 1
  `;
  return row ? { ...row, plan_id: toNum(row.plan_id) } : null;
}

/** Decision row whose `time` is closest to `target` (either side), or null if none exist. */
export async function nearestDecision(target: Date, sql: Sql = getDb()): Promise<DecisionRow | null> {
  const [row] = await sql<(Omit<DecisionRow, "plan_id"> & { plan_id: string | null })[]>`
    SELECT time, slot_start, mode, action, battery_power_w, soc_pct, plan_id, reason, executed, error
    FROM decisions
    ORDER BY abs(extract(epoch from (time - ${target})))
    LIMIT 1
  `;
  return row ? { ...row, plan_id: toNum(row.plan_id) } : null;
}
