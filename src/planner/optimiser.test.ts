import { describe, expect, test } from "bun:test";
import type { OptimiserBattery, OptimiserInput, OptimiserSlot, OptimiserSlotResult } from "./optimiser";
import { GRID_IMPORT_TOLERANCE_WH, optimise } from "./optimiser";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const T0 = Date.parse("2026-07-05T00:00:00.000Z");
const SLOT_MS = 5 * 60_000;

/**
 * 10 kWh battery, 10 % reserve, 5 kW / 5 kW, η = 0.9025 ⇒ ηc = ηd = 0.95.
 * SOC step = 50 Wh; max charge 7 steps (350 Wh SOC ≈ 4421 W AC), max
 * discharge 8 steps (400 Wh SOC ⇒ 380 Wh AC ≈ 4560 W).
 */
const BAT: OptimiserBattery = {
  capacityWh: 10_000,
  minReservePct: 10,
  maxChargeW: 5_000,
  maxDischargeW: 5_000,
  roundTripEfficiency: 0.9025,
};

function mkSlots(n: number, fn: (i: number) => Partial<OptimiserSlot> = () => ({})): OptimiserSlot[] {
  return Array.from({ length: n }, (_, i) => ({
    slotStart: new Date(T0 + i * SLOT_MS),
    buyPriceCentsPerKwh: 20,
    sellPriceCentsPerKwh: 5,
    loadWh: 0,
    solarWh: 0,
    demandWindowProtected: false,
    ...fn(i),
  }));
}

function baseInput(slots: OptimiserSlot[], overrides: Partial<OptimiserInput> = {}): OptimiserInput {
  return {
    slots,
    battery: BAT,
    initialSocPct: 50,
    socTargets: [],
    cycleBudgetWhByDay: [],
    lambdaSearch: true,
    minCommandWindowSlots: 1,
    ...overrides,
  };
}

function totalChargedWh(slots: OptimiserSlotResult[], from = 0, to = slots.length): number {
  let sum = 0;
  for (let i = from; i < to; i++) {
    const s = slots[i]!;
    if (s.batteryPowerW > 0) sum += s.batteryPowerW / 12;
  }
  return sum;
}

function totalExportWh(slots: OptimiserSlotResult[], from = 0, to = slots.length): number {
  let sum = 0;
  for (let i = from; i < to; i++) {
    const g = slots[i]!.expectedGridWh;
    if (g < 0) sum += -g;
  }
  return sum;
}

// ---------------------------------------------------------------------------
// Arbitrage / solar-first
// ---------------------------------------------------------------------------

