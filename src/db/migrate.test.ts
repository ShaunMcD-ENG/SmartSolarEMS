import { describe, expect, test } from "bun:test";
import { getDb } from "./client";
import { runMigrations } from "./migrate";
import { isDbAvailable } from "./test-helpers";

const sql = getDb();
const dbAvailable = await isDbAvailable(sql);

describe.skipIf(!dbAvailable)("runMigrations against the dev DB", () => {
  test("002_core_schema.sql and 003_aggregates_policies.sql are recorded as applied", async () => {
    const rows = await sql<{ name: string }[]>`SELECT name FROM schema_migrations ORDER BY name`;
    const names = rows.map((row) => row.name);
    expect(names).toContain("002_core_schema.sql");
    expect(names).toContain("003_aggregates_policies.sql");
  });

  test("re-running the full migration set is a no-op (idempotent)", async () => {
    const applied = await runMigrations(sql);
    expect(applied).toEqual([]);
  });

  test("all core tables exist", async () => {
    const rows = await sql<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'settings', 'telemetry', 'prices', 'price_forecast_snapshots',
          'forecasts', 'plans', 'plan_slots', 'decisions', 'sessions'
        )
    `;
    const names = rows.map((row) => row.table_name).sort();
    expect(names).toEqual(
      [
        "decisions",
        "forecasts",
        "plan_slots",
        "plans",
        "price_forecast_snapshots",
        "prices",
        "sessions",
        "settings",
        "telemetry",
      ].sort(),
    );
  });

  test("telemetry, prices, price_forecast_snapshots, forecasts, decisions are hypertables", async () => {
    const rows = await sql<{ hypertable_name: string }[]>`
      SELECT hypertable_name FROM timescaledb_information.hypertables
    `;
    const names = rows.map((row) => row.hypertable_name);
    for (const expected of ["telemetry", "prices", "price_forecast_snapshots", "forecasts", "decisions"]) {
      expect(names).toContain(expected);
    }
  });

  test("telemetry_5m continuous aggregate exists with a refresh policy", async () => {
    const aggregates = await sql<{ view_name: string }[]>`
      SELECT view_name FROM timescaledb_information.continuous_aggregates
      WHERE view_name = 'telemetry_5m'
    `;
    expect(aggregates.length).toBe(1);

    const jobs = await sql<{ proc_name: string }[]>`
      SELECT proc_name FROM timescaledb_information.jobs
      WHERE hypertable_name = 'telemetry_5m' AND proc_name = 'policy_refresh_continuous_aggregate'
    `;
    expect(jobs.length).toBe(1);
  });

  test("telemetry has a compression policy and telemetry/decisions/forecasts/price_forecast_snapshots have retention policies", async () => {
    const compression = await sql<{ hypertable_name: string }[]>`
      SELECT hypertable_name FROM timescaledb_information.jobs
      WHERE hypertable_name = 'telemetry' AND proc_name = 'policy_compression'
    `;
    expect(compression.length).toBe(1);

    const retention = await sql<{ hypertable_name: string }[]>`
      SELECT hypertable_name FROM timescaledb_information.jobs
      WHERE proc_name = 'policy_retention'
      ORDER BY hypertable_name
    `;
    const names = retention.map((row) => row.hypertable_name).sort();
    expect(names).toEqual(
      ["decisions", "forecasts", "price_forecast_snapshots", "telemetry"].sort(),
    );
  });
});
