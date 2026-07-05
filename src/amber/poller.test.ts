import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { PriceForecastSnapshotRow, PriceRow } from "../db/repositories";
import type { NormalizedInterval } from "./client";
import { nextFireTime, PricePoller, type AmberSettingsSource, type PriceSource } from "./poller";

function makeInterval(overrides: Partial<NormalizedInterval> = {}): NormalizedInterval {
  return {
    type: "ForecastInterval",
    channelType: "general",
    durationMin: 5,
    intervalStart: new Date("2024-01-01T00:00:00.000Z"),
    perKwh: 20,
    spotPerKwh: 10,
    renewables: 50,
    spikeStatus: "none",
    descriptor: "neutral",
    tariffInformation: null,
    estimate: null,
    range: null,
    advancedPrice: null,
    raw: { marker: "raw-payload" },
    ...overrides,
  };
}

function fakeSettings(amber: { apiToken: string; siteId: string; pollIntervalMs: number } | null): AmberSettingsSource {
  return { get: async () => amber };
}

describe("nextFireTime — 5-minute wall-clock alignment", () => {
  test("fires 20s after the boundary when 'from' is earlier than that", () => {
    const from = new Date("2024-01-01T10:00:05.000Z");
    expect(nextFireTime(from).toISOString()).toBe("2024-01-01T10:00:20.000Z");
  });

  test("rolls over to the next boundary once past this boundary's offset", () => {
    const from = new Date("2024-01-01T10:03:00.000Z");
    expect(nextFireTime(from).toISOString()).toBe("2024-01-01T10:05:20.000Z");
  });

  test("fires exactly at the boundary+offset instant rolls to the next cycle (never fires in the past)", () => {
    const from = new Date("2024-01-01T10:00:20.000Z");
    expect(nextFireTime(from).toISOString()).toBe("2024-01-01T10:05:20.000Z");
  });

  test("respects a custom offset", () => {
    const from = new Date("2024-01-01T10:00:00.000Z");
    expect(nextFireTime(from, 5_000).toISOString()).toBe("2024-01-01T10:00:05.000Z");
  });

  test("works across an hour boundary", () => {
    const from = new Date("2024-01-01T10:58:00.000Z");
    expect(nextFireTime(from).toISOString()).toBe("2024-01-01T11:00:20.000Z");
  });
});

describe("PricePoller.tick", () => {
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

  test("maps and upserts rows for all channels/interval types, and stores a forecast snapshot per channel", async () => {
    const intervals = [
      makeInterval({
        type: "ActualInterval",
        channelType: "general",
        intervalStart: new Date("2023-12-31T23:55:00.000Z"),
        perKwh: 22,
        raw: { channel: "general", kind: "actual" },
      }),
      makeInterval({
        type: "CurrentInterval",
        channelType: "general",
        intervalStart: new Date("2024-01-01T00:00:00.000Z"),
        estimate: true,
        perKwh: 24,
        raw: { channel: "general", kind: "current" },
      }),
      makeInterval({
        type: "ForecastInterval",
        channelType: "feedIn",
        intervalStart: new Date("2024-01-01T00:05:00.000Z"),
        perKwh: 8.5,
        raw: { channel: "feedIn", kind: "forecast" },
      }),
    ];

    const upserted: PriceRow[][] = [];
    const snapshots: PriceForecastSnapshotRow[] = [];
    const client: PriceSource = { getCurrentPrices: async () => intervals };
    const settings = fakeSettings({ apiToken: "tok", siteId: "site-1", pollIntervalMs: 300000 });
    const fixedNow = new Date("2024-01-01T00:00:20.000Z");

    const poller = new PricePoller(settings, {
      createClient: () => client,
      upsertPricesFn: async (rows) => {
        upserted.push(rows);
      },
      insertForecastSnapshotFn: async (row) => {
        snapshots.push(row);
      },
      now: () => fixedNow,
    });

    await poller.tick();

    expect(upserted.length).toBe(1);
    const rows = upserted[0]!;
    expect(rows.length).toBe(3);

    const actualRow = rows.find((r) => r.interval_type === "actual");
    const currentRow = rows.find((r) => r.interval_type === "current");
    const forecastRow = rows.find((r) => r.interval_type === "forecast");

    expect(actualRow?.channel).toBe("general");
    expect(actualRow?.per_kwh).toBe(22);
    expect(currentRow?.estimate).toBe(true);
    expect(currentRow?.per_kwh).toBe(24);
    expect(forecastRow?.channel).toBe("feedIn");
    expect(forecastRow?.per_kwh).toBe(8.5);
    expect(rows.every((r) => r.updated_at.getTime() === fixedNow.getTime())).toBe(true);

    // One forecast snapshot per distinct channel present in this cycle's response.
    expect(snapshots.length).toBe(2);
    const generalSnapshot = snapshots.find((s) => s.channel === "general");
    const feedInSnapshot = snapshots.find((s) => s.channel === "feedIn");
    expect(generalSnapshot?.payload).toEqual([
      { channel: "general", kind: "actual" },
      { channel: "general", kind: "current" },
    ]);
    expect(feedInSnapshot?.payload).toEqual([{ channel: "feedIn", kind: "forecast" }]);
    expect(generalSnapshot?.fetched_at.getTime()).toBe(fixedNow.getTime());

    const status = poller.status();
    expect(status.lastSuccess?.getTime()).toBe(fixedNow.getTime());
    expect(status.lastError).toBeNull();
    // lastIntervalStart tracks the CurrentInterval's start (the "now" price slot).
    expect(status.lastIntervalStart?.toISOString()).toBe("2024-01-01T00:00:00.000Z");
  });

  test("skips the cycle and warns when amber settings are unset (empty token/siteId)", async () => {
    let upsertCalled = false;
    const settings = fakeSettings({ apiToken: "", siteId: "", pollIntervalMs: 300000 });

    const poller = new PricePoller(settings, {
      createClient: () => ({
        getCurrentPrices: async () => {
          throw new Error("should not be called when settings are unset");
        },
      }),
      upsertPricesFn: async () => {
        upsertCalled = true;
      },
      insertForecastSnapshotFn: async () => {},
    });

    await poller.tick();

    expect(upsertCalled).toBe(false);
    expect(warnCalls.some((call) => String(call[0]).includes("skipping cycle"))).toBe(true);
    expect(poller.status().lastSuccess).toBeNull();
    expect(poller.status().lastError).toBeNull();
  });

  test("is failure-tolerant: a fetch error is captured in status().lastError, not thrown", async () => {
    const settings = fakeSettings({ apiToken: "tok", siteId: "site-1", pollIntervalMs: 300000 });
    const poller = new PricePoller(settings, {
      createClient: () => ({
        getCurrentPrices: async () => {
          throw new Error("network exploded");
        },
      }),
      upsertPricesFn: async () => {},
      insertForecastSnapshotFn: async () => {},
    });

    await poller.tick();

    expect(poller.status().lastError).toBe("network exploded");
    expect(poller.status().lastSuccess).toBeNull();
  });

  test("start()/stop() schedule and cancel ticks without throwing", () => {
    const settings = fakeSettings({ apiToken: "tok", siteId: "site-1", pollIntervalMs: 300000 });
    const poller = new PricePoller(settings, {
      createClient: () => ({ getCurrentPrices: async () => [] }),
      upsertPricesFn: async () => {},
      insertForecastSnapshotFn: async () => {},
    });

    poller.start();
    expect(poller.status().running).toBe(true);
    poller.stop();
    expect(poller.status().running).toBe(false);
  });
});
