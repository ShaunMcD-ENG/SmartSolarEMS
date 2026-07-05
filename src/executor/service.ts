import { nextFireTime } from "../amber/poller";
import { env } from "../config/env";
import type { SettingsKey, SettingsValue } from "../config/settings";
import type { DecisionRow, TelemetryRow } from "../db/repositories";
import { createLogger } from "../lib/logger";
import { REMOTE_EMS_CONTROL_MODE, type RemoteEmsControlMode } from "../modbus/registers";
import type { PlanAction } from "../planner/optimiser";
import { demandWindowFlags } from "../planner/service";
import type { PlannerRunResult } from "../planner/service";

const log = createLogger("executor");

// ---------------------------------------------------------------------------
// Tick alignment
// ---------------------------------------------------------------------------

/** Wall-clock 5-min slot alignment (see src/amber/poller.ts nextFireTime). */
export const EXECUTOR_ALIGN_MS = 5 * 60_000;
/**
 * Offset after each 5-min boundary, chosen to run AFTER the price poller's own
 * +20 s tick (src/amber/poller.ts DEFAULT_OFFSET_MS) so a replan triggered by
 * this tick sees fresh Amber prices already upserted.
 */
export const EXECUTOR_OFFSET_MS = 35_000;

/**
 * Computes the next wall-clock 5-minute-boundary-plus-offset fire time
 * strictly after `from`. Delegates to amber/poller.ts's nextFireTime (same
 * alignment math, different default offset) rather than re-implementing it.
 */
