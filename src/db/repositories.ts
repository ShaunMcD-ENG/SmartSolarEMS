import type { Sql } from "./client";
import { getDb } from "./client";

// Row shapes mirror the DB columns (snake_case) directly: these are thin,
// typed wrappers around parameterised SQL, not a camelCase mapping layer.

/** JSON-serialisable value, for jsonb columns (extra/summary/payload). */
export type Json = null | string | number | boolean | Json[] | { [key: string]: Json | undefined };

export interface TelemetryRow {
  time: Date;
  pv_power_w: number | null;
  battery_power_w: number | null;
  battery_soc_pct: number | null;
  grid_power_w: number | null;
  load_power_w: number | null;
  ems_mode: number | null;
  extra: Json | null;
}

export interface PriceRow {
  interval_start: Date;
  channel: string;
  per_kwh: number;
  spot_per_kwh: number | null;
  renewables: number | null;
  spike_status: string | null;
  interval_type: string;
  estimate: boolean | null;
  updated_at: Date;
}

export interface PriceForecastSnapshotRow {
  fetched_at: Date;
  channel: string;
  payload: Json;
}

export interface ForecastRow {
  created_at: Date;
  target_start: Date;
  kind: "load" | "solar";
  energy_wh: number | null;
  model: string | null;
}

export interface PlanInput {
  mode: string;
  current_soc_pct: number | null;
  objective_cost_cents: number | null;
  summary: Json | null;
}

export interface PlanSlotRow {
  slot_start: Date;
  action:
    | "charge_solar"
    | "charge_grid"
    | "discharge_load"
    | "discharge_grid"
    | "idle"
    | "self_consume";
  battery_power_w: number | null;
  expected_soc_pct: number | null;
  buy_price: number | null;
  sell_price: number | null;
  expected_load_wh: number | null;
  expected_solar_wh: number | null;
  expected_grid_wh: number | null;
  reason: string | null;
}

export interface PlanWithSlots extends PlanInput {
  id: number;
  created_at: Date;
  slots: PlanSlotRow[];
}

export interface DecisionRow {
  time: Date;
  slot_start: Date | null;
  mode: "shadow" | "active";
  action: string | null;
  battery_power_w: number | null;
  soc_pct: number | null;
  plan_id: number | null;
  reason: string | null;
  executed: boolean | null;
  error: string | null;
}

export interface Telemetry5mRow {
  bucket: Date;
  pv_power_w_avg: number | null;
  battery_power_w_avg: number | null;
  grid_power_w_avg: number | null;
  load_power_w_avg: number | null;
  battery_soc_pct_avg: number | null;
  battery_soc_pct_last: number | null;
  pv_energy_wh: number | null;
  battery_energy_wh: number | null;
  grid_energy_wh: number | null;
  load_energy_wh: number | null;
}

