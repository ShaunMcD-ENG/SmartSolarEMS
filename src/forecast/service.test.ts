import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ForecastRow, Telemetry5mRow } from "../db/repositories";
import { SLOTS_PER_DAY } from "./profiles";
import { ForecastService, type ForecastSettingsSource } from "./service";

/** Minimal Telemetry5mRow with every other channel null. */
function row(bucket: Date, opts: { load?: number | null; pv?: number | null } = {}): Telemetry5mRow {
  return {
    bucket,
    pv_power_w_avg: null,
    battery_power_w_avg: null,
    grid_power_w_avg: null,
    load_power_w_avg: null,
    battery_soc_pct_avg: null,
    battery_soc_pct_last: null,
    pv_energy_wh: opts.pv ?? null,
    battery_energy_wh: null,
    grid_energy_wh: null,
    load_energy_wh: opts.load ?? null,
  };
}

const fakeSettings: ForecastSettingsSource = { get: async () => null };

/** Builds a ForecastService with in-memory fakes; every fake is overridable per test. */
function makeService(overrides: {
  telemetry?: Telemetry5mRow[];
  now?: Date;
  tz?: string;
  coldStartDefaultLoadW?: number;
  forecasts?: ForecastRow[];
  onInsertForecasts?: (rows: ForecastRow[]) => void;
  onFetchTelemetry5m?: (from: Date, to: Date) => void;
} = {}): ForecastService {
  const telemetry = overrides.telemetry ?? [];
  const forecasts = overrides.forecasts ?? [];
  return new ForecastService({
    fetchTelemetry5m: async (from, to) => {
      overrides.onFetchTelemetry5m?.(from, to);
      return telemetry.filter((r) => r.bucket.getTime() >= from.getTime() && r.bucket.getTime() <= to.getTime());
    },
    insertForecasts: async (rows) => {
      overrides.onInsertForecasts?.(rows);
    },
    fetchForecasts: async (from, to) =>
      forecasts.filter(
        (f) => f.target_start.getTime() >= from.getTime() && f.target_start.getTime() <= to.getTime(),
      ),
    settings: fakeSettings,
    now: overrides.now ? () => overrides.now! : undefined,
    tz: overrides.tz ?? "UTC",
    coldStartDefaultLoadW: overrides.coldStartDefaultLoadW,
  });
}

describe("ForecastService cold start", () => {
  let originalWarn: typeof console.warn;
  let warnCalls: unknown[][];

  beforeEach(() => {
    warnCalls = [];
    originalWarn = console.warn;
    console.warn = mock((...args: unknown[]) => {
      warnCalls.push(args);
    });
  });

  afterEach(() => {
    console.warn = originalWarn;
  });

  test("with no telemetry history, load falls back to the flat default (500W -> 41.7 Wh/slot) and solar to zero", async () => {
    const now = new Date("2024-06-10T04:00:00.000Z"); // Monday
    const service = makeService({ telemetry: [], now });

    const slots = await service.forecast(now, 10);

    expect(slots).toHaveLength(10);
    for (const slot of slots) {
      expect(slot.loadWh).toBeCloseTo(41.666666, 4);
      expect(slot.solarWh).toBe(0);
    }
  });

  test("logs a cold-start warning exactly once even across repeated forecast() calls", async () => {
    const now = new Date("2024-06-10T04:00:00.000Z");
    const service = makeService({ telemetry: [], now });

    await service.forecast(now, 5);
    await service.forecast(new Date(now.getTime() + 5 * 60_000), 5);

    const coldStartWarnings = warnCalls.filter((call) =>
      String(call[0]).includes("insufficient telemetry history"),
    );
    expect(coldStartWarnings).toHaveLength(1);
  });

  test("respects a custom coldStartDefaultLoadW", async () => {
    const now = new Date("2024-06-10T04:00:00.000Z");
    const service = makeService({ telemetry: [], now, coldStartDefaultLoadW: 1200 });

    const [slot] = await service.forecast(now, 1);

    expect(slot!.loadWh).toBeCloseTo(100, 6); // 1200 W * 5/60 h
  });
});

