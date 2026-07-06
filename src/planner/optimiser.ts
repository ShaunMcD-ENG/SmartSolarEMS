import type { OverrideAction } from "../db/overrides";

/**
 * Pure 24 h rolling-horizon battery optimiser (design/planner.md).
 *
 * Backward dynamic program over SOC discretised into 0.5 % steps
 * (capacity/200), floored at the min-reserve SOC. Battery power is enumerated
 * as integer numbers of SOC grid steps per 5-minute slot (up to
 * MAX_LEVELS_PER_DIRECTION per direction, plus always 0) so every transition
 * lands exactly on the SOC grid — no rounding drift. ±1 step and ±max are
 * always included, so fine adjustments (e.g. exactly hitting a SOC target)
 * remain reachable via combinations of steps.
 *
 * Efficiency: ηc = ηd = √(roundTripEfficiency); chargeIn / dischargeOut are
 * AC-side energies per the balance equation in design/planner.md.
 *
 * No I/O, no clocks, no logging — everything comes in via OptimiserInput.
 *
 * Design decisions documented here (referenced by the planner service):
 *
 * 1. Demand-window vs pin precedence: the CALLER resolves the
 *    `override_demand_window` flag. A pin on a slot whose
 *    `demandWindowProtected` is true is DROPPED by the optimiser (protection
 *    wins — matches "safety > demand window > override"). Callers wanting an
 *    override to beat the demand window must clear `demandWindowProtected`
 *    on those slots (that is what the service does when
 *    override_demand_window=true).
 *
 * 2. Demand-window relaxation: transitions with grid import >
 *    GRID_IMPORT_TOLERANCE_WH are forbidden inside protected slots, UNLESS
 *    no allowed transition exists from a state (load exceeds solar + max
 *    feasible discharge, e.g. battery already at reserve). In that case the
 *    feasible transition with MINIMAL grid import is permitted instead of
 *    returning no plan ("physically unavoidable" relaxation).
 *
 * 3. Energy-target pins: a run of slots pinned with the same `overrideId`
 *    and an `energyTargetWh` is resolved at preprocessing time into per-slot
 *    forced charge/discharge deltas — the action is forced, so delivery at
 *    the commanded rate is deterministic and can be accumulated
 *    slot-by-slot without augmenting the DP state. Slots after the target
 *    is met are released back to free optimisation. If the battery
 *    saturates (full/empty) mid-delivery the per-state clamp reduces the
 *    actually-delivered energy; the true delivered energy along the chosen
 *    path is reported in `overrideDeliveredWh` so the caller can see any
 *    shortfall. Non-contiguous pinned segments sharing an overrideId share
 *    one remaining-energy budget.
 *
 * 4. Min command window: post-process on the DP path. Runs of battery
 *    command *direction* (charge / discharge) shorter than
 *    `minCommandWindowSlots` are merged into a neighbouring run by copying
 *    the neighbour's power level; the cheaper of merge-left / merge-right
 *    (full re-simulation including SOC-target and demand-window penalties)
 *    is kept. Idle runs are exempt (the executor allows idle→action and
 *    action→idle transitions; only charge↔discharge flips are hardware
 *    commands that must persist). Runs containing pinned slots are exempt
 *    (pins win). Merging can nudge throughput slightly past the cycle
 *    budget; `cycleBudgetSatisfied` reflects the final path.
 *
 * 5. Terminal credit: V[T][s] = −(SOC energy in Wh) × mean buy price over
 *    the horizon, so end-of-horizon energy isn't dumped. It is included in
 *    `objectiveCents` (as −terminalCreditCents).
 */

export type PlanAction =
  | "charge_solar"
  | "charge_grid"
  | "discharge_load"
  | "discharge_grid"
  | "idle"
  | "self_consume";

/** Per-slot pin derived from a user override (see design decision 1/3 above). */
export interface SlotPin {
  action: OverrideAction;
  /** Explicit power in W; null/undefined = max rate. Charge/discharge only. */
  powerW?: number | null;
  /**
   * Total AC energy (Wh) the override should deliver, counted from its first
   * pinned slot. Give the SAME value on every slot of the override; the
   * optimiser spreads delivery across the run and frees trailing slots.
   */
  energyTargetWh?: number | null;
  /** Identity used to group pinned slots and key overrideDeliveredWh. */
  overrideId?: number;
}