describe("optimise: cheap overnight + expensive evening", () => {
  // 0–11 cheap night (5c), 12–35 mid-day (40c, solar excess 18–29),
  // 36–47 expensive evening (60c, 300 Wh load). Mean buy 36.25c: charging at
  // 5c is clearly worth it, at 40c it is not (40/0.95 > 36.25).
  const slots = mkSlots(48, (i) => {
    if (i < 12) return { buyPriceCentsPerKwh: 5, sellPriceCentsPerKwh: 1 };
    if (i < 36) {
      const solar = i >= 18 && i < 30 ? 300 : 0;
      return { buyPriceCentsPerKwh: 40, sellPriceCentsPerKwh: 1, loadWh: 100, solarWh: solar };
    }
    return { buyPriceCentsPerKwh: 60, sellPriceCentsPerKwh: 2, loadWh: 300 };
  });
  const result = optimise(baseInput(slots, { initialSocPct: 10 }));

  test("charges from grid during the cheap block at full power", () => {
    for (let i = 0; i < 12; i++) {
      expect(result.slots[i]!.action).toBe("charge_grid");
      expect(result.slots[i]!.batteryPowerW).toBeGreaterThan(4000);
    }
  });

  test("solar-first: excess solar charges the battery (charge_solar, ~no import)", () => {
    for (let i = 18; i < 30; i++) {
      const s = result.slots[i]!;
      expect(s.batteryPowerW).toBeGreaterThanOrEqual(0);
      expect(s.expectedGridWh).toBeLessThanOrEqual(GRID_IMPORT_TOLERANCE_WH);
    }
    const solarCharges = result.slots.slice(18, 30).filter((s) => s.action === "charge_solar");
    expect(solarCharges.length).toBeGreaterThanOrEqual(10);
  });

  test("discharges to cover the expensive-evening load without importing", () => {
    for (let i = 36; i < 48; i++) {
      const s = result.slots[i]!;
      expect(s.batteryPowerW).toBeLessThan(0);
      expect(s.expectedGridWh).toBeLessThanOrEqual(60);
    }
  });

  test("never violates min reserve", () => {
    for (const s of result.slots) expect(s.expectedSocPct).toBeGreaterThanOrEqual(BAT.minReservePct - 1e-9);
  });

  test("objective is finite and lambda stayed 0 with no budget", () => {
    expect(Number.isFinite(result.objectiveCents)).toBe(true);
    expect(result.lambdaCentsPerKwh).toBe(0);
    expect(result.cycleBudgetSatisfied).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Demand window
// ---------------------------------------------------------------------------

describe("optimise: demand window", () => {
  test("pre-charges before the window; zero grid import inside it", () => {
    // Protected slots 24–35 carry a 300 Wh/slot load. Starting at reserve, the
    // battery must pre-charge ≥ ~3790 Wh SOC beforehand.
    const slots = mkSlots(36, (i) =>
      i >= 24
        ? { demandWindowProtected: true, loadWh: 300, buyPriceCentsPerKwh: 30, sellPriceCentsPerKwh: 1 }
        : { buyPriceCentsPerKwh: 30, sellPriceCentsPerKwh: 1 },
    );
    const result = optimise(baseInput(slots, { initialSocPct: 10 }));

    for (let i = 24; i < 36; i++) {
      expect(result.slots[i]!.expectedGridWh).toBeLessThanOrEqual(GRID_IMPORT_TOLERANCE_WH);
    }
    // SOC at the start of the window (end of slot 23) covers the whole window load.
    expect(result.slots[23]!.expectedSocPct).toBeGreaterThanOrEqual(46);
    expect(totalChargedWh(result.slots, 0, 24)).toBeGreaterThan(3500);
  });

  test("physically unavoidable import is allowed rather than returning no plan", () => {
    // 5 kWh load per slot vastly exceeds solar (0) + max discharge (380 Wh).
    const slots = mkSlots(6, () => ({ demandWindowProtected: true, loadWh: 5000 }));
    const result = optimise(baseInput(slots, { initialSocPct: 100 }));

    for (const s of result.slots) {
      // Import happens (unavoidable) but is minimal: load − max discharge.
      expect(s.expectedGridWh).toBeGreaterThan(GRID_IMPORT_TOLERANCE_WH);
      expect(s.expectedGridWh).toBeLessThanOrEqual(5000 - 380 + 1e-6);
    }
  });
});

// ---------------------------------------------------------------------------
// Price spike
// ---------------------------------------------------------------------------

describe("optimise: mid-day price spike", () => {
  // Shared shape: spike slots 0–7 (sell 100), load block 8–15, cheap tail
  // 16–47 to keep the terminal credit low. Numbers are exact on the 50 Wh SOC
  // grid: load 285 Wh/slot = exactly 6 discharge steps (6 × 50 × 0.95), and
  // initial SOC 34 % = exactly the 48 steps above the 10 % reserve needed to
  // cover all 8 load slots — covering the load leaves zero surplus and zero
  // quantisation-forced grid flow, so "should it sell?" is unambiguous.
  const spikeSlots = (loadBlockBuy: number, loadBlockSell: number): OptimiserSlot[] =>
    mkSlots(48, (i) => {
      if (i < 8) return { buyPriceCentsPerKwh: 110, sellPriceCentsPerKwh: 100 };
      if (i < 16) return { buyPriceCentsPerKwh: loadBlockBuy, sellPriceCentsPerKwh: loadBlockSell, loadWh: 285 };
      return { buyPriceCentsPerKwh: 8, sellPriceCentsPerKwh: 2 };
    });

  test("sells during the spike when later needs are cheaply re-buyable", () => {
    const result = optimise(baseInput(spikeSlots(10, 5), { initialSocPct: 34 }));
    expect(totalExportWh(result.slots, 0, 8)).toBeGreaterThan(2000);
    expect(result.slots.slice(0, 8).some((s) => s.action === "discharge_grid")).toBe(true);
  });

  test("does not sell during the spike when it would force expensive imports later", () => {
    const result = optimise(baseInput(spikeSlots(200, 5), { initialSocPct: 34 }));
    // Selling at 100c then re-importing at 200c is a loss: hold the energy.
    expect(totalExportWh(result.slots, 0, 8)).toBeLessThanOrEqual(1);
    expect(result.slots.slice(0, 8).every((s) => s.action !== "discharge_grid")).toBe(true);
    // The held energy covers the expensive block exactly: no import either.
    for (let i = 8; i < 16; i++) {
      expect(Math.abs(result.slots[i]!.expectedGridWh)).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Cycle budget / λ search
// ---------------------------------------------------------------------------

describe("optimise: cycle budget via λ search", () => {
  const arbSlots = mkSlots(48, (i) => {
    const block = Math.floor(i / 8);
    const cheap = block % 2 === 0;
    return { buyPriceCentsPerKwh: cheap ? 5 : 60, sellPriceCentsPerKwh: 1, loadWh: 300 };
  });

  test("λ search reduces per-day throughput below the budget vs unconstrained", () => {
    const unconstrained = optimise(baseInput(arbSlots, { cycleBudgetWhByDay: [1e9] }));
    const freeThroughput = unconstrained.throughputWhByDay[0]!;
    expect(freeThroughput).toBeGreaterThan(1000);
    expect(unconstrained.lambdaCentsPerKwh).toBe(0); // skip search when λ=0 fits

    const budget = freeThroughput / 2;
    const constrained = optimise(baseInput(arbSlots, { cycleBudgetWhByDay: [budget] }));
    expect(constrained.throughputWhByDay[0]!).toBeLessThanOrEqual(budget + 0.5);
    expect(constrained.lambdaCentsPerKwh).toBeGreaterThan(0);
    expect(constrained.cycleBudgetSatisfied).toBe(true);
    expect(constrained.throughputWhByDay[0]!).toBeLessThan(freeThroughput);
  });

  test("lambdaSearch=false skips the search and reports the unsatisfied budget", () => {
    const result = optimise(baseInput(arbSlots, { cycleBudgetWhByDay: [500], lambdaSearch: false }));
    expect(result.lambdaCentsPerKwh).toBe(0);
    expect(result.cycleBudgetSatisfied).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SOC targets
// ---------------------------------------------------------------------------

describe("optimise: SOC targets", () => {
  test("trajectory reaches a feasible target at its slot", () => {
    // Flat 20c, no load: without the target the battery would not charge
    // (20/0.95 stored cost > 20 mean-buy credit). Target 70 % at slot 18.
    const slots = mkSlots(24, () => ({ buyPriceCentsPerKwh: 20, sellPriceCentsPerKwh: 1 }));
    const result = optimise(baseInput(slots, { initialSocPct: 20, socTargets: [{ slotIndex: 18, socPct: 70 }] }));
    // SOC at the start of slot 18 = end of slot 17.
    expect(result.slots[17]!.expectedSocPct).toBeGreaterThanOrEqual(69.5);
    expect(result.socPenaltyCents).toBeLessThanOrEqual(1000); // ≤ 1 % shortfall
  });

  test("impossible target degrades gracefully (soft penalty, max-rate charge, no crash)", () => {
    const slots = mkSlots(6, () => ({ buyPriceCentsPerKwh: 20, sellPriceCentsPerKwh: 1 }));
    const result = optimise(baseInput(slots, { initialSocPct: 10, socTargets: [{ slotIndex: 2, socPct: 100 }] }));
    expect(result.slots[0]!.batteryPowerW).toBeGreaterThan(4000);
    expect(result.slots[1]!.batteryPowerW).toBeGreaterThan(4000);
    expect(result.socPenaltyCents).toBeGreaterThan(0);
    expect(Number.isFinite(result.objectiveCents)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Min reserve
// ---------------------------------------------------------------------------

describe("optimise: min reserve", () => {
  test("never plans below the reserve floor even under strong sell pressure", () => {
    const slots = mkSlots(24, () => ({ buyPriceCentsPerKwh: 45, sellPriceCentsPerKwh: 40, loadWh: 300 }));
    const result = optimise(baseInput(slots, { initialSocPct: 30 }));
    for (const s of result.slots) {
      expect(s.expectedSocPct).toBeGreaterThanOrEqual(BAT.minReservePct - 1e-9);
    }
  });

  test("initial SOC below reserve is lifted to the floor, not discharged", () => {
    const slots = mkSlots(6, () => ({ buyPriceCentsPerKwh: 10, sellPriceCentsPerKwh: 100 - 1 }));
    const result = optimise(baseInput(slots, { initialSocPct: 5 }));
    for (const s of result.slots) {
      expect(s.expectedSocPct).toBeGreaterThanOrEqual(BAT.minReservePct - 1e-9);
    }
  });
});

// ---------------------------------------------------------------------------
// Min command window
// ---------------------------------------------------------------------------

describe("optimise: min command window", () => {
  test("merges short charge/discharge flips into runs of at least minCommandWindowSlots", () => {
    // Per-slot alternating prices make 1-slot charge/discharge flips optimal
    // without the post-process.
    const slots = mkSlots(24, (i) => ({
      buyPriceCentsPerKwh: i % 2 === 0 ? 5 : 60,
      sellPriceCentsPerKwh: 1,
      loadWh: 300,
    }));
    const unmerged = optimise(baseInput(slots, { minCommandWindowSlots: 1 }));
    const merged = optimise(baseInput(slots, { minCommandWindowSlots: 3 }));

    const runLengths = (rs: OptimiserSlotResult[]): { dir: number; len: number }[] => {
      const runs: { dir: number; len: number }[] = [];
      for (const s of rs) {
        const dir = Math.sign(s.batteryPowerW);
        const last = runs[runs.length - 1];
        if (last && last.dir === dir) last.len += 1;
        else runs.push({ dir, len: 1 });
      }
      return runs;
    };

    // Sanity: the unconstrained plan actually flips fast (otherwise the test proves nothing).
    expect(runLengths(unmerged.slots).some((r) => r.dir !== 0 && r.len < 3)).toBe(true);
    for (const run of runLengths(merged.slots)) {
      if (run.dir !== 0) expect(run.len).toBeGreaterThanOrEqual(3);
    }
    // Merging can only cost us (it restricts the plan).
    expect(merged.objectiveCents).toBeGreaterThanOrEqual(unmerged.objectiveCents - 1e-6);
  });
});

// ---------------------------------------------------------------------------
// Overrides (pins)
// ---------------------------------------------------------------------------

describe("optimise: override pins", () => {
  test("energy-target charge override delivers ~9 kWh from its start", () => {
    // 20 kWh battery so 9 kWh fits: step 100 Wh, max charge 3 steps/slot.
    const bigBat: OptimiserBattery = { ...BAT, capacityWh: 20_000 };
    const slots = mkSlots(48, (i) =>
      i >= 4 && i < 44
        ? { buyPriceCentsPerKwh: 30, pinned: { action: "charge", energyTargetWh: 9000, overrideId: 7 } }
        : { buyPriceCentsPerKwh: 30 },
    );
    const result = optimise(baseInput(slots, { battery: bigBat, initialSocPct: 20 }));

    expect(result.overrideDeliveredWh[7]!).toBeGreaterThanOrEqual(8800);
    expect(result.overrideDeliveredWh[7]!).toBeLessThanOrEqual(9400);
    // No charging is forced before the override starts.
    for (let i = 0; i < 4; i++) expect(result.slots[i]!.batteryPowerW).toBeLessThanOrEqual(0);
    // The override charges from the grid (no solar in this scenario).
    expect(result.slots[4]!.action).toBe("charge_grid");
    expect(result.slots[4]!.batteryPowerW).toBeGreaterThan(3000);
  });

  test("self_consume pin follows net load and never trades with the grid, even at spike prices", () => {
    const slots = mkSlots(12, () => ({
      buyPriceCentsPerKwh: 30,
      sellPriceCentsPerKwh: 500, // juicy spike the pin must ignore
      loadWh: 240,
      pinned: { action: "self_consume", overrideId: 3 },
    }));
    const result = optimise(baseInput(slots, { initialSocPct: 80 }));

    for (const s of result.slots) {
      expect(s.action).toBe("self_consume");
      expect(Math.abs(s.expectedGridWh)).toBeLessThanOrEqual(GRID_IMPORT_TOLERANCE_WH);
      expect(s.batteryPowerW).toBeLessThan(0); // covering load
    }
  });

  test("self_consume pin absorbs excess solar without importing much", () => {
    const slots = mkSlots(6, () => ({
      solarWh: 300,
      pinned: { action: "self_consume", overrideId: 4 },
    }));
    const result = optimise(baseInput(slots, { initialSocPct: 30 }));
    for (const s of result.slots) {
      expect(s.action).toBe("self_consume");
      expect(s.batteryPowerW).toBeGreaterThan(0);
      expect(Math.abs(s.expectedGridWh)).toBeLessThanOrEqual(GRID_IMPORT_TOLERANCE_WH);
    }
  });

  test("idle pin holds the battery at 0 W", () => {
    const slots = mkSlots(6, (i) => ({
      buyPriceCentsPerKwh: i < 3 ? 1 : 100, // arbitrage the pin must ignore
      loadWh: 200,
      pinned: { action: "idle", overrideId: 5 },
    }));
    const result = optimise(baseInput(slots));
    for (const s of result.slots) {
      expect(s.batteryPowerW).toBe(0);
      expect(s.action).toBe("idle");
    }
  });

  test("demand-window protection beats a pin on the same slot (caller left the flag set)", () => {
    // A grid-charge pin on protected slots is dropped: the battery covers the
    // load instead of importing to charge.
    const slots = mkSlots(6, () => ({
      demandWindowProtected: true,
      loadWh: 300,
      pinned: { action: "charge", powerW: 5000, overrideId: 9 },
    }));
    const result = optimise(baseInput(slots, { initialSocPct: 60 }));
    for (const s of result.slots) {
      expect(s.expectedGridWh).toBeLessThanOrEqual(GRID_IMPORT_TOLERANCE_WH);
      expect(s.batteryPowerW).toBeLessThanOrEqual(0);
    }
  });

  test("pin with explicit power_w charges at approximately that power", () => {
    const slots = mkSlots(6, () => ({
      pinned: { action: "charge", powerW: 2400, overrideId: 11 },
    }));
    const result = optimise(baseInput(slots, { initialSocPct: 20 }));
    for (const s of result.slots) {
      // 2400 W → 200 Wh AC → 190 Wh SOC ≈ 4 steps ⇒ 210.5 Wh AC ≈ 2526 W.
      expect(s.batteryPowerW).toBeGreaterThan(1800);
      expect(s.batteryPowerW).toBeLessThan(3000);
    }
  });
});

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

describe("optimise: performance", () => {
  test("288 slots with λ search, demand window and SOC target run well under 5 s", () => {
    const slots = mkSlots(288, (i) => {
      const hour = (i * 5) / 60;
      const buy = 20 + 15 * Math.sin((hour / 24) * 2 * Math.PI) + (i % 37 === 0 ? 120 : 0);
      const solar = hour > 7 && hour < 17 ? 350 * Math.sin(((hour - 7) / 10) * Math.PI) : 0;
      return {
        buyPriceCentsPerKwh: buy,
        sellPriceCentsPerKwh: Math.max(0, buy - 12),
        loadWh: 250,
        solarWh: solar,
        demandWindowProtected: i >= 180 && i < 240,
        dayIndex: i < 200 ? 0 : 1,
      };
    });
    const input = baseInput(slots, {
      initialSocPct: 40,
      socTargets: [{ slotIndex: 180, socPct: 90 }],
      cycleBudgetWhByDay: [4000, 9000], // tight enough to force the λ search
      minCommandWindowSlots: 2,
    });

    const started = performance.now();
    const result = optimise(input);
    const elapsedMs = performance.now() - started;
    console.log(`optimise(): 288 slots with λ search took ${elapsedMs.toFixed(1)} ms`);

    expect(result.slots).toHaveLength(288);
    expect(elapsedMs).toBeLessThan(5000);
  });
});