describe("ForecastService.forecast — persistence/profile blending", () => {
  test("blends heavily toward recent persistence at h=0 and heavily toward the profile by the end of a 24h horizon", async () => {
    const now = new Date("2024-06-10T08:00:00.000Z"); // Monday 08:00 UTC = slot 96
    const dayMs = 24 * 60 * 60_000;

    // 28 days of stable weekday profile history at 300 Wh for slot 96 (and every other
    // slot, so every forecast slot has a defined profile value, not a cold-start fallback).
    const telemetry: Telemetry5mRow[] = [];
    for (let d = 1; d <= 28; d++) {
      const day = new Date(now.getTime() - d * dayMs);
      day.setUTCHours(0, 0, 0, 0);
      for (let slot = 0; slot < SLOTS_PER_DAY; slot++) {
        telemetry.push(row(new Date(day.getTime() + slot * 5 * 60_000), { load: 300 }));
      }
    }
    // Last 30 minutes of actual load is far from the profile (persistence signal).
    for (let m = 5; m <= 30; m += 5) {
      telemetry.push(row(new Date(now.getTime() - m * 60_000), { load: 1000 }));
    }

    const service = makeService({ telemetry, now, tz: "UTC" });
    const slots = await service.forecast(now, SLOTS_PER_DAY);

    // h=0: w = exp(0) = 1 -> pure persistence (1000 Wh).
    expect(slots[0]!.loadWh).toBeCloseTo(1000, 3);
    // h=150: w = exp(-150/12) ~ 3.7e-6 -> effectively pure profile (300 Wh). (Deliberately
    // not h=287/the very last slot: that always aliases to slotOfDay = slot0-1, which falls
    // inside the same trailing 30-min window used for persistence above, so it would also
    // pick up today's one-off 1000 Wh observation once it folds into the profile — that's
    // correct real-world behaviour, just not what this assertion means to isolate.)
    expect(slots[150]!.loadWh).toBeCloseTo(300, 1);
  });

  test("falls back to the profile value itself (not the cold-start default) when there is a profile but no recent persistence data", async () => {
    const now = new Date("2024-06-10T08:00:00.000Z");
    const dayMs = 24 * 60 * 60_000;
    const telemetry: Telemetry5mRow[] = [];
    // History exists, but nothing in the trailing 2h window used for persistence/clearness.
    for (let d = 1; d <= 5; d++) {
      telemetry.push(row(new Date(now.getTime() - d * dayMs), { load: 250 }));
    }

    const service = makeService({ telemetry, now, tz: "UTC" });
    const [slot] = await service.forecast(now, 1);

    expect(slot!.loadWh).toBeCloseTo(250, 6);
  });

  test("snapshots every forecast slot into insertForecasts, tagged with model 'profile-v1'", async () => {
    const now = new Date("2024-06-10T08:00:00.000Z");
    let captured: ForecastRow[] = [];
    const service = makeService({ now, onInsertForecasts: (rows) => (captured = rows) });

    await service.forecast(now, 3);

    expect(captured).toHaveLength(6); // 3 slots * (load + solar)
    expect(captured.every((r) => r.model === "profile-v1")).toBe(true);
    expect(captured.filter((r) => r.kind === "load")).toHaveLength(3);
    expect(captured.filter((r) => r.kind === "solar")).toHaveLength(3);
    expect(captured.every((r) => r.created_at.getTime() === now.getTime())).toBe(true);
  });
});

describe("ForecastService.refreshProfiles", () => {
  test("recomputes at most hourly unless forced", async () => {
    let fetchCount = 0;
    const now = new Date("2024-06-10T08:00:00.000Z");
    const service = makeService({ now, onFetchTelemetry5m: () => (fetchCount += 1) });

    await service.refreshProfiles();
    await service.refreshProfiles(); // within the hour: no-op
    expect(fetchCount).toBe(1);

    await service.refreshProfiles(true); // forced
    expect(fetchCount).toBe(2);
  });
});