/** bigint columns (oid 20) come back from `postgres` as strings; normalise to number. */
function toNum(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

export async function insertTelemetry(row: TelemetryRow, sql: Sql = getDb()): Promise<void> {
  await sql`
    INSERT INTO telemetry (
      time, pv_power_w, battery_power_w, battery_soc_pct, grid_power_w, load_power_w, ems_mode, extra
    ) VALUES (
      ${row.time}, ${row.pv_power_w}, ${row.battery_power_w}, ${row.battery_soc_pct},
      ${row.grid_power_w}, ${row.load_power_w}, ${row.ems_mode},
      ${row.extra === null ? null : sql.json(row.extra)}
    )
  `;
}

/** Upserts prices: keeps the latest value per (interval_start, channel). */
export async function upsertPrices(rows: PriceRow[], sql: Sql = getDb()): Promise<void> {
  if (rows.length === 0) return;
  await sql`
    INSERT INTO prices ${sql(
      rows,
      "interval_start",
      "channel",
      "per_kwh",
      "spot_per_kwh",
      "renewables",
      "spike_status",
      "interval_type",
      "estimate",
      "updated_at",
    )}
    ON CONFLICT (interval_start, channel) DO UPDATE SET
      per_kwh = EXCLUDED.per_kwh,
      spot_per_kwh = EXCLUDED.spot_per_kwh,
      renewables = EXCLUDED.renewables,
      spike_status = EXCLUDED.spike_status,
      interval_type = EXCLUDED.interval_type,
      estimate = EXCLUDED.estimate,
      updated_at = EXCLUDED.updated_at
  `;
}

export async function insertForecastSnapshot(
  row: PriceForecastSnapshotRow,
  sql: Sql = getDb(),
): Promise<void> {
  await sql`
    INSERT INTO price_forecast_snapshots (fetched_at, channel, payload)
    VALUES (${row.fetched_at}, ${row.channel}, ${sql.json(row.payload)})
  `;
}

export async function insertForecasts(rows: ForecastRow[], sql: Sql = getDb()): Promise<void> {
  if (rows.length === 0) return;
  await sql`
    INSERT INTO forecasts ${sql(rows, "created_at", "target_start", "kind", "energy_wh", "model")}
  `;
}

/** Inserts a plan and its slots in one transaction; returns the new plan id. */
export async function insertPlan(
  plan: PlanInput,
  slots: PlanSlotRow[],
  sql: Sql = getDb(),
): Promise<number> {
  return sql.begin(async (tx) => {
    const [inserted] = await tx<{ id: string }[]>`
      INSERT INTO plans (mode, current_soc_pct, objective_cost_cents, summary)
      VALUES (
        ${plan.mode}, ${plan.current_soc_pct}, ${plan.objective_cost_cents},
        ${plan.summary === null || plan.summary === undefined ? null : tx.json(plan.summary)}
      )
      RETURNING id
    `;
    if (!inserted) throw new Error("insertPlan: INSERT ... RETURNING id returned no row");
    const planId = Number(inserted.id);

    if (slots.length > 0) {
      const slotRows = slots.map((slot) => ({ ...slot, plan_id: planId }));
      await tx`
        INSERT INTO plan_slots ${tx(
          slotRows,
          "plan_id",
          "slot_start",
          "action",
          "battery_power_w",
          "expected_soc_pct",
          "buy_price",
          "sell_price",
          "expected_load_wh",
          "expected_solar_wh",
          "expected_grid_wh",
          "reason",
        )}
      `;
    }

    return planId;
  });
}

export async function insertDecision(row: DecisionRow, sql: Sql = getDb()): Promise<void> {
  await sql`
    INSERT INTO decisions (
      time, slot_start, mode, action, battery_power_w, soc_pct, plan_id, reason, executed, error
    ) VALUES (
      ${row.time}, ${row.slot_start}, ${row.mode}, ${row.action}, ${row.battery_power_w},
      ${row.soc_pct}, ${row.plan_id}, ${row.reason}, ${row.executed}, ${row.error}
    )
  `;
}

export async function latestTelemetry(sql: Sql = getDb()): Promise<TelemetryRow | null> {
  const [row] = await sql<TelemetryRow[]>`
    SELECT time, pv_power_w, battery_power_w, battery_soc_pct, grid_power_w, load_power_w, ems_mode, extra
    FROM telemetry
    ORDER BY time DESC
    LIMIT 1
  `;
  return row ?? null;
}

export async function pricesBetween(
  from: Date,
  to: Date,
  channel: string,
  sql: Sql = getDb(),
): Promise<PriceRow[]> {
  return sql<PriceRow[]>`
    SELECT interval_start, channel, per_kwh, spot_per_kwh, renewables, spike_status,
           interval_type, estimate, updated_at
    FROM prices
    WHERE interval_start BETWEEN ${from} AND ${to} AND channel = ${channel}
    ORDER BY interval_start
  `;
}

export async function latestPlan(sql: Sql = getDb()): Promise<PlanWithSlots | null> {
  const [plan] = await sql<
    { id: string; created_at: Date; mode: string; current_soc_pct: number | null; objective_cost_cents: number | null; summary: Json }[]
  >`
    SELECT id, created_at, mode, current_soc_pct, objective_cost_cents, summary
    FROM plans
    ORDER BY created_at DESC
    LIMIT 1
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

export async function decisionsBetween(
  from: Date,
  to: Date,
  sql: Sql = getDb(),
): Promise<DecisionRow[]> {
  const rows = await sql<(Omit<DecisionRow, "plan_id"> & { plan_id: string | null })[]>`
    SELECT time, slot_start, mode, action, battery_power_w, soc_pct, plan_id, reason, executed, error
    FROM decisions
    WHERE time BETWEEN ${from} AND ${to}
    ORDER BY time
  `;
  return rows.map((row) => ({ ...row, plan_id: toNum(row.plan_id) }));
}

export async function telemetry5mBetween(
  from: Date,
  to: Date,
  sql: Sql = getDb(),
): Promise<Telemetry5mRow[]> {
  return sql<Telemetry5mRow[]>`
    SELECT bucket, pv_power_w_avg, battery_power_w_avg, grid_power_w_avg, load_power_w_avg,
           battery_soc_pct_avg, battery_soc_pct_last, pv_energy_wh, battery_energy_wh,
           grid_energy_wh, load_energy_wh
    FROM telemetry_5m
    WHERE bucket BETWEEN ${from} AND ${to}
    ORDER BY bucket
  `;
}
