import { afterEach, describe, expect, test } from "bun:test";
import { getDb } from "./client";
import {
  decisionsBetween,
  insertDecision,
  insertForecasts,
  insertForecastSnapshot,
  insertPlan,
  insertTelemetry,
  latestPlan,
  latestTelemetry,
  pricesBetween,
  telemetry5mBetween,
  telemetryBetween,
  upsertPrices,
} from "./repositories";
import { isDbAvailable } from "./test-helpers";

const sql = getDb();
const dbAvailable = await isDbAvailable(sql);

// All test data lives far in the future so it never collides with real
// telemetry/prices/plans/decisions in the shared dev DB, and is trivially
// identifiable for cleanup.
const MARKER_CHANNEL = "test_marker_channel";
const MARKER_TIME = new Date("2099-06-01T00:00:00Z");
const MARKER_TIME_2 = new Date("2099-06-02T00:00:00Z");
const MARKER_KIND = "load" as const;

// plans.created_at defaults to now() server-side (insertPlan doesn't accept an
// override), so marker timestamps can't identify test-created plan rows.
// Track ids returned by insertPlan() instead and delete precisely those.
const createdPlanIds: number[] = [];

async function trackedInsertPlan(
  ...args: Parameters<typeof insertPlan>
): ReturnType<typeof insertPlan> {
  const id = await insertPlan(...args);
  createdPlanIds.push(id);
  return id;
}

async function cleanup(): Promise<void> {
  await sql`DELETE FROM telemetry WHERE time >= ${new Date("2099-01-01T00:00:00Z")}`;
  await sql`DELETE FROM prices WHERE channel = ${MARKER_CHANNEL}`;
  await sql`DELETE FROM price_forecast_snapshots WHERE channel = ${MARKER_CHANNEL}`;
  await sql`DELETE FROM forecasts WHERE kind = ${MARKER_KIND} AND created_at >= ${new Date("2099-01-01T00:00:00Z")}`;
  await sql`DELETE FROM decisions WHERE time >= ${new Date("2099-01-01T00:00:00Z")}`;
  if (createdPlanIds.length > 0) {
    await sql`DELETE FROM plans WHERE id IN ${sql(createdPlanIds)}`; // plan_slots cascade
    createdPlanIds.length = 0;
  }
  // Force the continuous aggregate to drop any materialized rows for the
  // marker window now that the underlying telemetry has been deleted. The
  // window spans the whole marker year so it covers every test's bucket.
  await sql`CALL refresh_continuous_aggregate('telemetry_5m', ${new Date("2099-01-01T00:00:00Z")}, ${new Date("2099-12-31T00:00:00Z")})`;
}