export interface OptimiserSlot {
  slotStart: Date;
  buyPriceCentsPerKwh: number;
  sellPriceCentsPerKwh: number;
  loadWh: number;
  solarWh: number;
  demandWindowProtected: boolean;
  /** Calendar-day bucket for the cycle budget (0 = today, 1 = tomorrow, ...). Default 0. */
  dayIndex?: number;
  pinned?: SlotPin;
}

export interface OptimiserBattery {
  capacityWh: number;
  minReservePct: number;
  maxChargeW: number;
  maxDischargeW: number;
  /** Round-trip efficiency in (0, 1]; split as ηc = ηd = √η. */
  roundTripEfficiency: number;
}

export interface SocTarget {
  slotIndex: number;
  socPct: number;
}

export interface OptimiserInput {
  slots: OptimiserSlot[];
  battery: OptimiserBattery;
  initialSocPct: number;
  socTargets: SocTarget[];
  /**
   * Charge-throughput budget (AC Wh) per dayIndex — index 0 should already
   * have today's used throughput subtracted. Missing entries = unlimited.
   */
  cycleBudgetWhByDay: number[];
  /** When false, run once with λ=0 and only report whether the budget fits. */
  lambdaSearch: boolean;
  /** Minimum slots a battery command direction must persist; ≤1 disables. */
  minCommandWindowSlots?: number;
}

export interface OptimiserSlotResult {
  slotStart: Date;
  action: PlanAction;
  /** Signed W, + = charge. AC-side. */
  batteryPowerW: number;
  /** SOC at the END of the slot, percent. */
  expectedSocPct: number;
  /** Signed Wh, + = import. */
  expectedGridWh: number;
  /** Grid cost of this slot in cents (import·buy − export·sell). */
  costCents: number;
  /**
   * Id of the override that pinned this slot (design decisions 1/3 above),
   * or null if this slot was freely optimised. Threaded through so callers
   * (the executor's defence-in-depth demand-window guard, in particular)
   * can rely on a structured signal instead of parsing the human-readable
   * `reason` string. Mirrors `pinOverrideId` used internally during solve.
   */
  pinnedByOverrideId: number | null;
  /**
   * Final demand-window-protection state used by the optimiser for this
   * slot — i.e. the caller's input flag (OptimiserSlot.demandWindowProtected),
   * echoed back per-slot. Always false for a slot pinned by an
   * `override_demand_window=true` override (the caller clears the flag
   * before calling optimise() — see applyOverridesToSlots), so
   * `pinnedByOverrideId !== null` and `demandWindowProtected === true` never
   * both hold for the same slot.
   */
  demandWindowProtected: boolean;
}

