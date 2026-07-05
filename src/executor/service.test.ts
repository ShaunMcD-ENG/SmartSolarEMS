import { describe, expect, test } from "bun:test";
import type { SettingsKey, SettingsValue } from "../config/settings";
import type { DecisionRow, PlanSlotRow, TelemetryRow } from "../db/repositories";
import { REMOTE_EMS_CONTROL_MODE } from "../modbus/registers";
import type { PlanAction } from "../planner/optimiser";
import type { PlannerRunResult } from "../planner/service";
import type { ExecutorModbusClient, ExecutorServiceDeps, ExecutorSettingsSource } from "./service";
import {
  applySafetyPipeline,
  clampChargePowerW,
  clampDischargeFloorW,
  clampDischargePowerW,
  directionOf,
  ExecutorService,
  isOverrideDemandWindowPin,
  nextExecutorTick,
} from "./service";

const SLOT_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// Fakes / factories
// ---------------------------------------------------------------------------

type SettingsFixture = { [K in SettingsKey]?: SettingsValue<K> };

const DEFAULT_SETTINGS: SettingsFixture = {
  battery: {
    capacityWh: 10_000,
    usableMinSocPct: 10,
    maxChargeW: 5_000,
    maxDischargeW: 5_000,
    roundTripEfficiency: 0.81, // eta = 0.9 for round numbers in floor-clamp tests
  },
  goals: { maxCyclesPerDay: 1, socTargets: [], minCommandWindowMin: 5 },
  demandWindow: { enabled: false, start: "15:00", end: "20:00", bufferMin: 10 },
  mode: { shadow: true },
};

function makeSettings(fixture: SettingsFixture): ExecutorSettingsSource {
  return {
    get: async <K extends SettingsKey>(key: K): Promise<SettingsValue<K> | null> =>
      (fixture[key] ?? null) as SettingsValue<K> | null,
  };
}

function slotRow(overrides: Partial<PlanSlotRow> = {}): PlanSlotRow {
  return {
    slot_start: new Date("2026-07-05T00:00:00.000Z"),
    action: "idle",
    battery_power_w: 0,
    expected_soc_pct: 50,
    buy_price: 20,
    sell_price: 5,
    expected_load_wh: 100,
    expected_solar_wh: 0,
    expected_grid_wh: 0,
    reason: "idle, holding 50.0 % SOC (buy 20.0 c/kWh)",
    ...overrides,
  };
}