export function nextExecutorTick(
  from: Date,
  offsetMs: number = EXECUTOR_OFFSET_MS,
  alignMs: number = EXECUTOR_ALIGN_MS,
): Date {
  return nextFireTime(from, offsetMs, alignMs);
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** Structural subset of SettingsService (src/config/settings.ts). */
export interface ExecutorSettingsSource {
  get<K extends SettingsKey>(key: K): Promise<SettingsValue<K> | null>;
}

/**
 * Structural subset of SigenergyClient (src/modbus/client.ts) that the
 * executor needs. Deliberately excludes readTelemetry(): the executor gets
 * current SOC from the DB (latestTelemetry, same source the planner reads),
 * not a second live Modbus round trip — see ExecutorServiceDeps.latestTelemetry.
 * That also keeps shadow mode (the default) entirely free of Modbus traffic:
 * readSocLimits/enableRemoteEms/setControlMode/setChargePowerW/
 * setDischargePowerW are only ever called from active-mode code paths.
 */
export interface ExecutorModbusClient {
  readSocLimits(): Promise<{
    backupSocPct: number;
    chargeCutoffSocPct: number;
    dischargeCutoffSocPct: number;
  }>;
  enableRemoteEms(on: boolean): Promise<boolean>;
  setControlMode(mode: RemoteEmsControlMode): Promise<boolean>;
  setChargePowerW(watts: number): Promise<boolean>;
  setDischargePowerW(watts: number): Promise<boolean>;
}

export interface ExecutorServiceDeps {
  /** PlannerService.runOnce, bound. */
  runOnce: (now: Date) => Promise<PlannerRunResult | null>;
  client: ExecutorModbusClient;
  settings: ExecutorSettingsSource;
  insertDecision: (row: DecisionRow) => Promise<void>;
  /** Latest telemetry row from the DB (not a fresh Modbus read) — gives current battery SOC. */
  latestTelemetry: () => Promise<TelemetryRow | null>;
  /** Injectable clock; defaults to () => new Date(). */
  now?: () => Date;
  /** IANA timezone for demand-window resolution; defaults to env().TZ. */
  tz?: string;
  /** Seconds-after-5-min-boundary offset; default EXECUTOR_OFFSET_MS (35 s). */
  offsetMs?: number;
  /** 5-min alignment period; overridable only for tests. */
  alignMs?: number;
  /** Number of handback attempts (each trying disable-remote-EMS then max-self-consumption) before giving up for this call. Default 3. */
  handbackRetries?: number;
  handbackBaseBackoffMs?: number;
  handbackMaxBackoffMs?: number;
  /** Injectable sleep, used for handback backoff. Defaults to a real setTimeout-based delay. */
  delay?: (ms: number) => Promise<void>;
}

export interface ExecutorStatus {
  running: boolean;
  mode: "shadow" | "active";
  lastTick: Date | null;
  lastAction: string | null;
  lastError: string | null;
  consecutiveModbusFailures: number;
  failSafeEngaged: boolean;
}

// ---------------------------------------------------------------------------
// Settings fallbacks (mirrors src/config/settings.ts DEFAULTS)
// ---------------------------------------------------------------------------

const DEFAULT_BATTERY: SettingsValue<"battery"> = {
  capacityWh: 10000,
  usableMinSocPct: 10,
  maxChargeW: 5000,
  maxDischargeW: 5000,
  roundTripEfficiency: 0.9,
};
const DEFAULT_GOALS: SettingsValue<"goals"> = { maxCyclesPerDay: 1, socTargets: [], minCommandWindowMin: 5 };
const DEFAULT_DEMAND_WINDOW: SettingsValue<"demandWindow"> = {
  enabled: false,
  start: "15:00",
  end: "20:00",
  bufferMin: 10,
};
const DEFAULT_MODE: SettingsValue<"mode"> = { shadow: true };

// ---------------------------------------------------------------------------
// Safety pipeline (pure, exported for direct unit testing)
// ---------------------------------------------------------------------------

export type CommandDirection = "charge" | "discharge" | "other";

/** charge_solar/charge_grid -> "charge"; discharge_load/discharge_grid -> "discharge"; else "other". */
export function directionOf(action: PlanAction): CommandDirection {
  if (action === "charge_solar" || action === "charge_grid") return "charge";
  if (action === "discharge_load" || action === "discharge_grid") return "discharge";
  return "other";
}

export interface CommittedCommand {
  action: PlanAction;
  batteryPowerW: number;
  committedAt: Date;
}

/** Clamps a charge command's power to [0, maxChargeW]. */
export function clampChargePowerW(batteryPowerW: number, maxChargeW: number): number {
  return Math.min(Math.max(batteryPowerW, 0), Math.max(0, maxChargeW));
}

/** Clamps a discharge command's magnitude to maxDischargeW, keeping the sign negative. */
export function clampDischargePowerW(batteryPowerW: number, maxDischargeW: number): number {
  const magnitude = Math.min(Math.abs(batteryPowerW), Math.max(0, maxDischargeW));
  return magnitude === 0 ? 0 : -magnitude;
}

/**
 * Clamps a discharge command so SOC never goes below `floorPct`, using the
 * planner's own efficiency-split convention (design/planner.md: ηc = ηd =
 * √roundTripEfficiency); AC-side dischargeOut = batteryEnergyRemoved * ηd, so
 * the maximum AC-side energy deliverable this slot is
 * (available battery-side Wh above the floor) * ηd. Returns the (negative)
 * clamped power, or `batteryPowerW` unchanged if it isn't a discharge or
 * there's nothing to clamp.
 */
export function clampDischargeFloorW(
  batteryPowerW: number,
  currentSocPct: number,
  floorPct: number,
  capacityWh: number,
  roundTripEfficiency: number,
  slotMinutes: number,
): number {
  if (batteryPowerW >= 0) return batteryPowerW;
  const etaDischarge = Math.sqrt(Math.max(0, Math.min(1, roundTripEfficiency)));
  const availableAboveFloorWh = Math.max(0, ((currentSocPct - floorPct) / 100) * capacityWh);
  const maxDischargeAcWh = availableAboveFloorWh * etaDischarge;
  const maxDischargePowerW = maxDischargeAcWh / (slotMinutes / 60);
  const allowedMagnitude = Math.min(Math.abs(batteryPowerW), maxDischargePowerW);
  return allowedMagnitude <= 0 ? 0 : -allowedMagnitude;
}

/**
 * Heuristic defence-in-depth check for whether the planner's slot0 reason
 * indicates an override is pinning this slot THROUGH demand-window
 * protection (override_demand_window=true). The planner (src/planner/service.ts
 * buildSlot0Reason / optimiser.ts design decision 1) only omits the "demand
 * window protection active" sentence when such a pin cleared the protected
 * flag, so "mentions a user override, but not demand-window protection" is a
 * reliable signal without the executor needing its own copy of the overrides
 * table.
 */
export function isOverrideDemandWindowPin(reason: string | null | undefined): boolean {
  if (!reason) return false;
  return reason.includes("user override") && !reason.includes("demand window protection active");
}

export interface SafetyPipelineInput {
  action: PlanAction;
  batteryPowerW: number;
  reason: string | null;
  slotMinutes: number;
  /** null when no SOC telemetry is available (discharge-floor clamp is skipped). */
  currentSocPct: number | null;
  floorPct: number;
  capacityWh: number;
  maxChargeW: number;
  maxDischargeW: number;
  roundTripEfficiency: number;
  demandWindowProtected: boolean;
  minCommandWindowMin: number;
  previousCommitted: CommittedCommand | null;
  now: Date;
}

export interface SafetyPipelineResult {
  action: PlanAction;
  batteryPowerW: number;
  /** One entry per modifying step, in pipeline order; appended to the decision's reason. */
  notes: string[];
  /** True if any of steps (a)-(c) modified the action/power (used to gate step (d)). */
  safetyModified: boolean;
  heldByMinCommandWindow: boolean;
}

/**
 * Safety pipeline (design/planner.md Executor section): always runs, in both
 * modes, in this order — (a) power limits, (b) discharge floor, (c) demand-
 * window import guard (defence in depth; the planner already enforces this),
 * (d) min command window hold. Each modifying step appends a human-readable
 * note (folded into the decision's `reason` by the caller).
 */
export function applySafetyPipeline(input: SafetyPipelineInput): SafetyPipelineResult {
  let action = input.action;
  let powerW = input.batteryPowerW;
  const notes: string[] = [];

  // (a) Power limits.
  if (action === "charge_solar" || action === "charge_grid") {
    const clamped = clampChargePowerW(powerW, input.maxChargeW);
    if (Math.round(clamped) !== Math.round(powerW)) {
      notes.push(`power clamp: ${Math.round(powerW)} W -> ${Math.round(clamped)} W (max charge ${input.maxChargeW} W)`);
      powerW = clamped;
    }
  } else if (action === "discharge_load" || action === "discharge_grid") {
    const clamped = clampDischargePowerW(powerW, input.maxDischargeW);
    if (Math.round(clamped) !== Math.round(powerW)) {
      notes.push(
        `power clamp: ${Math.round(powerW)} W -> ${Math.round(clamped)} W (max discharge ${input.maxDischargeW} W)`,
      );
      powerW = clamped;
    }
  }

  // (b) Discharge floor.
  if ((action === "discharge_load" || action === "discharge_grid") && input.currentSocPct !== null) {
    const clamped = clampDischargeFloorW(
      powerW,
      input.currentSocPct,
      input.floorPct,
      input.capacityWh,
      input.roundTripEfficiency,
      input.slotMinutes,
    );
    if (Math.round(clamped) !== Math.round(powerW)) {
      notes.push(
        `discharge floor: ${Math.round(powerW)} W -> ${Math.round(clamped)} W (floor ${input.floorPct.toFixed(1)} % SOC, currently ${input.currentSocPct.toFixed(1)} %)`,
      );
      powerW = clamped;
      if (powerW === 0) action = "idle";
    }
  }

  // (c) Demand-window import guard (defence in depth).
  if (action === "charge_grid" && input.demandWindowProtected && !isOverrideDemandWindowPin(input.reason)) {
    notes.push("demand-window guard: charge_grid rewritten to self_consume (executor defence-in-depth re-check)");
    action = "self_consume";
    powerW = 0;
  }

  const safetyModified = notes.length > 0;
  let heldByMinCommandWindow = false;

  // (d) Min command window: only a charge<->discharge flip needs holding;
  // idle/self_consume transitions are always allowed, and a safety guard
  // above always wins over holding a stale command.
  if (!safetyModified && input.previousCommitted) {
    const prevDir = directionOf(input.previousCommitted.action);
    const newDir = directionOf(action);
    if ((prevDir === "charge" || prevDir === "discharge") && newDir !== "other") {
      const elapsedMin = (input.now.getTime() - input.previousCommitted.committedAt.getTime()) / 60_000;
      if (elapsedMin < input.minCommandWindowMin) {
        action = input.previousCommitted.action;
        powerW = input.previousCommitted.batteryPowerW;
        heldByMinCommandWindow = true;
        notes.push(
          `min command window: holding previous action (${elapsedMin.toFixed(1)} of ${input.minCommandWindowMin} min elapsed)`,
        );
      }
    }
  }

  return { action, batteryPowerW: Math.round(powerW), notes, safetyModified, heldByMinCommandWindow };
}

// ---------------------------------------------------------------------------
// ExecutorService
// ---------------------------------------------------------------------------

/**
 * Turns the planner's slot-0 intent into inverter commands (design/planner.md
 * Executor section). Ticks on a 5-min-boundary+35s wall-clock cadence, always
 * re-reads `mode.shadow` fresh (live-switchable without a restart), always
 * runs the safety pipeline above regardless of mode, and only issues Modbus
 * *control* writes in active mode. This module is the inverter's watchdog
 * (docs/sigenergy-modbus.md §8 — the device's own comms-loss fallback is
 * UNVERIFIED): 3 consecutive failed control writes, or the planner returning
 * null while active, engages a fail-safe that hands control back to the
 * inverter and stays engaged until a later tick both has a fresh plan and
 * succeeds at a control write.
 */
export class ExecutorService {
  private readonly deps: ExecutorServiceDeps;
  private readonly now: () => Date;
  private readonly tz: string;
  private readonly offsetMs: number;
  private readonly alignMs: number;
  private readonly handbackRetries: number;
  private readonly handbackBaseBackoffMs: number;
  private readonly handbackMaxBackoffMs: number;
  private readonly delay: (ms: number) => Promise<void>;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;
  private ticking = false;

  private lastTick: Date | null = null;
  private lastAction: string | null = null;
  private lastError: string | null = null;
  private consecutiveModbusFailures = 0;
  private failSafeEngaged = false;
  private currentMode: "shadow" | "active" = "shadow";
  /** True once we've issued (or attempted) a hardware control write in active mode, until handed back. */
  private controlActive = false;
  private lastCommitted: CommittedCommand | null = null;

  constructor(deps: ExecutorServiceDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.tz = deps.tz ?? env().TZ;
    this.offsetMs = deps.offsetMs ?? EXECUTOR_OFFSET_MS;
    this.alignMs = deps.alignMs ?? EXECUTOR_ALIGN_MS;
    this.handbackRetries = deps.handbackRetries ?? 3;
    this.handbackBaseBackoffMs = deps.handbackBaseBackoffMs ?? 500;
    this.handbackMaxBackoffMs = deps.handbackMaxBackoffMs ?? 4000;
    this.delay = deps.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Schedules the first tick at the next 5-min-boundary+offset. Idempotent. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.scheduleNext();
  }

  /**
   * Stops the loop. If we currently hold active hardware control, best-effort
   * hands it back (disable remote EMS, falling back to max-self-consumption)
   * before resolving — callers (including process shutdown) should await this.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.controlActive) {
      await this.attemptHandback("executor stopping");
      this.controlActive = false;
    }
  }

  status(): ExecutorStatus {
    return {
      running: !this.stopped,
      mode: this.currentMode,
      lastTick: this.lastTick,
      lastAction: this.lastAction,
      lastError: this.lastError,
      consecutiveModbusFailures: this.consecutiveModbusFailures,
      failSafeEngaged: this.failSafeEngaged,
    };
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const from = this.now();
    const fireAt = nextExecutorTick(from, this.offsetMs, this.alignMs);
    const delayMs = Math.max(0, fireAt.getTime() - from.getTime());
    this.timer = setTimeout(() => {
      void this.runScheduledTick();
    }, delayMs);
  }

  private async runScheduledTick(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.tick(this.now());
    } catch (err) {
      log.error("executor tick threw unexpectedly", { error: err instanceof Error ? err.message : String(err) });
    } finally {
      if (!this.stopped) this.scheduleNext();
    }
  }

  /**
   * Runs one executor tick: re-reads mode, replans, applies the safety
   * pipeline, and (in active mode) issues the Modbus sequence. Public (rather
   * than only reachable via the internal timer) so tests can invoke it
   * directly without waiting on real 5-minute wall-clock boundaries.
   */
  async tick(now: Date = this.now()): Promise<void> {
    if (this.ticking) {
      log.warn("executor tick skipped: previous tick still in flight");
      return;
    }
    this.ticking = true;
    try {
      await this.runTick(now);
    } finally {
      this.ticking = false;
    }
  }

  private async runTick(now: Date): Promise<void> {
    const modeSetting = (await this.safeSettingsGet("mode")) ?? DEFAULT_MODE;
    const shadowMode = modeSetting.shadow !== false;
    const previousMode = this.currentMode;
    this.currentMode = shadowMode ? "shadow" : "active";
    this.lastTick = now;

    // Mode transition active -> shadow: hand control back once.
    if (previousMode === "active" && shadowMode && this.controlActive) {
      await this.attemptHandback("mode switched to shadow");
      this.controlActive = false;
    }

    let planResult: PlannerRunResult | null = null;
    try {
      planResult = await this.deps.runOnce(now);
    } catch (err) {
      log.error("executor: planner runOnce threw", { error: err instanceof Error ? err.message : String(err) });
      planResult = null;
    }

    const telemetry = await this.deps.latestTelemetry().catch((err: unknown) => {
      log.warn("executor: failed to read latest telemetry", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    });
    const currentSocPct = telemetry?.battery_soc_pct ?? null;

    if (!planResult || !planResult.slots[0]) {
      await this.handlePlannerNull(now, shadowMode, currentSocPct);
      return;
    }

    await this.applyPlan(now, shadowMode, currentSocPct, planResult);
  }

  private async applyPlan(
    now: Date,
    shadowMode: boolean,
    currentSocPct: number | null,
    planResult: PlannerRunResult,
  ): Promise<void> {
    const slot0 = planResult.slots[0]!;
    const battery = (await this.safeSettingsGet("battery")) ?? DEFAULT_BATTERY;
    const goals = (await this.safeSettingsGet("goals")) ?? DEFAULT_GOALS;
    const demandWindow = (await this.safeSettingsGet("demandWindow")) ?? DEFAULT_DEMAND_WINDOW;

    // Device backup SOC only augments the floor in active mode: reading it is
    // a Modbus round trip, and shadow mode (the default) must make none.
    let deviceBackupSocPct: number | null = null;
    if (!shadowMode) {
      try {
        const limits = await this.deps.client.readSocLimits();
        deviceBackupSocPct = limits.backupSocPct;
      } catch (err) {
        log.warn("executor: failed to read device backup SOC; using settings floor only", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const floorPct =
      deviceBackupSocPct !== null ? Math.max(deviceBackupSocPct, battery.usableMinSocPct) : battery.usableMinSocPct;

    const demandWindowProtected = demandWindowFlags([slot0.slot_start], demandWindow, this.tz)[0] ?? false;

    const pipeline = applySafetyPipeline({
      action: slot0.action,
      batteryPowerW: slot0.battery_power_w ?? 0,
      reason: slot0.reason,
      slotMinutes: 5,
      currentSocPct,
      floorPct,
      capacityWh: battery.capacityWh,
      maxChargeW: battery.maxChargeW,
      maxDischargeW: battery.maxDischargeW,
      roundTripEfficiency: battery.roundTripEfficiency,
      demandWindowProtected,
      minCommandWindowMin: goals.minCommandWindowMin,
      previousCommitted: this.lastCommitted,
      now,
    });

    const combinedReason = [slot0.reason, ...pipeline.notes].filter((s): s is string => !!s).join("; ");
    this.updateLastCommitted(pipeline.action, pipeline.batteryPowerW, now);

    const decision: DecisionRow = {
      time: now,
      slot_start: slot0.slot_start,
      mode: shadowMode ? "shadow" : "active",
      action: pipeline.action,
      battery_power_w: pipeline.batteryPowerW,
      soc_pct: currentSocPct,
      plan_id: planResult.planId,
      reason: combinedReason || null,
      executed: false,
      error: null,
    };

    if (shadowMode) {
      this.lastAction = pipeline.action;
      this.lastError = null;
      await this.deps.insertDecision(decision);
      return;
    }

    this.controlActive = true;
    const applied = await this.applyActive(pipeline.action, pipeline.batteryPowerW);

    if (applied.ok) {
      this.consecutiveModbusFailures = 0;
      decision.executed = true;
      if (this.failSafeEngaged) {
        this.failSafeEngaged = false;
        decision.reason = [decision.reason, "fail-safe cleared: control write succeeded"]
          .filter((s): s is string => !!s)
          .join("; ");
        log.info("executor: fail-safe cleared, control write succeeded");
      }
    } else {
      this.consecutiveModbusFailures += 1;
      decision.executed = false;
      decision.error = applied.error ?? "control write failed";
      if (this.consecutiveModbusFailures >= 3) {
        const wasEngaged = this.failSafeEngaged;
        this.failSafeEngaged = true;
        const handbackOk = await this.attemptHandback("3 consecutive control write failures");
        const alertNote = wasEngaged
          ? "fail-safe remains engaged"
          : `FAIL-SAFE ENGAGED after ${this.consecutiveModbusFailures} consecutive control write failures (handback ${handbackOk ? "succeeded" : "failed"})`;
        decision.reason = [decision.reason, alertNote].filter((s): s is string => !!s).join("; ");
      }
    }

    this.lastAction = pipeline.action;
    this.lastError = decision.error;
    await this.deps.insertDecision(decision);
  }

  private async handlePlannerNull(now: Date, shadowMode: boolean, currentSocPct: number | null): Promise<void> {
    const decision: DecisionRow = {
      time: now,
      slot_start: null,
      mode: shadowMode ? "shadow" : "active",
      action: null,
      battery_power_w: null,
      soc_pct: currentSocPct,
      plan_id: null,
      reason: null,
      executed: false,
      error: "planner returned no plan for this tick",
    };

    if (!shadowMode) {
      const wasEngaged = this.failSafeEngaged;
      this.failSafeEngaged = true;
      const handbackOk = await this.attemptHandback("planner returned no plan");
      decision.reason = wasEngaged
        ? "fail-safe remains engaged: planner returned no plan again"
        : `FAIL-SAFE ENGAGED: planner returned no plan (handback ${handbackOk ? "succeeded" : "failed"})`;
    }

    this.lastAction = null;
    this.lastError = decision.error;
    await this.deps.insertDecision(decision);
  }

  /** Tracks the direction-relevant "currently commanded" action for the min-command-window hold. */
  private updateLastCommitted(action: PlanAction, batteryPowerW: number, now: Date): void {
    if (this.lastCommitted && this.lastCommitted.action === action) {
      // Continuation of the same action: keep the original committedAt so the
      // hold window measures from when this direction was first commanded,
      // not from every tick that merely re-affirms it.
      this.lastCommitted = { action, batteryPowerW, committedAt: this.lastCommitted.committedAt };
    } else {
      this.lastCommitted = { action, batteryPowerW, committedAt: now };
    }
  }

  /**
   * Issues the Sigenergy control sequence for `action` (docs/sigenergy-modbus.md
   * §6): ensure remote EMS is enabled, then either a charge/discharge setpoint
   * or max-self-consumption. Every underlying SigenergyClient call already
   * read-back-verifies its write.
   */
  private async applyActive(action: PlanAction, batteryPowerW: number): Promise<{ ok: boolean; error?: string }> {
    try {
      const enabled = await this.deps.client.enableRemoteEms(true);
      if (!enabled) return { ok: false, error: "failed to enable/verify remote EMS" };

      switch (action) {
        case "charge_solar":
        case "charge_grid": {
          const ok = await this.deps.client.setChargePowerW(Math.max(0, Math.round(batteryPowerW)));
          return ok ? { ok: true } : { ok: false, error: "charge setpoint write/verify failed" };
        }
        case "discharge_load":
        case "discharge_grid": {
          const ok = await this.deps.client.setDischargePowerW(Math.max(0, Math.round(Math.abs(batteryPowerW))));
          return ok ? { ok: true } : { ok: false, error: "discharge setpoint write/verify failed" };
        }
        case "self_consume":
        case "idle": {
          const ok = await this.deps.client.setControlMode(REMOTE_EMS_CONTROL_MODE.MaxSelfConsumption);
          return ok ? { ok: true } : { ok: false, error: "max-self-consumption mode write/verify failed" };
        }
        default: {
          const exhaustive: never = action;
          throw new Error(`executor: unhandled plan action: ${String(exhaustive)}`);
        }
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Best-effort hand-back to the inverter's own logic: tries disabling remote
   * EMS (40029=0, the deeper option per docs/sigenergy-modbus.md §6.5), and if
   * that fails falls back to max-self-consumption (40031=0x02, staying in
   * remote EMS but non-forcing) — retried up to `handbackRetries` times with
   * capped exponential backoff. Returns whether either succeeded.
   */
  private async attemptHandback(context: string): Promise<boolean> {
    let backoff = this.handbackBaseBackoffMs;
    for (let attempt = 0; attempt < this.handbackRetries; attempt++) {
      try {
        const disabled = await this.deps.client.enableRemoteEms(false);
        if (disabled) {
          log.warn("executor: handback succeeded (remote EMS disabled)", { context, attempt });
          return true;
        }
      } catch (err) {
        log.warn("executor: handback enableRemoteEms(false) failed", {
          context,
          attempt,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        const selfConsume = await this.deps.client.setControlMode(REMOTE_EMS_CONTROL_MODE.MaxSelfConsumption);
        if (selfConsume) {
          log.warn("executor: handback fell back to max-self-consumption", { context, attempt });
          return true;
        }
      } catch (err) {
        log.warn("executor: handback setControlMode(MaxSelfConsumption) failed", {
          context,
          attempt,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (attempt < this.handbackRetries - 1) {
        await this.delay(backoff);
        backoff = Math.min(backoff * 2, this.handbackMaxBackoffMs);
      }
    }
    log.error("executor: handback failed after all retries; inverter may remain under forced control", { context });
    return false;
  }

  private async safeSettingsGet<K extends SettingsKey>(key: K): Promise<SettingsValue<K> | null> {
    try {
      return await this.deps.settings.get(key);
    } catch (err) {
      log.warn(`executor: failed to read "${key}" setting`, {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}
