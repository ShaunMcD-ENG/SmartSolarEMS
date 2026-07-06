import { env } from "../config/env";
import type { SettingsKey, SettingsValue } from "../config/settings";
import type { Sql } from "../db/client";
import { getDb } from "../db/client";
import type { OverrideAction, OverrideRow, OverrideStatus } from "../db/overrides";
import type { PlanInput, PlanSlotRow, PriceRow, TelemetryRow } from "../db/repositories";
import type { ForecastSlot } from "../forecast/service";
import { SLOTS_PER_DAY, SLOT_MINUTES, slotInfo } from "../forecast/profiles";
import { createLogger } from "../lib/logger";
import type { OptimiserResult, OptimiserSlot, SocTarget } from "./optimiser";
import { GRID_IMPORT_TOLERANCE_WH, optimise } from "./optimiser";

const log = createLogger("planner");

const SLOT_MS = SLOT_MINUTES * 60_000;
/** Amber intervals are up to 30 min; look back far enough to find the price covering slot 0. */
const PRICE_LOOKBACK_MS = 35 * 60_000;
/** Cold-start flat load fallback if the forecast module yields nothing (500 W). */
const FALLBACK_LOAD_WH_PER_SLOT = 500 * (SLOT_MINUTES / 60);

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** Structural subset of SettingsService (src/config/settings.ts). */
export interface PlannerSettingsSource {
  get<K extends SettingsKey>(key: K): Promise<SettingsValue<K> | null>;
}

export interface BatteryThroughput {
  chargedWh: number;
  dischargedWh: number;
}

export interface PlannerServiceDeps {
  pricesBetween: (from: Date, to: Date, channel: string) => Promise<PriceRow[]>;
  /** ForecastService.forecast — bound method or wrapper. */
  forecast: (now: Date, horizonSlots: number) => Promise<ForecastSlot[]>;
  latestTelemetry: () => Promise<TelemetryRow | null>;
  settings: PlannerSettingsSource;
  relevantOverrides: (at: Date) => Promise<OverrideRow[]>;
  setOverrideStatus: (id: number, status: OverrideStatus) => Promise<boolean>;
  insertPlan: (plan: PlanInput, slots: PlanSlotRow[]) => Promise<number>;
  /**
   * Battery charge/discharge AC throughput integrated from telemetry_5m over
   * [from, to). Used both for "charged Wh today" (cycle budget, per the
   * design's chargedWhToday) and for how much energy an active energy-target
   * override has already delivered — hence the slightly generalised shape.
   * Defaults to a SQL implementation over telemetry_5m.
   */
  batteryThroughputWhBetween?: (from: Date, to: Date) => Promise<BatteryThroughput>;
  /** Injectable clock; defaults to () => new Date(). */
  now?: () => Date;
  /** IANA timezone for demand-window / SOC-target / calendar-day resolution; defaults to env().TZ. */
  tz?: string;
}

/**
 * Default throughput source: telemetry_5m integrates battery power into
 * battery_energy_wh per 5-min bucket (+ = charge, − = discharge).
 */
async function defaultBatteryThroughputWhBetween(
  from: Date,
  to: Date,
  sql: Sql = getDb(),
): Promise<BatteryThroughput> {
  const [row] = await sql<{ charged_wh: number | null; discharged_wh: number | null }[]>`
    SELECT
      COALESCE(SUM(GREATEST(battery_energy_wh, 0)), 0) AS charged_wh,
      COALESCE(SUM(GREATEST(-battery_energy_wh, 0)), 0) AS discharged_wh
    FROM telemetry_5m
    WHERE bucket >= ${from} AND bucket < ${to}
  `;
  return { chargedWh: Number(row?.charged_wh ?? 0), dischargedWh: Number(row?.discharged_wh ?? 0) };
}

// ---------------------------------------------------------------------------
// Pure assembly helpers (exported for direct unit testing)
// ---------------------------------------------------------------------------

/**
 * Maps price rows (arbitrary interval granularity, e.g. Amber's 30 min) onto
 * 5-min slots as a step function: each slot takes the latest row at or before
 * its start. Slots before the first row carry the first row back; slots after
 * the last row extend the last known price. Returns null when there are no
 * rows at all.
 */