export interface OptimiserResult {
  slots: OptimiserSlotResult[];
  /** gridCostCents + socPenaltyCents − terminalCreditCents. Excludes λ terms. */
  objectiveCents: number;
  gridCostCents: number;
  socPenaltyCents: number;
  terminalCreditCents: number;
  /** λ actually used (¢/kWh on charged energy); 0 when the budget already fits. */
  lambdaCentsPerKwh: number;
  /** AC Wh charged per dayIndex along the final path. */
  throughputWhByDay: number[];
  cycleBudgetSatisfied: boolean;
  /** Actually-delivered AC Wh per overrideId along the final path. */
  overrideDeliveredWh: Record<number, number>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** SOC grid resolution: capacity/200 = 0.5 % per step. */
export const SOC_STEPS = 200;
/** 5-minute slots ⇒ Wh = W / 12. */
const SLOTS_PER_HOUR = 12;
/** Grid import allowed inside a protected demand-window slot ("small tolerance"). */
export const GRID_IMPORT_TOLERANCE_WH = 50;
/** Soft SOC-target penalty: 1000 ¢ per % shortfall at the target slot. */
const SOC_TARGET_PENALTY_CENTS_PER_PCT = 1000;
const LAMBDA_MAX_CENTS_PER_KWH = 500;
const LAMBDA_BINARY_SEARCH_ITERATIONS = 8;
/** Battery power levels per direction (≈21 total including 0). */
const MAX_LEVELS_PER_DIRECTION = 10;
/** Heavy per-Wh penalty for demand-window violations during merge re-simulation. */
const DW_VIOLATION_CENTS_PER_WH = 10;
const MERGE_MAX_PASSES = 64;
/** Cycle-budget comparison slack (Wh) so float noise never triggers a λ search. */
const BUDGET_SLACK_WH = 0.5;

interface Run {
  start: number;
  /** exclusive */
  end: number;
  dir: -1 | 0 | 1;
}

// ---------------------------------------------------------------------------
// optimise()
// ---------------------------------------------------------------------------

export function optimise(input: OptimiserInput): OptimiserResult {
  const T = input.slots.length;
  if (T === 0) throw new Error("optimise: at least one slot is required");
  const bat = input.battery;
  if (!(bat.capacityWh > 0)) throw new Error("optimise: battery.capacityWh must be > 0");

  const eta = Math.sqrt(Math.min(Math.max(bat.roundTripEfficiency, 0.01), 1));
  const stepWh = bat.capacityWh / SOC_STEPS;
  const sMin = Math.max(0, Math.min(SOC_STEPS, Math.ceil((bat.minReservePct / 100) * SOC_STEPS)));
  const sMax = SOC_STEPS;
  const S = sMax - sMin + 1;
  const maxChargeAcWh = bat.maxChargeW / SLOTS_PER_HOUR;
  const maxDischargeAcWh = bat.maxDischargeW / SLOTS_PER_HOUR;
  const maxChargeSteps = Math.floor((maxChargeAcWh * eta) / stepWh);
  const maxDischargeSteps = Math.floor(maxDischargeAcWh / (eta * stepWh));

  // Initial SOC clamped onto the grid; below-reserve starts are lifted to the
  // floor (the DP never plans below reserve; real-world safety is the
  // executor's job).
  const s0 = Math.min(sMax, Math.max(sMin, Math.round(input.initialSocPct * (SOC_STEPS / 100))));

  /** AC-side energy for a delta in grid steps: + = chargeIn, − = dischargeOut. */
  const acForDelta = (d: number): number =>
    d > 0 ? (d * stepWh) / eta : d < 0 ? d * stepWh * eta : 0;

  /** Direction-preserving clamp of a delta to what's feasible from state s. */
  const clampDelta = (d: number, s: number): number =>
    d > 0 ? Math.min(d, sMax - s) : d < 0 ? Math.max(d, sMin - s) : 0;

  // -------------------------------------------------------------------------
  // Per-slot preparation
  // -------------------------------------------------------------------------

  const buy = new Float64Array(T);
  const sell = new Float64Array(T);
  const netLoad = new Float64Array(T);
  const prot = new Uint8Array(T);
  const dayIdx = new Int32Array(T);
  /** Forced delta for pinned slots; null = free slot. */
  const pinDelta: (number | null)[] = new Array<number | null>(T).fill(null);
  const pinAction: (OverrideAction | null)[] = new Array<OverrideAction | null>(T).fill(null);
  const pinOverrideId: (number | null)[] = new Array<number | null>(T).fill(null);

  let buySum = 0;
  for (let t = 0; t < T; t++) {
    const slot = input.slots[t]!;
    buy[t] = slot.buyPriceCentsPerKwh;
    sell[t] = slot.sellPriceCentsPerKwh;
    netLoad[t] = slot.loadWh - slot.solarWh;
    prot[t] = slot.demandWindowProtected ? 1 : 0;
    dayIdx[t] = slot.dayIndex ?? 0;
    buySum += slot.buyPriceCentsPerKwh;
  }
  const meanBuy = buySum / T;

  /** Single self-consume delta: battery follows net load, minimising |grid flow|. */
  const selfConsumeDelta = (net: number): number => {
    if (net > 0) {
      const ideal = net / (eta * stepWh); // discharge steps
      const lo = Math.max(0, Math.min(Math.floor(ideal), maxDischargeSteps));
      const hi = Math.max(0, Math.min(Math.ceil(ideal), maxDischargeSteps));
      const gridAbs = (k: number): number => Math.abs(net - k * stepWh * eta);
      return -(hi !== lo && gridAbs(hi) < gridAbs(lo) - 1e-9 ? hi : lo);
    }
    if (net < 0) {
      const excess = Math.min(-net, maxChargeAcWh);
      const ideal = (excess * eta) / stepWh; // charge steps
      const lo = Math.max(0, Math.min(Math.floor(ideal), maxChargeSteps));
      const hi = Math.max(0, Math.min(Math.ceil(ideal), maxChargeSteps));
      const gridAbs = (k: number): number => Math.abs(net + (k * stepWh) / eta);
      return hi !== lo && gridAbs(hi) < gridAbs(lo) - 1e-9 ? hi : lo;
    }
    return 0;
  };

  // Pin preprocessing (design decisions 1 & 3 in the header comment).
  {
    const remainingByKey = new Map<number | string, number>();
    let anonKey = 0;
    let prevPinned = false;
    for (let t = 0; t < T; t++) {
      const pin = input.slots[t]!.pinned;
      if (!pin) {
        prevPinned = false;
        continue;
      }
      // Demand-window protection beats pins (caller resolves override_demand_window
      // by clearing the protected flag when the override may breach the window).
      if (prot[t] === 1) {
        prevPinned = false;
        continue;
      }
      if (!prevPinned && pin.overrideId === undefined) anonKey += 1;
      const key: number | string = pin.overrideId ?? `anon-${anonKey}`;
      prevPinned = true;
      pinAction[t] = pin.action;
      pinOverrideId[t] = pin.overrideId ?? null;

      switch (pin.action) {
        case "idle":
          pinDelta[t] = 0;
          break;
        case "self_consume":
          pinDelta[t] = selfConsumeDelta(netLoad[t]!);
          break;
        case "charge":
        case "discharge": {
          const isCharge = pin.action === "charge";
          const maxAc = isCharge ? maxChargeAcWh : maxDischargeAcWh;
          const maxSteps = isCharge ? maxChargeSteps : maxDischargeSteps;
          const rateAc =
            pin.powerW !== null && pin.powerW !== undefined
              ? Math.min(Math.max(pin.powerW, 0), isCharge ? bat.maxChargeW : bat.maxDischargeW) / SLOTS_PER_HOUR
              : maxAc;
          const stepAc = isCharge ? stepWh / eta : stepWh * eta; // AC Wh per grid step
          if (pin.energyTargetWh !== null && pin.energyTargetWh !== undefined) {
            if (!remainingByKey.has(key)) remainingByKey.set(key, pin.energyTargetWh);
            const remaining = remainingByKey.get(key)!;
            if (remaining <= stepAc / 2) {
              // Target met (within half a grid step): free the slot.
              pinDelta[t] = null;
              pinAction[t] = null;
              pinOverrideId[t] = null;
              break;
            }
            const targetAc = Math.min(rateAc, remaining);
            let steps = Math.min(maxSteps, Math.max(1, Math.round(targetAc / stepAc)));
            if (maxSteps <= 0) steps = 0;
            remainingByKey.set(key, remaining - steps * stepAc);
            pinDelta[t] = isCharge ? steps : -steps;
          } else {
            const steps = Math.min(maxSteps, Math.max(0, Math.round(rateAc / stepAc)));
            pinDelta[t] = isCharge ? steps : -steps;
          }
          break;
        }
      }
    }
  }

  // SOC targets (soft): penalty applied to the state at the START of the slot.
  const targetBySlot = new Float64Array(T).fill(-1);
  for (const target of input.socTargets) {
    if (target.slotIndex < 0 || target.slotIndex >= T) continue;
    targetBySlot[target.slotIndex] = Math.max(targetBySlot[target.slotIndex]!, target.socPct);
  }

  // Candidate battery levels for free slots: integer grid-step deltas,
  // subsampled to ≤ MAX_LEVELS_PER_DIRECTION per direction (±1 and ±max kept).
  const levelSteps = (maxSteps: number): number[] => {
    if (maxSteps <= 0) return [];
    if (maxSteps <= MAX_LEVELS_PER_DIRECTION) return Array.from({ length: maxSteps }, (_, i) => i + 1);
    const set = new Set<number>([1, maxSteps]);
    for (let i = 1; i <= MAX_LEVELS_PER_DIRECTION; i++) {
      set.add(Math.max(1, Math.round((i * maxSteps) / MAX_LEVELS_PER_DIRECTION)));
    }
    return [...set].sort((a, b) => a - b);
  };
  const deltas: number[] = [
    ...levelSteps(maxDischargeSteps).map((d) => -d).reverse(),
    0,
    ...levelSteps(maxChargeSteps),
  ];
  const K = deltas.length;
  const acByDelta = new Float64Array(K);
  for (let k = 0; k < K; k++) acByDelta[k] = acForDelta(deltas[k]!);

  const nDays = Math.max(1, ...input.slots.map((s) => (s.dayIndex ?? 0) + 1));

  const budgetFits = (throughputWhByDay: readonly number[]): boolean => {
    for (let d = 0; d < throughputWhByDay.length; d++) {
      const budget = input.cycleBudgetWhByDay[d];
      if (budget !== undefined && throughputWhByDay[d]! > budget + BUDGET_SLACK_WH) return false;
    }
    return true;
  };

  // -------------------------------------------------------------------------
  // Backward DP for a given λ; returns the planned delta path.
  // -------------------------------------------------------------------------

  const solve = (lambda: number): { planned: Int16Array; throughputWhByDay: number[] } => {
    const vNext = new Float64Array(S);
    const vCur = new Float64Array(S);
    const choice = new Int16Array(T * S);

    // Terminal credit so end-of-horizon energy isn't dumped.
    for (let si = 0; si < S; si++) vNext[si] = -((sMin + si) * stepWh * meanBuy) / 1000;

    for (let t = T - 1; t >= 0; t--) {
      const b = buy[t]!;
      const se = sell[t]!;
      const nl = netLoad[t]!;
      const protectedSlot = prot[t] === 1;
      const tgt = targetBySlot[t]!;
      const pd = pinDelta[t] ?? null;
      const rowBase = t * S;

      for (let si = 0; si < S; si++) {
        const s = sMin + si;
        let best = Infinity;
        let bestD = 0;

        if (pd !== null) {
          // Pinned: single forced delta, clamped to what's feasible from s
          // (safety — reserve/capacity — always beats the pin).
          const d = clampDelta(pd, s);
          const ac = acForDelta(d);
          const grid = nl + ac;
          let cost = grid > 0 ? (grid * b) / 1000 : (grid * se) / 1000;
          if (ac > 0) cost += (lambda * ac) / 1000;
          best = cost + vNext[si + d]!;
          bestD = d;
        } else {
          // Free slot: enumerate candidate levels. Inside a protected
          // demand-window slot, importing transitions are forbidden but we
          // track the minimal-import fallback (relaxation, design decision 2).
          let fbBest = Infinity;
          let fbGrid = Infinity;
          let fbD = 0;
          for (let k = 0; k < K; k++) {
            const d = deltas[k]!;
            const s2 = s + d;
            if (s2 < sMin || s2 > sMax) continue;
            const ac = acByDelta[k]!;
            const grid = nl + ac;
            let cost = grid > 0 ? (grid * b) / 1000 : (grid * se) / 1000;
            if (ac > 0) cost += (lambda * ac) / 1000;
            const total = cost + vNext[s2 - sMin]!;
            if (protectedSlot && grid > GRID_IMPORT_TOLERANCE_WH) {
              if (grid < fbGrid - 1e-9 || (Math.abs(grid - fbGrid) <= 1e-9 && total < fbBest)) {
                fbGrid = grid;
                fbBest = total;
                fbD = d;
              }
              continue;
            }
            if (total < best) {
              best = total;
              bestD = d;
            }
          }
          if (best === Infinity) {
            // Physically unavoidable import: allow the minimal-import move,
            // but with a heavy (finite) violation penalty. Without it, the
            // "arrive at the window empty" states would look as cheap as
            // ordinary imports and the DP would never bother pre-charging;
            // with it, pre-charging dominates whenever it is possible, while
            // truly unavoidable imports still yield a plan instead of none.
            best = fbBest + (fbGrid - GRID_IMPORT_TOLERANCE_WH) * DW_VIOLATION_CENTS_PER_WH;
            bestD = fbD;
          }
        }

        if (tgt >= 0) {
          best += SOC_TARGET_PENALTY_CENTS_PER_PCT * Math.max(0, tgt - (s * 100) / SOC_STEPS);
        }
        vCur[si] = best;
        choice[rowBase + si] = bestD;
      }
      vNext.set(vCur);
    }

    // Forward extraction of the optimal path.
    const planned = new Int16Array(T);
    const throughputWhByDay = new Array<number>(nDays).fill(0);
    let s = s0;
    for (let t = 0; t < T; t++) {
      const d = choice[t * S + (s - sMin)]!;
      planned[t] = d;
      if (d > 0) throughputWhByDay[dayIdx[t]!]! += acForDelta(d);
      s += d;
    }
    return { planned, throughputWhByDay };
  };

  // -------------------------------------------------------------------------
  // λ search (Lagrangian on charged Wh) — skip when λ=0 already fits.
  // -------------------------------------------------------------------------

  let lambdaUsed = 0;
  let path = solve(0);
  if (input.lambdaSearch && !budgetFits(path.throughputWhByDay)) {
    const atMax = solve(LAMBDA_MAX_CENTS_PER_KWH);
    if (!budgetFits(atMax.throughputWhByDay)) {
      // Infeasible even at λmax (e.g. pinned/demand-window charging alone
      // exceeds the budget): best effort, report unsatisfied.
      lambdaUsed = LAMBDA_MAX_CENTS_PER_KWH;
      path = atMax;
    } else {
      let lo = 0;
      let hi = LAMBDA_MAX_CENTS_PER_KWH;
      let bestPath = atMax;
      let bestLambda = LAMBDA_MAX_CENTS_PER_KWH;
      for (let i = 0; i < LAMBDA_BINARY_SEARCH_ITERATIONS; i++) {
        const mid = (lo + hi) / 2;
        const candidate = solve(mid);
        if (budgetFits(candidate.throughputWhByDay)) {
          hi = mid;
          bestPath = candidate;
          bestLambda = mid;
        } else {
          lo = mid;
        }
      }
      lambdaUsed = bestLambda;
      path = bestPath;
    }
  }

  // -------------------------------------------------------------------------
  // Forward re-simulation used for both merging and final output.
  // -------------------------------------------------------------------------

  interface Simulation {
    applied: Int16Array;
    socStartPct: Float64Array;
    acWh: Float64Array;
    gridWh: Float64Array;
    costCents: Float64Array;
    endS: number;
    gridCostCents: number;
    socPenaltyCents: number;
    dwViolationCents: number;
    terminalCreditCents: number;
    /** gridCost + socPenalty + dwViolation − terminalCredit (merge comparator). */
    penalisedCents: number;
  }

  const simulate = (planned: ArrayLike<number>): Simulation => {
    const applied = new Int16Array(T);
    const socStartPct = new Float64Array(T);
    const acWh = new Float64Array(T);
    const gridWh = new Float64Array(T);
    const costCents = new Float64Array(T);
    let s = s0;
    let gridCostCents = 0;
    let socPenaltyCents = 0;
    let dwViolationCents = 0;
    for (let t = 0; t < T; t++) {
      socStartPct[t] = (s * 100) / SOC_STEPS;
      const tgt = targetBySlot[t]!;
      if (tgt >= 0) {
        socPenaltyCents += SOC_TARGET_PENALTY_CENTS_PER_PCT * Math.max(0, tgt - (s * 100) / SOC_STEPS);
      }
      const d = clampDelta(planned[t]!, s);
      const ac = acForDelta(d);
      const grid = netLoad[t]! + ac;
      const cost = grid > 0 ? (grid * buy[t]!) / 1000 : (grid * sell[t]!) / 1000;
      if (prot[t] === 1 && grid > GRID_IMPORT_TOLERANCE_WH) {
        dwViolationCents += (grid - GRID_IMPORT_TOLERANCE_WH) * DW_VIOLATION_CENTS_PER_WH;
      }
      applied[t] = d;
      acWh[t] = ac;
      gridWh[t] = grid;
      costCents[t] = cost;
      gridCostCents += cost;
      s += d;
    }
    const terminalCreditCents = (s * stepWh * meanBuy) / 1000;
    return {
      applied,
      socStartPct,
      acWh,
      gridWh,
      costCents,
      endS: s,
      gridCostCents,
      socPenaltyCents,
      dwViolationCents,
      terminalCreditCents,
      penalisedCents: gridCostCents + socPenaltyCents + dwViolationCents - terminalCreditCents,
    };
  };

  // -------------------------------------------------------------------------
  // Min-command-window merge (design decision 4).
  // -------------------------------------------------------------------------

  const computeRuns = (planned: Int16Array): Run[] => {
    const runs: Run[] = [];
    let start = 0;
    let dir = Math.sign(planned[0]!) as Run["dir"];
    for (let t = 1; t <= T; t++) {
      const d = t < T ? (Math.sign(planned[t]!) as Run["dir"]) : null;
      if (d !== dir) {
        runs.push({ start, end: t, dir });
        start = t;
        dir = d ?? 0;
      }
    }
    return runs;
  };

  const enforceMinCommandWindow = (planned: Int16Array): Int16Array => {
    const minSlots = input.minCommandWindowSlots ?? 1;
    if (minSlots <= 1) return planned;
    let current = planned;
    for (let pass = 0; pass < MERGE_MAX_PASSES; pass++) {
      const runs = computeRuns(current);
      if (runs.length <= 1) break;
      let target: Run | null = null;
      for (const run of runs) {
        if (run.dir === 0) continue; // idle runs exempt (executor allows idle transitions)
        if (run.end - run.start >= minSlots) continue;
        let hasPin = false;
        for (let t = run.start; t < run.end; t++) {
          if (pinDelta[t] !== null) {
            hasPin = true;
            break;
          }
        }
        if (hasPin) continue; // pins win over the merge post-process
        target = run;
        break;
      }
      if (!target) break;

      const makeVariant = (fillDelta: number): Int16Array => {
        const variant = current.slice();
        for (let t = target!.start; t < target!.end; t++) variant[t] = fillDelta;
        return variant;
      };
      const variants: Int16Array[] = [];
      if (target.start > 0) variants.push(makeVariant(current[target.start - 1]!));
      if (target.end < T) variants.push(makeVariant(current[target.end]!));
      if (variants.length === 0) break;

      let best = variants[0]!;
      let bestCost = simulate(best).penalisedCents;
      for (let i = 1; i < variants.length; i++) {
        const cost = simulate(variants[i]!).penalisedCents;
        if (cost < bestCost) {
          best = variants[i]!;
          bestCost = cost;
        }
      }
      current = best;
    }
    return current;
  };

  const finalPlanned = enforceMinCommandWindow(path.planned);
  const final = simulate(finalPlanned);

  // -------------------------------------------------------------------------
  // Build the result.
  // -------------------------------------------------------------------------

  const slots: OptimiserSlotResult[] = new Array<OptimiserSlotResult>(T);
  const throughputWhByDay = new Array<number>(nDays).fill(0);
  const overrideDeliveredWh: Record<number, number> = {};

  for (let t = 0; t < T; t++) {
    const d = final.applied[t]!;
    const ac = final.acWh[t]!;
    const grid = final.gridWh[t]!;
    if (ac > 0) throughputWhByDay[dayIdx[t]!]! += ac;
    const overrideId = pinOverrideId[t] ?? null;
    if (overrideId !== null) {
      overrideDeliveredWh[overrideId] = (overrideDeliveredWh[overrideId] ?? 0) + Math.abs(ac);
    }
    const action: PlanAction =
      pinAction[t] === "self_consume"
        ? "self_consume"
        : d > 0
          ? grid > GRID_IMPORT_TOLERANCE_WH
            ? "charge_grid"
            : "charge_solar"
          : d < 0
            ? grid < -GRID_IMPORT_TOLERANCE_WH
              ? "discharge_grid"
              : "discharge_load"
            : "idle";
    slots[t] = {
      slotStart: input.slots[t]!.slotStart,
      action,
      batteryPowerW: ac * SLOTS_PER_HOUR,
      expectedSocPct: final.socStartPct[t]! + (d * 100) / SOC_STEPS,
      expectedGridWh: grid,
      costCents: final.costCents[t]!,
      pinnedByOverrideId: overrideId,
      demandWindowProtected: prot[t] === 1,
    };
  }

  return {
    slots,
    objectiveCents: final.gridCostCents + final.socPenaltyCents - final.terminalCreditCents,
    gridCostCents: final.gridCostCents,
    socPenaltyCents: final.socPenaltyCents,
    terminalCreditCents: final.terminalCreditCents,
    lambdaCentsPerKwh: lambdaUsed,
    throughputWhByDay,
    cycleBudgetSatisfied: budgetFits(throughputWhByDay),
    overrideDeliveredWh,
  };
}
