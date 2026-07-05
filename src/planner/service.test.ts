import { describe, expect, test } from "bun:test";
import type { SettingsKey, SettingsValue } from "../config/settings";
import type { OverrideAction, OverrideRow, OverrideStatus } from "../db/overrides";
import type { PlanInput, PlanSlotRow, PriceRow, TelemetryRow } from "../db/repositories";
import type { ForecastSlot } from "../forecast/service";
import type { OptimiserSlot } from "./optimiser";
import type { BatteryThroughput, PlannerSettingsSource, ResolvedOverride } from "./service";
import {
  PlannerService,
  applyOverridesToSlots,
  demandWindowFlags,
  mapPricesToSlots,
  resolveSocTargetSlots,
} from "./service";

const SLOT_MS = 5 * 60_000;
const NOW = new Date("2026-07-05T00:02:30.000Z");
const SLOT0 = new Date("2026-07-05T00:00:00.000Z");

// ---------------------------------------------------------------------------
// Fakes / factories
// ---------------------------------------------------------------------------

function priceRow(channel: string, intervalStart: Date, perKwh: number): PriceRow {
  return {
    interval_start: intervalStart,
    channel,
    per_kwh: perKwh,
    spot_per_kwh: null,
    renewables: null,
    spike_status: null,
    interval_type: "forecast",
    estimate: null,
    updated_at: intervalStart,
  };
}

/** `count` rows every `stepMin` minutes starting at `from`. */
function priceRows(
  channel: string,
  from: Date,
  count: number,
  stepMin: number,
  price: (i: number) => number,
): PriceRow[] {
  return Array.from({ length: count }, (_, i) =>
    priceRow(channel, new Date(from.getTime() + i * stepMin * 60_000), price(i)),
  );
}

function telemetryRow(soc: number | null): TelemetryRow {
  return {
    time: NOW,
    pv_power_w: null,
    battery_power_w: null,
    battery_soc_pct: soc,
    grid_power_w: null,
    load_power_w: null,
    ems_mode: null,
    extra: null,
  };
}

function forecastSlots(from: Date, count: number, loadWh: number, solarWh = 0): ForecastSlot[] {
  return Array.from({ length: count }, (_, i) => ({
    slotStart: new Date(from.getTime() + i * SLOT_MS),
    loadWh,
    solarWh,
  }));
}

function overrideRow(
  o: Partial<OverrideRow> & { id: number; start_time: Date; action: OverrideAction },
): OverrideRow {
  return {
    created_at: NOW,
    end_time: null,
    energy_wh: null,
    power_w: null,
    override_demand_window: false,
    status: "pending",
    note: null,
    ...o,
  };
}

type SettingsFixture = { [K in SettingsKey]?: SettingsValue<K> };

const DEFAULT_SETTINGS: SettingsFixture = {
  battery: {
    capacityWh: 10_000,
    usableMinSocPct: 10,
    maxChargeW: 5_000,
    maxDischargeW: 5_000,
    roundTripEfficiency: 0.9025,
  },
  goals: { maxCyclesPerDay: 1, socTargets: [], minCommandWindowMin: 5 },
  demandWindow: { enabled: false, start: "15:00", end: "20:00", bufferMin: 10 },
  mode: { shadow: true },
};

function makeSettings(fixture: SettingsFixture): PlannerSettingsSource {
  return {
    get: async <K extends SettingsKey>(key: K): Promise<SettingsValue<K> | null> =>
      (fixture[key] ?? null) as SettingsValue<K> | null,
  };
}

interface MakeServiceOpts {
  now?: Date;
  tz?: string;
  buyRows?: PriceRow[];
  sellRows?: PriceRow[];
  forecast?: ForecastSlot[];
  forecastThrows?: boolean;
  /** null = telemetry row exists but SOC is null. */
  soc?: number | null;
  settings?: SettingsFixture;
  overrides?: OverrideRow[];
  throughput?: (from: Date, to: Date) => BatteryThroughput;
}