export function mapPricesToSlots(rows: readonly PriceRow[], slotStarts: readonly Date[]): number[] | null {
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) => a.interval_start.getTime() - b.interval_start.getTime());
  const prices: number[] = [];
  let i = 0;
  for (const slotStart of slotStarts) {
    while (i + 1 < sorted.length && sorted[i + 1]!.interval_start.getTime() <= slotStart.getTime()) i++;
    prices.push(sorted[i]!.per_kwh);
  }
  return prices;
}

export interface DemandWindowConfig {
  enabled: boolean;
  start: string; // "HH:MM"
  end: string; // "HH:MM"
  bufferMin: number;
}

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

/**
 * Flags slots whose local (tz) wall-clock start falls inside
 * [start − buffer, end + buffer). Handles windows that cross local midnight.
 */
export function demandWindowFlags(
  slotStarts: readonly Date[],
  dw: DemandWindowConfig,
  tz: string,
): boolean[] {
  if (!dw.enabled) return slotStarts.map(() => false);
  const dayMin = 24 * 60;
  const from = ((hhmmToMinutes(dw.start) - dw.bufferMin) % dayMin + dayMin) % dayMin;
  const to = (hhmmToMinutes(dw.end) + dw.bufferMin) % dayMin;
  return slotStarts.map((slotStart) => {
    const minuteOfDay = slotInfo(slotStart, tz).slotOfDay * SLOT_MINUTES;
    return from <= to ? minuteOfDay >= from && minuteOfDay < to : minuteOfDay >= from || minuteOfDay < to;
  });
}

/**
 * Resolves goals.socTargets ({time:"HH:MM", socPct}) to horizon slot indices:
 * the first slot whose local wall-clock 5-min bucket contains the target time.
 */
export function resolveSocTargetSlots(
  slotStarts: readonly Date[],
  targets: readonly { time: string; socPct: number }[],
  tz: string,
): SocTarget[] {
  const resolved: SocTarget[] = [];
  for (const target of targets) {
    const targetSlotOfDay = Math.floor(hhmmToMinutes(target.time) / SLOT_MINUTES);
    const slotIndex = slotStarts.findIndex((s) => slotInfo(s, tz).slotOfDay === targetSlotOfDay);
    if (slotIndex >= 0) resolved.push({ slotIndex, socPct: target.socPct });
  }
  return resolved;
}

/** An override already screened for expiry/completion, with remaining energy resolved. */
export interface ResolvedOverride {
  id: number;
  action: OverrideAction;
  startTime: Date;
  endTime: Date | null;
  powerW: number | null;
  /** energy_wh minus what telemetry says has already been delivered; null = window-based. */
  remainingEnergyWh: number | null;
  overrideDemandWindow: boolean;
}

/**
 * Pins override slots onto the assembled optimiser slots (mutates `slots`).
 *
 * Precedence resolution (see optimiser.ts design decision 1): a slot that is
 * demand-window protected is NOT pinned unless the override carries
 * override_demand_window=true, in which case the pin is applied AND the
 * protected flag is cleared so the optimiser may trade with the grid there.
 * Overlapping overrides: the earliest-starting override wins a contested slot.
 */