function planResult(slot0: Partial<PlanSlotRow> = {}, planId = 1): PlannerRunResult {
  return {
    planId,
    slots: [slotRow(slot0)],
    optimiser: {
      slots: [],
      objectiveCents: 0,
      gridCostCents: 0,
      socPenaltyCents: 0,
      terminalCreditCents: 0,
      lambdaCentsPerKwh: 0,
      throughputWhByDay: [],
      cycleBudgetSatisfied: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  };
}

function telemetryRow(soc: number | null): TelemetryRow {
  return {
    time: new Date(),
    pv_power_w: null,
    battery_power_w: null,
    battery_soc_pct: soc,
    grid_power_w: null,
    load_power_w: null,
    ems_mode: null,
    extra: null,
  };
}

interface FakeClientOpts {
  enableRemoteEms?: (on: boolean) => Promise<boolean> | boolean;
  setControlMode?: (mode: number) => Promise<boolean> | boolean;
  setChargePowerW?: (w: number) => Promise<boolean> | boolean;
  setDischargePowerW?: (w: number) => Promise<boolean> | boolean;
  readSocLimits?: () => Promise<{ backupSocPct: number; chargeCutoffSocPct: number; dischargeCutoffSocPct: number }>;
}

function makeFakeClient(opts: FakeClientOpts = {}) {
  const calls: { fn: string; args: unknown[] }[] = [];
  const client: ExecutorModbusClient = {
    readSocLimits: async () => {
      calls.push({ fn: "readSocLimits", args: [] });
      if (opts.readSocLimits) return opts.readSocLimits();
      return { backupSocPct: 5, chargeCutoffSocPct: 100, dischargeCutoffSocPct: 5 };
    },
    enableRemoteEms: async (on) => {
      calls.push({ fn: "enableRemoteEms", args: [on] });
      return opts.enableRemoteEms ? opts.enableRemoteEms(on) : true;
    },
    setControlMode: async (mode) => {
      calls.push({ fn: "setControlMode", args: [mode] });
      return opts.setControlMode ? opts.setControlMode(mode) : true;
    },
    setChargePowerW: async (w) => {
      calls.push({ fn: "setChargePowerW", args: [w] });
      return opts.setChargePowerW ? opts.setChargePowerW(w) : true;
    },
    setDischargePowerW: async (w) => {
      calls.push({ fn: "setDischargePowerW", args: [w] });
      return opts.setDischargePowerW ? opts.setDischargePowerW(w) : true;
    },
  };
  return { client, calls };
}

interface MakeServiceOpts {
  now?: Date;
  soc?: number | null;
  settings?: SettingsFixture;
  runOnce?: (now: Date) => Promise<PlannerRunResult | null>;
  clientOpts?: FakeClientOpts;
  delay?: (ms: number) => Promise<void>;
}

function makeService(opts: MakeServiceOpts = {}) {
  const now = opts.now ?? new Date("2026-07-05T00:02:30.000Z");
  const decisions: DecisionRow[] = [];
  const { client, calls } = makeFakeClient(opts.clientOpts);
  const telemetry = opts.soc === undefined ? 50 : opts.soc;

  const deps: ExecutorServiceDeps = {
    runOnce: opts.runOnce ?? (async () => planResult()),
    client,
    settings: makeSettings({ ...DEFAULT_SETTINGS, ...opts.settings }),
    insertDecision: async (row) => {
      decisions.push(row);
    },
    latestTelemetry: async () => telemetryRow(telemetry),
    now: () => now,
    tz: "UTC",
    delay: opts.delay ?? (async () => {}),
    handbackBaseBackoffMs: 1,
    handbackMaxBackoffMs: 1,
  };

  const executor = new ExecutorService(deps);
  return { executor, decisions, calls, now };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("nextExecutorTick", () => {
  test("aligns to 5-min boundary + 35s, after the next boundary strictly", () => {
    const from = new Date("2026-07-05T00:02:00.000Z");
    const fire = nextExecutorTick(from);
    expect(fire.toISOString()).toBe("2026-07-05T00:05:35.000Z");
  });

  test("if already past the offset for the current boundary, rolls to the next one", () => {
    const from = new Date("2026-07-05T00:05:40.000Z");
    const fire = nextExecutorTick(from);
    expect(fire.toISOString()).toBe("2026-07-05T00:10:35.000Z");
  });

  test("exactly at a boundary rolls forward to +35s of that same boundary", () => {
    const from = new Date("2026-07-05T00:05:00.000Z");
    const fire = nextExecutorTick(from);
    expect(fire.toISOString()).toBe("2026-07-05T00:05:35.000Z");
  });
});

describe("directionOf", () => {
  test("classifies charge/discharge/other", () => {
    expect(directionOf("charge_solar")).toBe("charge");
    expect(directionOf("charge_grid")).toBe("charge");
    expect(directionOf("discharge_load")).toBe("discharge");
    expect(directionOf("discharge_grid")).toBe("discharge");
    expect(directionOf("idle")).toBe("other");
    expect(directionOf("self_consume")).toBe("other");
  });
});

describe("clampChargePowerW / clampDischargePowerW", () => {
  test("clamps charge to [0, maxChargeW]", () => {
    expect(clampChargePowerW(6000, 5000)).toBe(5000);
    expect(clampChargePowerW(-100, 5000)).toBe(0);
    expect(clampChargePowerW(3000, 5000)).toBe(3000);
  });

  test("clamps discharge magnitude, keeping the sign negative", () => {
    expect(clampDischargePowerW(-6000, 5000)).toBe(-5000);
    expect(clampDischargePowerW(-100, 5000)).toBe(-100);
    expect(clampDischargePowerW(0, 5000)).toBe(0);
  });
});

describe("clampDischargeFloorW", () => {
  test("passes through non-discharge (>=0) power unchanged", () => {
    expect(clampDischargeFloorW(0, 50, 10, 10_000, 0.81, 5)).toBe(0);
    expect(clampDischargeFloorW(1000, 50, 10, 10_000, 0.81, 5)).toBe(1000);
  });

  test("clamps discharge to the energy available above the floor", () => {
    // 20% above a 10% floor of a 10,000 Wh battery = 2,000 Wh battery-side.
    // eta_discharge = sqrt(0.81) = 0.9 -> 1,800 Wh AC-side deliverable this slot.
    // Over a 5-min (1/12 h) slot that's 1,800 * 12 = 21,600 W max.
    const clamped = clampDischargeFloorW(-30_000, 30, 10, 10_000, 0.81, 5);
    expect(clamped).toBeCloseTo(-21_600, 0);
  });

  test("clamps to exactly 0 once at the floor", () => {
    expect(clampDischargeFloorW(-5000, 10, 10, 10_000, 0.81, 5)).toBe(0);
  });

  test("does not clamp when comfortably above the floor and within the request", () => {
    expect(clampDischargeFloorW(-500, 80, 10, 10_000, 0.81, 5)).toBe(-500);
  });
});

describe("isOverrideDemandWindowPin", () => {
  test("true when reason mentions an override without demand-window protection", () => {
    expect(isOverrideDemandWindowPin("user override #3 (charge) in charge")).toBe(true);
  });

  test("false when reason also mentions demand-window protection", () => {
    expect(
      isOverrideDemandWindowPin("user override #3 (charge) in charge; demand window protection active (...)"),
    ).toBe(false);
  });

  test("false with no reason or no override mention", () => {
    expect(isOverrideDemandWindowPin(null)).toBe(false);
    expect(isOverrideDemandWindowPin("charging from grid at 4.2 c/kWh (2000 W)")).toBe(false);
  });
});

describe("applySafetyPipeline", () => {
  const baseCtx = {
    reason: null,
    slotMinutes: 5,
    currentSocPct: 50,
    floorPct: 10,
    capacityWh: 10_000,
    maxChargeW: 5000,
    maxDischargeW: 5000,
    roundTripEfficiency: 0.81,
    demandWindowProtected: false,
    minCommandWindowMin: 5,
    previousCommitted: null,
    now: new Date("2026-07-05T00:05:00.000Z"),
  };

  test("power clamp: over-limit charge is clamped and noted", () => {
    const result = applySafetyPipeline({ ...baseCtx, action: "charge_grid", batteryPowerW: 8000 });
    expect(result.action).toBe("charge_grid");
    expect(result.batteryPowerW).toBe(5000);
    expect(result.notes.some((n) => n.includes("power clamp"))).toBe(true);
  });

  test("discharge floor clamp forces idle when fully at the floor", () => {
    const result = applySafetyPipeline({
      ...baseCtx,
      action: "discharge_load",
      batteryPowerW: -3000,
      currentSocPct: 10,
      floorPct: 10,
    });
    expect(result.action).toBe("idle");
    expect(result.batteryPowerW).toBe(0);
    expect(result.notes.some((n) => n.includes("discharge floor"))).toBe(true);
  });

  test("demand-window guard rewrites charge_grid to self_consume when protected and not override-pinned", () => {
    const result = applySafetyPipeline({
      ...baseCtx,
      action: "charge_grid",
      batteryPowerW: 2000,
      demandWindowProtected: true,
      reason: "charging from grid at 4.2 c/kWh (2000 W)",
    });
    expect(result.action).toBe("self_consume");
    expect(result.batteryPowerW).toBe(0);
    expect(result.notes.some((n) => n.includes("demand-window guard"))).toBe(true);
  });

  test("demand-window guard does not rewrite when an override_demand_window pin is indicated", () => {
    const result = applySafetyPipeline({
      ...baseCtx,
      action: "charge_grid",
      batteryPowerW: 2000,
      demandWindowProtected: true,
      reason: "user override #7 (charge) in charge",
    });
    expect(result.action).toBe("charge_grid");
    expect(result.notes.length).toBe(0);
  });

  test("min command window holds a charge<->discharge flip before the window elapses", () => {
    const result = applySafetyPipeline({
      ...baseCtx,
      action: "discharge_load",
      batteryPowerW: -1000,
      previousCommitted: {
        action: "charge_grid",
        batteryPowerW: 2000,
        committedAt: new Date("2026-07-05T00:03:00.000Z"), // 2 min ago, window is 5 min
      },
    });
    expect(result.action).toBe("charge_grid");
    expect(result.batteryPowerW).toBe(2000);
    expect(result.heldByMinCommandWindow).toBe(true);
  });

  test("min command window allows the flip once the window has elapsed", () => {
    const result = applySafetyPipeline({
      ...baseCtx,
      action: "discharge_load",
      batteryPowerW: -1000,
      previousCommitted: {
        action: "charge_grid",
        batteryPowerW: 2000,
        committedAt: new Date("2026-07-05T00:00:00.000Z"), // 5 min ago, window is 5 min
      },
    });
    expect(result.action).toBe("discharge_load");
    expect(result.heldByMinCommandWindow).toBe(false);
  });

  test("min command window does not block transitions to idle/self_consume", () => {
    const result = applySafetyPipeline({
      ...baseCtx,
      action: "self_consume",
      batteryPowerW: 0,
      previousCommitted: {
        action: "charge_grid",
        batteryPowerW: 2000,
        committedAt: new Date("2026-07-05T00:04:30.000Z"),
      },
    });
    expect(result.action).toBe("self_consume");
    expect(result.heldByMinCommandWindow).toBe(false);
  });

  test("a safety guard forcing a change bypasses the min-command-window hold", () => {
    // Discharge floor forces idle; even though previous committed was
    // "charge" and the window hasn't elapsed, the safety-forced idle wins.
    const result = applySafetyPipeline({
      ...baseCtx,
      action: "discharge_load",
      batteryPowerW: -3000,
      currentSocPct: 10,
      floorPct: 10,
      previousCommitted: {
        action: "charge_grid",
        batteryPowerW: 2000,
        committedAt: new Date("2026-07-05T00:04:30.000Z"),
      },
    });
    expect(result.action).toBe("idle");
    expect(result.heldByMinCommandWindow).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ExecutorService.tick()
// ---------------------------------------------------------------------------

describe("ExecutorService.tick — shadow mode", () => {
  test("logs a decision and makes zero control calls", async () => {
    const { executor, decisions, calls } = makeService({
      runOnce: async () => planResult({ action: "charge_grid", battery_power_w: 2000 }),
    });

    await executor.tick();

    expect(decisions.length).toBe(1);
    expect(decisions[0]!.mode).toBe("shadow");
    expect(decisions[0]!.executed).toBe(false);
    expect(decisions[0]!.action).toBe("charge_grid");
    expect(calls.length).toBe(0);

    const status = executor.status();
    expect(status.mode).toBe("shadow");
    expect(status.lastAction).toBe("charge_grid");
    expect(status.failSafeEngaged).toBe(false);
  });

  test("planner-null records a decision with an error and does not touch Modbus", async () => {
    const { executor, decisions, calls } = makeService({ runOnce: async () => null });

    await executor.tick();

    expect(decisions.length).toBe(1);
    expect(decisions[0]!.executed).toBe(false);
    expect(decisions[0]!.error).toContain("planner returned no plan");
    expect(calls.length).toBe(0);
  });
});

describe("ExecutorService.tick — active mode", () => {
  const activeSettings: SettingsFixture = { ...DEFAULT_SETTINGS, mode: { shadow: false } };

  test("issues the documented charge control sequence and records executed=true", async () => {
    const { executor, decisions, calls } = makeService({
      settings: activeSettings,
      runOnce: async () => planResult({ action: "charge_grid", battery_power_w: 2000 }),
    });

    await executor.tick();

    expect(decisions.length).toBe(1);
    expect(decisions[0]!.mode).toBe("active");
    expect(decisions[0]!.executed).toBe(true);
    expect(decisions[0]!.battery_power_w).toBe(2000);

    const fns = calls.map((c) => c.fn);
    expect(fns).toContain("enableRemoteEms");
    expect(fns).toContain("readSocLimits");
    expect(fns).toContain("setChargePowerW");
    expect(calls.find((c) => c.fn === "setChargePowerW")!.args[0]).toBe(2000);
  });

  test("issues the documented discharge control sequence", async () => {
    const { executor, decisions, calls } = makeService({
      settings: activeSettings,
      runOnce: async () => planResult({ action: "discharge_load", battery_power_w: -1500 }),
    });

    await executor.tick();

    expect(decisions[0]!.executed).toBe(true);
    expect(calls.map((c) => c.fn)).toContain("setDischargePowerW");
    expect(calls.find((c) => c.fn === "setDischargePowerW")!.args[0]).toBe(1500);
  });

  test("self_consume/idle issue max-self-consumption", async () => {
    const { executor, decisions, calls } = makeService({
      settings: activeSettings,
      runOnce: async () => planResult({ action: "self_consume", battery_power_w: 0 }),
    });

    await executor.tick();

    expect(decisions[0]!.executed).toBe(true);
    const modeCalls = calls.filter((c) => c.fn === "setControlMode");
    expect(modeCalls.some((c) => c.args[0] === REMOTE_EMS_CONTROL_MODE.MaxSelfConsumption)).toBe(true);
  });

  test("a write failure records executed=false with an error", async () => {
    const { executor, decisions } = makeService({
      settings: activeSettings,
      runOnce: async () => planResult({ action: "charge_grid", battery_power_w: 2000 }),
      clientOpts: { setChargePowerW: async () => false },
    });

    await executor.tick();

    expect(decisions[0]!.executed).toBe(false);
    expect(decisions[0]!.error).toContain("charge setpoint");
    expect(executor.status().consecutiveModbusFailures).toBe(1);
  });

  test("3 consecutive failures engage fail-safe (disable-remote-EMS attempted) and record an alert", async () => {
    let now = new Date("2026-07-05T00:02:30.000Z");
    const { executor, decisions, calls } = makeService({
      settings: activeSettings,
      now,
      runOnce: async () => planResult({ action: "charge_grid", battery_power_w: 2000 }),
      clientOpts: { setChargePowerW: async () => false },
    });

    await executor.tick(now);
    now = new Date(now.getTime() + SLOT_MS);
    await executor.tick(now);
    now = new Date(now.getTime() + SLOT_MS);
    await executor.tick(now);

    expect(executor.status().consecutiveModbusFailures).toBe(3);
    expect(executor.status().failSafeEngaged).toBe(true);
    expect(decisions[2]!.reason).toContain("FAIL-SAFE ENGAGED");

    // Disabling remote EMS was attempted as part of the handback.
    const disableCalls = calls.filter((c) => c.fn === "enableRemoteEms" && c.args[0] === false);
    expect(disableCalls.length).toBeGreaterThanOrEqual(1);
  });

  test("recovery clears fail-safe once a control write succeeds with a fresh plan", async () => {
    let writesFail = true;
    let now = new Date("2026-07-05T00:02:30.000Z");
    const { executor, decisions } = makeService({
      settings: activeSettings,
      now,
      runOnce: async () => planResult({ action: "charge_grid", battery_power_w: 2000 }),
      clientOpts: { setChargePowerW: async () => !writesFail },
    });

    for (let i = 0; i < 3; i++) {
      await executor.tick(now);
      now = new Date(now.getTime() + SLOT_MS);
    }
    expect(executor.status().failSafeEngaged).toBe(true);

    writesFail = false;
    await executor.tick(now);

    expect(executor.status().failSafeEngaged).toBe(false);
    expect(executor.status().consecutiveModbusFailures).toBe(0);
    expect(decisions.at(-1)!.executed).toBe(true);
    expect(decisions.at(-1)!.reason).toContain("fail-safe cleared");
  });

  test("planner returning null in active mode engages fail-safe immediately", async () => {
    const { executor, decisions, calls } = makeService({
      settings: activeSettings,
      runOnce: async () => null,
    });

    await executor.tick();

    expect(executor.status().failSafeEngaged).toBe(true);
    expect(decisions[0]!.reason).toContain("FAIL-SAFE ENGAGED");
    expect(calls.some((c) => c.fn === "enableRemoteEms" && c.args[0] === false)).toBe(true);
  });

  test("stop() in active mode hands back control before resolving", async () => {
    const { executor, calls } = makeService({
      settings: activeSettings,
      runOnce: async () => planResult({ action: "charge_grid", battery_power_w: 2000 }),
    });

    executor.start();
    await executor.tick();
    await executor.stop();

    expect(calls.some((c) => c.fn === "enableRemoteEms" && c.args[0] === false)).toBe(true);
    expect(executor.status().running).toBe(false);
  });

  test("mode flip active -> shadow hands back control once", async () => {
    let shadow = false;
    let now = new Date("2026-07-05T00:02:30.000Z");
    const { client, calls } = makeFakeClient();
    const decisions: DecisionRow[] = [];
    const liveSettings: ExecutorSettingsSource = {
      get: async <K extends SettingsKey>(key: K): Promise<SettingsValue<K> | null> =>
        (key === "mode" ? { shadow } : DEFAULT_SETTINGS[key]) as SettingsValue<K> | null,
    };
    const executor = new ExecutorService({
      runOnce: async () => planResult({ action: "charge_grid", battery_power_w: 2000 }),
      client,
      settings: liveSettings,
      insertDecision: async (row) => {
        decisions.push(row);
      },
      latestTelemetry: async () => telemetryRow(50),
      now: () => now,
      tz: "UTC",
      delay: async () => {},
      handbackBaseBackoffMs: 1,
      handbackMaxBackoffMs: 1,
    });

    await executor.tick(now);
    expect(decisions[0]!.mode).toBe("active");

    shadow = true;
    now = new Date(now.getTime() + SLOT_MS);
    await executor.tick(now);

    expect(decisions[1]!.mode).toBe("shadow");
    const disableCallsAfterFlip = calls.filter((c) => c.fn === "enableRemoteEms" && c.args[0] === false);
    expect(disableCallsAfterFlip.length).toBe(1);

    // A further shadow tick shouldn't hand back again.
    now = new Date(now.getTime() + SLOT_MS);
    await executor.tick(now);
    const disableCallsAfterSecondShadowTick = calls.filter((c) => c.fn === "enableRemoteEms" && c.args[0] === false);
    expect(disableCallsAfterSecondShadowTick.length).toBe(1);
  });
});