function makeService(opts: MakeServiceOpts = {}) {
  const now = opts.now ?? NOW;
  const slot0 = new Date(Math.floor(now.getTime() / SLOT_MS) * SLOT_MS);
  const buyRows = opts.buyRows ?? priceRows("general", slot0, 48, 30, () => 20);
  const sellRows = opts.sellRows ?? priceRows("feedIn", slot0, 48, 30, () => 5);
  const forecast = opts.forecast ?? forecastSlots(slot0, 288, 100);

  const inserted: { plan: PlanInput; slots: PlanSlotRow[] }[] = [];
  const statusCalls: [number, OverrideStatus][] = [];
  const throughputCalls: { from: Date; to: Date }[] = [];

  const service = new PlannerService({
    pricesBetween: async (from, to, channel) => {
      const rows = channel === "general" ? buyRows : channel === "feedIn" ? sellRows : [];
      return rows.filter(
        (r) => r.interval_start.getTime() >= from.getTime() && r.interval_start.getTime() <= to.getTime(),
      );
    },
    forecast: async () => {
      if (opts.forecastThrows) throw new Error("forecast unavailable");
      return forecast;
    },
    latestTelemetry: async () => telemetryRow(opts.soc === undefined ? 50 : opts.soc),
    settings: makeSettings({ ...DEFAULT_SETTINGS, ...opts.settings }),
    relevantOverrides: async () => opts.overrides ?? [],
    setOverrideStatus: async (id, status) => {
      statusCalls.push([id, status]);
      return true;
    },
    insertPlan: async (plan, slots) => {
      inserted.push({ plan, slots });
      return 42;
    },
    batteryThroughputWhBetween: async (from, to) => {
      throughputCalls.push({ from, to });
      return opts.throughput ? opts.throughput(from, to) : { chargedWh: 0, dischargedWh: 0 };
    },
    now: () => now,
    tz: opts.tz ?? "UTC",
  });

  return { service, now, inserted, statusCalls, throughputCalls };
}