export function applyOverridesToSlots(
  slots: OptimiserSlot[],
  overrides: readonly ResolvedOverride[],
  slot0: Date,
): void {
  const T = slots.length;
  for (const override of overrides) {
    const startIdx = Math.max(0, Math.floor((override.startTime.getTime() - slot0.getTime()) / SLOT_MS));
    const endIdx =
      override.endTime === null
        ? T
        : Math.min(T, Math.ceil((override.endTime.getTime() - slot0.getTime()) / SLOT_MS));
    for (let i = startIdx; i < endIdx; i++) {
      const slot = slots[i]!;
      if (slot.pinned) continue;
      if (slot.demandWindowProtected && !override.overrideDemandWindow) continue;
      if (override.overrideDemandWindow) slot.demandWindowProtected = false;
      slot.pinned = {
        action: override.action,
        powerW: override.powerW,
        energyTargetWh: override.remainingEnergyWh,
        overrideId: override.id,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// PlannerService
// ---------------------------------------------------------------------------

export interface PlannerRunResult {
  planId: number;
  slots: PlanSlotRow[];
  optimiser: OptimiserResult;
}

/**
 * Assembles the 24 h × 5 min optimiser input from prices, forecasts, settings
 * and overrides, runs the pure optimiser, and stores the resulting plan
 * (design/planner.md). All I/O is injected — see PlannerServiceDeps.
 */
export class PlannerService {
  private readonly deps: PlannerServiceDeps;
  private readonly throughputWhBetween: (from: Date, to: Date) => Promise<BatteryThroughput>;
  private readonly now: () => Date;
  private readonly tz: string;

  constructor(deps: PlannerServiceDeps) {
    this.deps = deps;
    this.throughputWhBetween = deps.batteryThroughputWhBetween ?? defaultBatteryThroughputWhBetween;
    this.now = deps.now ?? (() => new Date());
    this.tz = deps.tz ?? env().TZ;
  }

  /**
   * Runs one replan cycle. Returns null (after a warn log) when planning is
   * impossible: no buy prices at all, or no SOC telemetry.
   */
  async runOnce(now: Date = this.now()): Promise<PlannerRunResult | null> {
    const slot0 = new Date(Math.floor(now.getTime() / SLOT_MS) * SLOT_MS);
    const slotStarts = Array.from(
      { length: SLOTS_PER_DAY },
      (_, i) => new Date(slot0.getTime() + i * SLOT_MS),
    );
    const horizonEnd = new Date(slot0.getTime() + SLOTS_PER_DAY * SLOT_MS);
    const priceFrom = new Date(slot0.getTime() - PRICE_LOOKBACK_MS);

    // --- Prices (buy = general, sell = feedIn) -----------------------------
    const [buyRows, sellRows] = await Promise.all([
      this.deps.pricesBetween(priceFrom, horizonEnd, "general"),
      this.deps.pricesBetween(priceFrom, horizonEnd, "feedIn"),
    ]);
    const buyPrices = mapPricesToSlots(buyRows, slotStarts);
    if (!buyPrices) {
      log.warn("no buy (general) prices available at all; skipping this plan run");
      return null;
    }
    let sellPrices = mapPricesToSlots(sellRows, slotStarts);
    if (!sellPrices) {
      log.warn("no feed-in prices available; assuming 0 c/kWh export for this run");
      sellPrices = slotStarts.map(() => 0);
    }

    // --- State --------------------------------------------------------------
    const telemetry = await this.deps.latestTelemetry();
    const initialSocPct = telemetry?.battery_soc_pct ?? null;
    if (initialSocPct === null) {
      log.warn("no battery SOC telemetry available; skipping this plan run");
      return null;
    }

    // --- Forecast (partial horizon is fine; extend last known values) -------
    let forecastSlots: ForecastSlot[] = [];
    try {
      forecastSlots = await this.deps.forecast(now, SLOTS_PER_DAY);
    } catch (error) {
      log.warn("forecast failed; falling back to flat default load and zero solar", {
        error: String(error),
      });
    }
    const forecastByTime = new Map<number, ForecastSlot>();
    for (const f of forecastSlots) forecastByTime.set(f.slotStart.getTime(), f);
    let lastLoadWh = FALLBACK_LOAD_WH_PER_SLOT;
    let lastSolarWh = 0;
    let missingForecastSlots = 0;
    const loadWh: number[] = [];
    const solarWh: number[] = [];
    for (const slotStart of slotStarts) {
      const f = forecastByTime.get(slotStart.getTime());
      if (f) {
        lastLoadWh = f.loadWh;
        lastSolarWh = f.solarWh;
      } else {
        missingForecastSlots += 1;
      }
      loadWh.push(lastLoadWh);
      solarWh.push(lastSolarWh);
    }
    if (missingForecastSlots > 0 && forecastSlots.length > 0) {
      log.warn("forecast horizon shorter than 24 h; extending last known values", {
        missingForecastSlots,
      });
    }

    // --- Settings ------------------------------------------------------------
    const battery = (await this.deps.settings.get("battery")) ?? {
      capacityWh: 10000,
      usableMinSocPct: 10,
      maxChargeW: 5000,
      maxDischargeW: 5000,
      roundTripEfficiency: 0.9,
    };
    const goals = (await this.deps.settings.get("goals")) ?? {
      maxCyclesPerDay: 1,
      socTargets: [],
      minCommandWindowMin: 5,
    };
    const demandWindow = (await this.deps.settings.get("demandWindow")) ?? {
      enabled: false,
      start: "15:00",
      end: "20:00",
      bufferMin: 10,
    };
    const mode = (await this.deps.settings.get("mode")) ?? { shadow: true };

    // --- Demand window, day buckets, SOC targets ------------------------------
    const protectedFlags = demandWindowFlags(slotStarts, demandWindow, this.tz);
    const dateKeys = slotStarts.map((s) => slotInfo(s, this.tz).dateKey);
    const dayIndexByKey = new Map<string, number>();
    for (const key of dateKeys) {
      if (!dayIndexByKey.has(key)) dayIndexByKey.set(key, dayIndexByKey.size);
    }
    const socTargets = resolveSocTargetSlots(slotStarts, goals.socTargets, this.tz);

    const slots: OptimiserSlot[] = slotStarts.map((slotStart, i) => ({
      slotStart,
      buyPriceCentsPerKwh: buyPrices[i]!,
      sellPriceCentsPerKwh: sellPrices[i]!,
      loadWh: loadWh[i]!,
      solarWh: solarWh[i]!,
      demandWindowProtected: protectedFlags[i]!,
      dayIndex: dayIndexByKey.get(dateKeys[i]!)!,
    }));

    // --- Overrides: expiry/completion screening, then pinning -----------------
    const overrides = await this.deps.relevantOverrides(now);
    const resolved: ResolvedOverride[] = [];
    for (const override of overrides) {
      if (override.end_time !== null && override.end_time.getTime() <= now.getTime()) {
        // relevantOverrides normally filters these; defensive.
        await this.deps.setOverrideStatus(override.id, "expired");
        log.info("override expired (window passed)", { overrideId: override.id });
        continue;
      }
      let remainingEnergyWh: number | null = null;
      if (override.energy_wh !== null) {
        let deliveredWh = 0;
        if (override.start_time.getTime() <= now.getTime()) {
          const throughput = await this.throughputWhBetween(override.start_time, now);
          deliveredWh = override.action === "discharge" ? throughput.dischargedWh : throughput.chargedWh;
        }
        remainingEnergyWh = override.energy_wh - deliveredWh;
        if (remainingEnergyWh <= 0) {
          await this.deps.setOverrideStatus(override.id, "completed");
          log.info("override completed (energy target met)", {
            overrideId: override.id,
            energyWh: override.energy_wh,
            deliveredWh,
          });
          continue;
        }
      }
      resolved.push({
        id: override.id,
        action: override.action,
        startTime: override.start_time,
        endTime: override.end_time,
        powerW: override.power_w,
        remainingEnergyWh,
        overrideDemandWindow: override.override_demand_window,
      });
    }
    applyOverridesToSlots(slots, resolved, slot0);

    // --- Cycle budget: per calendar day, minus today's used throughput --------
    const usableCapacityWh = battery.capacityWh * (1 - battery.usableMinSocPct / 100);
    const dailyBudgetWh = goals.maxCyclesPerDay * usableCapacityWh;
    // Local midnight of slot0's calendar day (slot starts are 5-min aligned and
    // real tz offsets are whole minutes, so slotOfDay*5 minutes before slot0).
    const dayStart = new Date(slot0.getTime() - slotInfo(slot0, this.tz).slotOfDay * SLOT_MS);
    const usedTodayWh = (await this.throughputWhBetween(dayStart, now)).chargedWh;
    const cycleBudgetWhByDay = [...dayIndexByKey.values()].map((dayIndex) =>
      dayIndex === 0 ? Math.max(0, dailyBudgetWh - usedTodayWh) : dailyBudgetWh,
    );

    // --- Optimise --------------------------------------------------------------
    const result = optimise({
      slots,
      battery: {
        capacityWh: battery.capacityWh,
        minReservePct: battery.usableMinSocPct,
        maxChargeW: battery.maxChargeW,
        maxDischargeW: battery.maxDischargeW,
        roundTripEfficiency: battery.roundTripEfficiency,
      },
      initialSocPct,
      socTargets,
      cycleBudgetWhByDay,
      lambdaSearch: true,
      minCommandWindowSlots: Math.max(1, Math.ceil(goals.minCommandWindowMin / SLOT_MINUTES)),
    });

    // --- Store -------------------------------------------------------------------
    const reason = this.buildSlot0Reason(result, slots, socTargets, demandWindow, goals.socTargets);
    const planSlots: PlanSlotRow[] = result.slots.map((slot, i) => ({
      slot_start: slot.slotStart,
      action: slot.action,
      battery_power_w: Math.round(slot.batteryPowerW),
      expected_soc_pct: slot.expectedSocPct,
      buy_price: buyPrices[i]!,
      sell_price: sellPrices[i]!,
      expected_load_wh: loadWh[i]!,
      expected_solar_wh: solarWh[i]!,
      expected_grid_wh: slot.expectedGridWh,
      reason: i === 0 ? reason : null,
      pinned_override_id: slot.pinnedByOverrideId,
      demand_window_protected: slot.demandWindowProtected,
    }));

    const planId = await this.deps.insertPlan(
      {
        mode: mode.shadow ? "shadow" : "active",
        current_soc_pct: initialSocPct,
        objective_cost_cents: result.objectiveCents,
        summary: {
          objectiveCents: result.objectiveCents,
          gridCostCents: result.gridCostCents,
          socPenaltyCents: result.socPenaltyCents,
          terminalCreditCents: result.terminalCreditCents,
          lambdaCentsPerKwh: result.lambdaCentsPerKwh,
          throughputWhByDay: result.throughputWhByDay,
          cycleBudgetWhByDay,
          cycleBudgetSatisfied: result.cycleBudgetSatisfied,
        },
      },
      planSlots,
    );

    log.info("plan stored", {
      planId,
      objectiveCents: Math.round(result.objectiveCents * 10) / 10,
      lambdaCentsPerKwh: result.lambdaCentsPerKwh,
      slot0Action: result.slots[0]!.action,
    });
    return { planId, slots: planSlots, optimiser: result };
  }

  /** Human-readable explanation for the slot the executor will act on. */
  private buildSlot0Reason(
    result: OptimiserResult,
    slots: readonly OptimiserSlot[],
    socTargets: readonly SocTarget[],
    demandWindow: DemandWindowConfig,
    rawSocTargets: readonly { time: string; socPct: number }[],
  ): string {
    const slot0 = slots[0]!;
    const out0 = result.slots[0]!;
    const buy = slot0.buyPriceCentsPerKwh.toFixed(1);
    const sell = slot0.sellPriceCentsPerKwh.toFixed(1);
    const powerW = Math.abs(Math.round(out0.batteryPowerW));

    const parts: string[] = [];
    switch (out0.action) {
      case "charge_grid":
        parts.push(`charging from grid at ${buy} c/kWh (${powerW} W)`);
        break;
      case "charge_solar":
        parts.push(`charging from excess solar (${powerW} W)`);
        break;
      case "discharge_load":
        parts.push(`discharging to cover load, avoiding import at ${buy} c/kWh (${powerW} W)`);
        break;
      case "discharge_grid":
        parts.push(`exporting to grid at ${sell} c/kWh (${powerW} W)`);
        break;
      case "self_consume":
        parts.push("self-consumption: battery follows net load");
        break;
      case "idle":
        parts.push(`idle, holding ${out0.expectedSocPct.toFixed(1)} % SOC (buy ${buy} c/kWh)`);
        break;
    }
    if (slot0.pinned) {
      parts.push(`user override #${slot0.pinned.overrideId} (${slot0.pinned.action}) in charge`);
    }
    if (slot0.demandWindowProtected) {
      parts.push(
        `demand window protection active (${demandWindow.start}–${demandWindow.end} +${demandWindow.bufferMin} min buffer, ` +
          `grid import ≤ ${GRID_IMPORT_TOLERANCE_WH} Wh)`,
      );
    }
    const nextTarget = [...socTargets].sort((a, b) => a.slotIndex - b.slotIndex)[0];
    if (nextTarget) {
      const raw = rawSocTargets.find((t) => t.socPct === nextTarget.socPct);
      parts.push(`SOC target ${nextTarget.socPct} % by ${raw?.time ?? `slot ${nextTarget.slotIndex}`}`);
    }
    return parts.join("; ");
  }
}