describe.skipIf(!dbAvailable)("repositories", () => {
  afterEach(cleanup);

  test("insertTelemetry + latestTelemetry roundtrip", async () => {
    await cleanup();
    await insertTelemetry(
      {
        time: MARKER_TIME,
        pv_power_w: 1200,
        battery_power_w: -300,
        battery_soc_pct: 62.5,
        grid_power_w: -50,
        load_power_w: 850,
        ems_mode: 1,
        extra: { note: "test" },
      },
      sql,
    );

    const latest = await latestTelemetry(sql);
    expect(latest).not.toBeNull();
    expect(latest?.time.toISOString()).toBe(MARKER_TIME.toISOString());
    expect(latest?.pv_power_w).toBe(1200);
    expect(latest?.battery_power_w).toBe(-300);
    expect(latest?.battery_soc_pct).toBeCloseTo(62.5);
    expect(latest?.extra).toEqual({ note: "test" });
  });

  test("telemetryBetween returns raw rows in range, ordered by time", async () => {
    await cleanup();
    await insertTelemetry(
      { time: MARKER_TIME, pv_power_w: 100, battery_power_w: 0, battery_soc_pct: 50, grid_power_w: 0, load_power_w: 100, ems_mode: 1, extra: null },
      sql,
    );
    await insertTelemetry(
      { time: MARKER_TIME_2, pv_power_w: 200, battery_power_w: 0, battery_soc_pct: 51, grid_power_w: 0, load_power_w: 200, ems_mode: 1, extra: null },
      sql,
    );

    const rows = await telemetryBetween(MARKER_TIME, MARKER_TIME_2, sql);
    expect(rows.length).toBe(2);
    expect(rows[0]?.pv_power_w).toBe(100);
    expect(rows[1]?.pv_power_w).toBe(200);

    const narrow = await telemetryBetween(MARKER_TIME, MARKER_TIME, sql);
    expect(narrow.length).toBe(1);
  });

  test("upsertPrices keeps the latest value for the same interval", async () => {
    await cleanup();
    await upsertPrices(
      [
        {
          interval_start: MARKER_TIME,
          channel: MARKER_CHANNEL,
          per_kwh: 10,
          spot_per_kwh: 8,
          renewables: 50,
          spike_status: "none",
          interval_type: "forecast",
          estimate: true,
          updated_at: new Date("2099-05-31T00:00:00Z"),
        },
      ],
      sql,
    );
    await upsertPrices(
      [
        {
          interval_start: MARKER_TIME,
          channel: MARKER_CHANNEL,
          per_kwh: 20,
          spot_per_kwh: 18,
          renewables: 60,
          spike_status: "spike",
          interval_type: "actual",
          estimate: false,
          updated_at: new Date("2099-05-31T01:00:00Z"),
        },
      ],
      sql,
    );

    const rows = await pricesBetween(
      new Date("2099-05-01T00:00:00Z"),
      new Date("2099-07-01T00:00:00Z"),
      MARKER_CHANNEL,
      sql,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.per_kwh).toBe(20);
    expect(rows[0]?.interval_type).toBe("actual");
    expect(rows[0]?.estimate).toBe(false);
  });

  test("insertForecastSnapshot persists the full payload", async () => {
    await cleanup();
    await insertForecastSnapshot(
      { fetched_at: MARKER_TIME, channel: MARKER_CHANNEL, payload: { intervals: [1, 2, 3] } },
      sql,
    );

    const [row] = await sql<{ payload: unknown }[]>`
      SELECT payload FROM price_forecast_snapshots WHERE fetched_at = ${MARKER_TIME} AND channel = ${MARKER_CHANNEL}
    `;
    expect(row?.payload).toEqual({ intervals: [1, 2, 3] });
  });

  test("insertForecasts bulk inserts", async () => {
    await cleanup();
    await insertForecasts(
      [
        { created_at: MARKER_TIME, target_start: MARKER_TIME_2, kind: MARKER_KIND, energy_wh: 500, model: "ewma" },
        {
          created_at: MARKER_TIME,
          target_start: new Date(MARKER_TIME_2.getTime() + 5 * 60_000),
          kind: MARKER_KIND,
          energy_wh: 550,
          model: "ewma",
        },
      ],
      sql,
    );

    const rows = await sql<{ energy_wh: number }[]>`
      SELECT energy_wh FROM forecasts WHERE created_at = ${MARKER_TIME} AND kind = ${MARKER_KIND} ORDER BY target_start
    `;
    expect(rows.map((r) => r.energy_wh)).toEqual([500, 550]);
  });

  test("insertPlan + slots roundtrip via latestPlan", async () => {
    await cleanup();
    const planId = await trackedInsertPlan(
      {
        mode: "shadow",
        current_soc_pct: 55,
        objective_cost_cents: 123.45,
        summary: { note: "test plan" },
      },
      [
        {
          slot_start: MARKER_TIME,
          action: "charge_solar",
          battery_power_w: 2000,
          expected_soc_pct: 60,
          buy_price: 15,
          sell_price: 5,
          expected_load_wh: 400,
          expected_solar_wh: 1000,
          expected_grid_wh: 0,
          reason: "excess solar",
        },
        {
          slot_start: new Date(MARKER_TIME.getTime() + 5 * 60_000),
          action: "idle",
          battery_power_w: 0,
          expected_soc_pct: 60,
          buy_price: 16,
          sell_price: 5,
          expected_load_wh: 300,
          expected_solar_wh: 200,
          expected_grid_wh: 100,
          reason: "balanced",
        },
      ],
      sql,
    );

    expect(typeof planId).toBe("number");

    const plan = await latestPlan(sql);
    expect(plan).not.toBeNull();
    expect(plan?.id).toBe(planId);
    expect(plan?.mode).toBe("shadow");
    expect(plan?.summary).toEqual({ note: "test plan" });
    expect(plan?.slots.length).toBe(2);
    expect(plan?.slots[0]?.action).toBe("charge_solar");
    expect(plan?.slots[1]?.action).toBe("idle");
  });

  test("insertDecision + decisionsBetween roundtrip", async () => {
    await cleanup();
    const planId = await trackedInsertPlan(
      { mode: "shadow", current_soc_pct: null, objective_cost_cents: null, summary: null },
      [],
      sql,
    );

    await insertDecision(
      {
        time: MARKER_TIME,
        slot_start: MARKER_TIME,
        mode: "shadow",
        action: "idle",
        battery_power_w: 0,
        soc_pct: 55,
        plan_id: planId,
        reason: "test decision",
        executed: true,
        error: null,
      },
      sql,
    );

    const rows = await decisionsBetween(
      new Date("2099-05-01T00:00:00Z"),
      new Date("2099-07-01T00:00:00Z"),
      sql,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.mode).toBe("shadow");
    expect(rows[0]?.plan_id).toBe(planId);
    expect(rows[0]?.reason).toBe("test decision");
  });

  test("telemetry5mBetween reflects a manually-refreshed continuous aggregate bucket", async () => {
    await cleanup();
    const bucketStart = new Date("2099-06-01T00:00:00Z");
    await insertTelemetry(
      {
        time: bucketStart,
        pv_power_w: 1200,
        battery_power_w: 0,
        battery_soc_pct: 50,
        grid_power_w: 0,
        load_power_w: 600,
        ems_mode: 1,
        extra: null,
      },
      sql,
    );
    await insertTelemetry(
      {
        time: new Date(bucketStart.getTime() + 60_000),
        pv_power_w: 1800,
        battery_power_w: 0,
        battery_soc_pct: 51,
        grid_power_w: 0,
        load_power_w: 600,
        ems_mode: 1,
        extra: null,
      },
      sql,
    );

    await sql`CALL refresh_continuous_aggregate('telemetry_5m', ${new Date("2099-06-01T00:00:00Z")}, ${new Date("2099-06-01T00:10:00Z")})`;

    const rows = await telemetry5mBetween(
      new Date("2099-06-01T00:00:00Z"),
      new Date("2099-06-01T00:10:00Z"),
      sql,
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.pv_power_w_avg).toBeCloseTo(1500);
    expect(rows[0]?.pv_energy_wh).toBeCloseTo(1500 / 12);
    expect(rows[0]?.battery_soc_pct_last).toBeCloseTo(51);
  });
});