describe("ForecastService.accuracy", () => {
  function forecastRow(overrides: Partial<ForecastRow>): ForecastRow {
    return {
      created_at: new Date("2024-06-10T00:00:00.000Z"),
      target_start: new Date("2024-06-10T00:00:00.000Z"),
      kind: "load",
      energy_wh: 0,
      model: "profile-v1",
      ...overrides,
    };
  }

  test("computes MAPE and bias by horizon bucket and kind", async () => {
    const createdAt = new Date("2024-06-10T00:00:00.000Z");

    const forecasts: ForecastRow[] = [
      // 0-1h bucket, load: forecast 110 vs actual 100 -> |110-100|/100 = 10% MAPE, bias +10
      forecastRow({
        created_at: createdAt,
        target_start: new Date(createdAt.getTime() + 30 * 60_000),
        kind: "load",
        energy_wh: 110,
      }),
      // 4-12h bucket, solar: forecast 80 vs actual 100 -> 20% MAPE, bias -20
      forecastRow({
        created_at: createdAt,
        target_start: new Date(createdAt.getTime() + 6 * 3_600_000),
        kind: "solar",
        energy_wh: 80,
      }),
    ];

    const telemetry: Telemetry5mRow[] = [
      row(new Date(createdAt.getTime() + 30 * 60_000), { load: 100 }),
      row(new Date(createdAt.getTime() + 6 * 3_600_000), { pv: 100 }),
    ];

    const service = makeService({ telemetry, forecasts });
    const result = await service.accuracy(createdAt, new Date(createdAt.getTime() + 24 * 3_600_000));

    expect(result.load["0-1h"].n).toBe(1);
    expect(result.load["0-1h"].mape).toBeCloseTo(10, 6);
    expect(result.load["0-1h"].biasWh).toBeCloseTo(10, 6);

    expect(result.solar["4-12h"].n).toBe(1);
    expect(result.solar["4-12h"].mape).toBeCloseTo(20, 6);
    expect(result.solar["4-12h"].biasWh).toBeCloseTo(-20, 6);

    // Buckets with no matching data report n=0 and null mape/bias.
    expect(result.load["1-4h"]).toEqual({ n: 0, mape: null, biasWh: null });
    expect(result.solar["0-1h"]).toEqual({ n: 0, mape: null, biasWh: null });
  });

  test("excludes near-zero actuals from MAPE (avoids division blowup) but still counts them in bias", async () => {
    const createdAt = new Date("2024-06-10T00:00:00.000Z");
    const targetStart = new Date(createdAt.getTime() + 15 * 60_000);

    const forecasts: ForecastRow[] = [
      forecastRow({ created_at: createdAt, target_start: targetStart, kind: "solar", energy_wh: 5 }),
    ];
    const telemetry: Telemetry5mRow[] = [row(targetStart, { pv: 0 })]; // night: actual ~0

    const service = makeService({ telemetry, forecasts });
    const result = await service.accuracy(createdAt, new Date(createdAt.getTime() + 3_600_000));

    expect(result.solar["0-1h"].n).toBe(1);
    expect(result.solar["0-1h"].mape).toBeNull();
    expect(result.solar["0-1h"].biasWh).toBeCloseTo(5, 6);
  });

  test("ignores forecasts with no matching actual telemetry bucket", async () => {
    const createdAt = new Date("2024-06-10T00:00:00.000Z");
    const forecasts: ForecastRow[] = [
      forecastRow({ created_at: createdAt, target_start: new Date(createdAt.getTime() + 10 * 60_000) }),
    ];
    const service = makeService({ telemetry: [], forecasts });

    const result = await service.accuracy(createdAt, new Date(createdAt.getTime() + 3_600_000));

    expect(result.load["0-1h"]).toEqual({ n: 0, mape: null, biasWh: null });
  });
});