function mkOptSlots(n: number, fn: (i: number) => Partial<OptimiserSlot> = () => ({})): OptimiserSlot[] {
  return Array.from({ length: n }, (_, i) => ({
    slotStart: new Date(SLOT0.getTime() + i * SLOT_MS),
    buyPriceCentsPerKwh: 20,
    sellPriceCentsPerKwh: 5,
    loadWh: 0,
    solarWh: 0,
    demandWindowProtected: false,
    ...fn(i),
  }));
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("mapPricesToSlots", () => {
  const slotStarts = Array.from({ length: 12 }, (_, i) => new Date(SLOT0.getTime() + i * SLOT_MS));

  test("step function over coarser (30 min) price intervals", () => {
    const rows = [priceRow("general", SLOT0, 20), priceRow("general", new Date(SLOT0.getTime() + 30 * 60_000), 30)];
    const prices = mapPricesToSlots(rows, slotStarts)!;
    expect(prices.slice(0, 6)).toEqual([20, 20, 20, 20, 20, 20]);
    expect(prices.slice(6)).toEqual([30, 30, 30, 30, 30, 30]);
  });

  test("extends the last known price past the end of the price horizon", () => {
    const rows = [priceRow("general", SLOT0, 20)];
    const prices = mapPricesToSlots(rows, slotStarts)!;
    expect(prices.every((p) => p === 20)).toBe(true);
  });

  test("carries the first row back over slots before it", () => {
    const rows = [priceRow("general", new Date(SLOT0.getTime() + 30 * 60_000), 33)];
    const prices = mapPricesToSlots(rows, slotStarts)!;
    expect(prices[0]).toBe(33);
  });

  test("returns null when there are no rows at all", () => {
    expect(mapPricesToSlots([], slotStarts)).toBeNull();
  });
});

describe("demandWindowFlags", () => {
  const dw = { enabled: true, start: "15:00", end: "20:00", bufferMin: 10 };

  test("marks [start − buffer, end + buffer) in the configured timezone (Australia/Sydney, AEST +10)", () => {
    const flags = demandWindowFlags(
      [
        new Date("2026-07-05T04:45:00.000Z"), // 14:45 local — before buffer
        new Date("2026-07-05T04:50:00.000Z"), // 14:50 local — buffer start
        new Date("2026-07-05T07:00:00.000Z"), // 17:00 local — inside
        new Date("2026-07-05T10:05:00.000Z"), // 20:05 local — inside buffer
        new Date("2026-07-05T10:10:00.000Z"), // 20:10 local — past buffer
      ],
      dw,
      "Australia/Sydney",
    );
    expect(flags).toEqual([false, true, true, true, false]);
  });

  test("disabled window marks nothing", () => {
    const flags = demandWindowFlags([new Date("2026-07-05T07:00:00.000Z")], { ...dw, enabled: false }, "Australia/Sydney");
    expect(flags).toEqual([false]);
  });

  test("handles windows that cross local midnight", () => {
    const flags = demandWindowFlags(
      [
        new Date("2026-07-05T21:00:00.000Z"), // 21:00 UTC — before
        new Date("2026-07-05T23:00:00.000Z"), // inside (22:00–02:00 window)
        new Date("2026-07-06T01:00:00.000Z"), // inside, past midnight
        new Date("2026-07-06T03:00:00.000Z"), // after
      ],
      { enabled: true, start: "22:00", end: "02:00", bufferMin: 0 },
      "UTC",
    );
    expect(flags).toEqual([false, true, true, false]);
  });
});

describe("resolveSocTargetSlots", () => {
  test("maps HH:MM to the first matching horizon slot in the configured tz", () => {
    const from = new Date("2026-07-05T06:00:00.000Z");
    const slotStarts = Array.from({ length: 288 }, (_, i) => new Date(from.getTime() + i * SLOT_MS));
    const targets = resolveSocTargetSlots(slotStarts, [{ time: "18:00", socPct: 80 }], "UTC");
    expect(targets).toEqual([{ slotIndex: 144, socPct: 80 }]);
  });

  test("times not aligned to the 5-min grid resolve to their containing slot", () => {
    const from = new Date("2026-07-05T06:00:00.000Z");
    const slotStarts = Array.from({ length: 288 }, (_, i) => new Date(from.getTime() + i * SLOT_MS));
    const targets = resolveSocTargetSlots(slotStarts, [{ time: "18:03", socPct: 70 }], "UTC");
    expect(targets).toEqual([{ slotIndex: 144, socPct: 70 }]);
  });
});

describe("applyOverridesToSlots", () => {
  const resolvedOverride = (o: Partial<ResolvedOverride> & { id: number }): ResolvedOverride => ({
    action: "charge",
    startTime: SLOT0,
    endTime: null,
    powerW: null,
    remainingEnergyWh: null,
    overrideDemandWindow: false,
    ...o,
  });

  test("demand-window protection wins when override_demand_window=false", () => {
    const slots = mkOptSlots(12, (i) => ({ demandWindowProtected: i >= 4 && i < 8 }));
    applyOverridesToSlots(
      slots,
      [
        resolvedOverride({
          id: 1,
          startTime: new Date(SLOT0.getTime() + 2 * SLOT_MS),
          endTime: new Date(SLOT0.getTime() + 10 * SLOT_MS),
        }),
      ],
      SLOT0,
    );
    for (const i of [2, 3, 8, 9]) expect(slots[i]!.pinned?.overrideId).toBe(1);
    for (const i of [4, 5, 6, 7]) {
      expect(slots[i]!.pinned).toBeUndefined();
      expect(slots[i]!.demandWindowProtected).toBe(true);
    }
    for (const i of [0, 1, 10, 11]) expect(slots[i]!.pinned).toBeUndefined();
  });

  test("override_demand_window=true pins protected slots and clears their protection", () => {
    const slots = mkOptSlots(12, (i) => ({ demandWindowProtected: i >= 4 && i < 8 }));
    applyOverridesToSlots(
      slots,
      [
        resolvedOverride({
          id: 2,
          startTime: new Date(SLOT0.getTime() + 2 * SLOT_MS),
          endTime: new Date(SLOT0.getTime() + 10 * SLOT_MS),
          overrideDemandWindow: true,
        }),
      ],
      SLOT0,
    );
    for (let i = 2; i < 10; i++) {
      expect(slots[i]!.pinned?.overrideId).toBe(2);
      expect(slots[i]!.demandWindowProtected).toBe(false);
    }
  });

  test("the earlier-listed override wins a contested slot", () => {
    const slots = mkOptSlots(10);
    applyOverridesToSlots(
      slots,
      [
        resolvedOverride({ id: 1, startTime: SLOT0, endTime: new Date(SLOT0.getTime() + 6 * SLOT_MS) }),
        resolvedOverride({
          id: 2,
          action: "idle",
          startTime: new Date(SLOT0.getTime() + 3 * SLOT_MS),
          endTime: new Date(SLOT0.getTime() + 9 * SLOT_MS),
        }),
      ],
      SLOT0,
    );
    for (let i = 0; i < 6; i++) expect(slots[i]!.pinned?.overrideId).toBe(1);
    for (let i = 6; i < 9; i++) expect(slots[i]!.pinned?.overrideId).toBe(2);
    expect(slots[9]!.pinned).toBeUndefined();
  });

  test("energy-target override carries its remaining energy into the pin", () => {
    const slots = mkOptSlots(6);
    applyOverridesToSlots(slots, [resolvedOverride({ id: 3, remainingEnergyWh: 3000 })], SLOT0);
    expect(slots[0]!.pinned?.energyTargetWh).toBe(3000);
    expect(slots[5]!.pinned?.energyTargetWh).toBe(3000);
  });
});

// ---------------------------------------------------------------------------
// PlannerService.runOnce
// ---------------------------------------------------------------------------

describe("PlannerService.runOnce", () => {
  test("assembles 288 slots and stores the plan (shadow mode, summary populated)", async () => {
    const { service, inserted } = makeService();
    const result = await service.runOnce();

    expect(result).not.toBeNull();
    expect(result!.planId).toBe(42);
    expect(inserted).toHaveLength(1);
    const { plan, slots } = inserted[0]!;
    expect(slots).toHaveLength(288);
    expect(plan.mode).toBe("shadow");
    expect(plan.current_soc_pct).toBe(50);
    expect(slots[0]!.slot_start.getTime()).toBe(SLOT0.getTime()); // aligned down from 00:02:30
    expect(slots[0]!.buy_price).toBe(20);
    expect(slots[0]!.sell_price).toBe(5);
    expect(slots[0]!.expected_load_wh).toBe(100);
    expect(slots[0]!.reason).toBeTruthy();
    expect(slots[1]!.reason).toBeNull();

    const summary = plan.summary as Record<string, unknown>;
    expect(summary.lambdaCentsPerKwh).toBe(0);
    expect(Array.isArray(summary.throughputWhByDay)).toBe(true);
    expect(typeof summary.objectiveCents).toBe("number");
    expect(plan.objective_cost_cents).toBe(summary.objectiveCents as number);
  });

  test("active mode is stored when shadow flag is off", async () => {
    const { service, inserted } = makeService({ settings: { mode: { shadow: false } } });
    await service.runOnce();
    expect(inserted[0]!.plan.mode).toBe("active");
  });

  test("returns null and stores nothing when there are no buy prices at all", async () => {
    const { service, inserted } = makeService({ buyRows: [] });
    expect(await service.runOnce()).toBeNull();
    expect(inserted).toHaveLength(0);
  });

  test("missing feed-in prices fall back to 0 c/kWh export instead of aborting", async () => {
    const { service, inserted } = makeService({ sellRows: [] });
    const result = await service.runOnce();
    expect(result).not.toBeNull();
    expect(inserted[0]!.slots[0]!.sell_price).toBe(0);
  });

  test("returns null when there is no SOC telemetry", async () => {
    const { service, inserted } = makeService({ soc: null });
    expect(await service.runOnce()).toBeNull();
    expect(inserted).toHaveLength(0);
  });

  test("extends the last known price over a short price horizon", async () => {
    // Only 6 h of general prices; the last row is 33 c.
    const buyRows = priceRows("general", SLOT0, 12, 30, (i) => (i === 11 ? 33 : 20));
    const { service, inserted } = makeService({ buyRows });
    await service.runOnce();
    const slots = inserted[0]!.slots;
    expect(slots[287]!.buy_price).toBe(33);
    expect(slots[0]!.buy_price).toBe(20);
  });

  test("forecast failure falls back to flat default load and zero solar", async () => {
    const { service, inserted } = makeService({ forecastThrows: true });
    const result = await service.runOnce();
    expect(result).not.toBeNull();
    const slots = inserted[0]!.slots;
    expect(slots[0]!.expected_load_wh).toBeCloseTo(41.6667, 3);
    expect(slots[0]!.expected_solar_wh).toBe(0);
  });

  test("short forecast horizon is extended with the last known values", async () => {
    const { service, inserted } = makeService({ forecast: forecastSlots(SLOT0, 100, 250, 80) });
    await service.runOnce();
    const slots = inserted[0]!.slots;
    expect(slots[287]!.expected_load_wh).toBe(250);
    expect(slots[287]!.expected_solar_wh).toBe(80);
  });

  test("cycle budget subtracts today's charged throughput (chargedWhToday from local midnight)", async () => {
    const dayStart = Date.parse("2026-07-05T00:00:00.000Z");
    const { service, inserted, throughputCalls } = makeService({
      throughput: (from) => (from.getTime() === dayStart ? { chargedWh: 8000, dischargedWh: 0 } : { chargedWh: 0, dischargedWh: 0 }),
    });
    await service.runOnce();

    expect(throughputCalls.some((c) => c.from.getTime() === dayStart)).toBe(true);
    const summary = inserted[0]!.plan.summary as { cycleBudgetWhByDay: number[] };
    // usable 9000 Wh × 1 cycle − 8000 Wh already charged today.
    expect(summary.cycleBudgetWhByDay[0]).toBe(1000);
  });

  test("active override pins slots, is mentioned in the slot-0 reason, and delivers its remaining energy", async () => {
    const startTime = new Date("2026-07-04T23:00:00.000Z");
    const { service, inserted, statusCalls } = makeService({
      overrides: [overrideRow({ id: 9, action: "charge", start_time: startTime, energy_wh: 5000, status: "active" })],
      throughput: (from) =>
        from.getTime() === startTime.getTime()
          ? { chargedWh: 2000, dischargedWh: 0 } // 2 kWh already delivered
          : { chargedWh: 0, dischargedWh: 0 },
    });
    const result = await service.runOnce();

    expect(statusCalls).toHaveLength(0); // not completed yet
    const slots = inserted[0]!.slots;
    expect(slots[0]!.action).toBe("charge_grid");
    expect(slots[0]!.reason).toContain("override #9");
    // Remaining 3000 Wh is what the plan delivers (± a grid-step of rounding).
    expect(result!.optimiser.overrideDeliveredWh[9]!).toBeGreaterThan(2800);
    expect(result!.optimiser.overrideDeliveredWh[9]!).toBeLessThan(3200);
  });

  test("marks an energy-target override completed once telemetry shows the energy delivered", async () => {
    const startTime = new Date("2026-07-04T23:00:00.000Z");
    const { service, inserted, statusCalls } = makeService({
      overrides: [overrideRow({ id: 9, action: "charge", start_time: startTime, energy_wh: 5000, status: "active" })],
      throughput: (from) =>
        from.getTime() === startTime.getTime()
          ? { chargedWh: 5200, dischargedWh: 0 }
          : { chargedWh: 0, dischargedWh: 0 },
    });
    await service.runOnce();

    expect(statusCalls).toContainEqual([9, "completed"]);
    expect(inserted[0]!.slots[0]!.reason).not.toContain("override");
  });

  test("defensively expires overrides whose window has already passed", async () => {
    const { service, statusCalls } = makeService({
      overrides: [
        overrideRow({
          id: 4,
          action: "charge",
          start_time: new Date("2026-07-04T20:00:00.000Z"),
          end_time: new Date("2026-07-04T22:00:00.000Z"),
          status: "active",
        }),
      ],
    });
    await service.runOnce();
    expect(statusCalls).toContainEqual([4, "expired"]);
  });

  test("demand-window protection beats an override without the flag (end-to-end)", async () => {
    // Window covers the whole first two hours; override wants to grid-charge inside it.
    const { service, inserted } = makeService({
      settings: { demandWindow: { enabled: true, start: "00:00", end: "02:00", bufferMin: 0 } },
      soc: 80,
      overrides: [
        overrideRow({
          id: 6,
          action: "charge",
          start_time: SLOT0,
          end_time: new Date(SLOT0.getTime() + 12 * SLOT_MS),
          power_w: 5000,
        }),
      ],
    });
    await service.runOnce();
    const slots = inserted[0]!.slots;
    // No grid-charging inside the protected window; the battery covers the load.
    for (let i = 0; i < 12; i++) {
      expect(slots[i]!.action).not.toBe("charge_grid");
      expect(slots[i]!.expected_grid_wh).toBeLessThanOrEqual(50);
    }
    expect(slots[0]!.reason).toContain("demand window protection");
    expect(slots[0]!.reason).not.toContain("override #6");
  });

  test("override_demand_window=true beats the demand window (end-to-end)", async () => {
    const { service, inserted } = makeService({
      settings: { demandWindow: { enabled: true, start: "00:00", end: "02:00", bufferMin: 0 } },
      soc: 30,
      overrides: [
        overrideRow({
          id: 7,
          action: "charge",
          start_time: SLOT0,
          end_time: new Date(SLOT0.getTime() + 12 * SLOT_MS),
          power_w: 5000,
          override_demand_window: true,
        }),
      ],
    });
    await service.runOnce();
    const slots = inserted[0]!.slots;
    expect(slots[0]!.action).toBe("charge_grid");
    expect(slots[0]!.expected_grid_wh).toBeGreaterThan(50);
    expect(slots[0]!.reason).toContain("override #7");
  });

  test("slot-0 reason mentions the price for ordinary optimisation decisions", async () => {
    // Cheap now (2c), expensive later (60c): slot 0 charges from grid.
    const buyRows = priceRows("general", SLOT0, 48, 30, (i) => (i < 12 ? 2 : 60));
    const { service, inserted } = makeService({ buyRows, soc: 20 });
    await service.runOnce();
    const slot0 = inserted[0]!.slots[0]!;
    expect(slot0.action).toBe("charge_grid");
    expect(slot0.reason).toContain("2.0 c/kWh");
  });

  test("slot-0 reason mentions an upcoming SOC target", async () => {
    const { service, inserted } = makeService({
      settings: {
        goals: { maxCyclesPerDay: 1, socTargets: [{ time: "18:00", socPct: 80 }], minCommandWindowMin: 5 },
      },
    });
    await service.runOnce();
    expect(inserted[0]!.slots[0]!.reason).toContain("SOC target 80 % by 18:00");
  });
});
