import type { PriceForecastSnapshotRow, PriceRow } from "../db/repositories";
import { insertForecastSnapshot, upsertPrices } from "../db/repositories";
import { createLogger } from "../lib/logger";
import type { IntervalType, NormalizedInterval } from "./client";
import { AmberClient } from "./client";

const log = createLogger("amber-poller");

/** 5-minute wall-clock alignment, per docs/amber-api.md (Amber publishes on 5-min boundaries). */
const ALIGN_MS = 5 * 60_000;
/** Small delay after each boundary so Amber has published the new interval before we poll. */
const DEFAULT_OFFSET_MS = 20_000;

export interface PollerStatus {
  running: boolean;
  lastSuccess: Date | null;
  lastError: string | null;
  lastIntervalStart: Date | null;
}

/**
 * Minimal client surface the poller needs — lets tests inject a fake without a
 * real AmberClient/fetch. The real `AmberClient` satisfies this structurally.
 */
export interface PriceSource {
  getCurrentPrices(
    siteId: string,
    opts?: { next?: number; previous?: number; resolution?: 5 | 30 },
  ): Promise<NormalizedInterval[]>;
}

/**
 * Minimal settings surface the poller needs. `SettingsService` (src/config/settings.ts)
 * satisfies this structurally, same pattern as src/modbus/poller.ts's PollIntervalSource.
 */
export interface AmberSettingsSource {
  get(key: "amber"): Promise<{ apiToken: string; siteId: string; pollIntervalMs: number } | null>;
}

/**
 * Computes the next wall-clock 5-minute-boundary-plus-offset fire time strictly
 * after `from`. Pure function so the alignment math is unit-testable without
 * timers. Self-corrects for drift: every call re-derives from the current
 * boundary rather than accumulating an interval.
 */
export function nextFireTime(from: Date, offsetMs: number = DEFAULT_OFFSET_MS, alignMs: number = ALIGN_MS): Date {
  const t = from.getTime();
  const boundary = Math.floor(t / alignMs) * alignMs;
  let candidate = boundary + offsetMs;
  if (candidate <= t) candidate += alignMs;
  return new Date(candidate);
}

function mapIntervalType(type: IntervalType): "actual" | "current" | "forecast" {
  switch (type) {
    case "ActualInterval":
      return "actual";
    case "CurrentInterval":
      return "current";
    case "ForecastInterval":
      return "forecast";
    default:
      // intervalSchema is a closed discriminated union (docs/amber-api.md §4), so this
      // is unreachable for successfully-parsed intervals; kept only to satisfy
      // exhaustiveness without a non-null assertion.
      throw new Error(`amber-poller: unknown interval type: ${String(type)}`);
  }
}

function toPriceRow(interval: NormalizedInterval, updatedAt: Date): PriceRow {
  return {
    interval_start: interval.intervalStart,
    channel: interval.channelType,
    per_kwh: interval.perKwh,
    spot_per_kwh: interval.spotPerKwh,
    renewables: interval.renewables,
    spike_status: interval.spikeStatus,
    interval_type: mapIntervalType(interval.type),
    estimate: interval.estimate,
    updated_at: updatedAt,
  };
}

/** Groups intervals by channelType, preserving encounter order of both channels and items. */
function groupByChannel(intervals: NormalizedInterval[]): Map<string, NormalizedInterval[]> {
  const groups = new Map<string, NormalizedInterval[]>();
  for (const interval of intervals) {
    const list = groups.get(interval.channelType);
    if (list) list.push(interval);
    else groups.set(interval.channelType, [interval]);
  }
  return groups;
}

export interface PricePollerOptions {
  /** Factory so a fresh token (possibly changed via settings) builds a fresh client each tick. */
  createClient?: (token: string) => PriceSource;
  upsertPricesFn?: (rows: PriceRow[]) => Promise<void>;
  insertForecastSnapshotFn?: (row: PriceForecastSnapshotRow) => Promise<void>;
  now?: () => Date;
  /** Seconds-after-5-min-boundary offset; default 20s (see DEFAULT_OFFSET_MS). */
  offsetMs?: number;
}

/**
 * Polls Amber's `/prices/current` on a 5-minute wall-clock cadence (plus a small
 * offset so Amber has published the new interval), upserting normalised price
 * rows and appending a raw forecast snapshot per channel. Reads `amber` settings
 * fresh every tick (token/siteId can change without a restart) and skips the
 * cycle with a warn log if either is unset. Never throws out of a tick — every
 * failure is logged and the loop just tries again next boundary.
 */
export class PricePoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;

  private lastSuccess: Date | null = null;
  private lastError: string | null = null;
  private lastIntervalStart: Date | null = null;

  private readonly createClient: (token: string) => PriceSource;
  private readonly upsertPricesFn: (rows: PriceRow[]) => Promise<void>;
  private readonly insertForecastSnapshotFn: (row: PriceForecastSnapshotRow) => Promise<void>;
  private readonly now: () => Date;
  private readonly offsetMs: number;

  constructor(
    private readonly settings: AmberSettingsSource,
    options: PricePollerOptions = {},
  ) {
    this.createClient = options.createClient ?? ((token) => new AmberClient(token));
    this.upsertPricesFn = options.upsertPricesFn ?? upsertPrices;
    this.insertForecastSnapshotFn = options.insertForecastSnapshotFn ?? insertForecastSnapshot;
    this.now = options.now ?? (() => new Date());
    this.offsetMs = options.offsetMs ?? DEFAULT_OFFSET_MS;
  }

  /** Schedules the first tick at the next 5-min-boundary+offset. Idempotent. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.scheduleNext();
  }

  /** Stops the loop. Any in-flight tick still finishes but no further tick is scheduled. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  status(): PollerStatus {
    return {
      running: !this.stopped,
      lastSuccess: this.lastSuccess,
      lastError: this.lastError,
      lastIntervalStart: this.lastIntervalStart,
    };
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    const fireAt = nextFireTime(this.now(), this.offsetMs);
    const delayMs = Math.max(0, fireAt.getTime() - this.now().getTime());
    this.timer = setTimeout(() => {
      void this.tick();
    }, delayMs);
  }

  /** Runs one poll cycle, then (regardless of outcome) reschedules the next one. */
  async tick(): Promise<void> {
    try {
      const performed = await this.runCycle();
      if (performed) {
        this.lastSuccess = this.now();
        this.lastError = null;
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      log.error("amber poll failed", { error: this.lastError });
    } finally {
      if (!this.stopped) this.scheduleNext();
    }
  }

  /** Returns true if prices were actually fetched/upserted, false if the cycle was skipped. */
  private async runCycle(): Promise<boolean> {
    const amber = await this.settings.get("amber");
    if (!amber || !amber.apiToken || !amber.siteId) {
      log.warn("amber poller: skipping cycle, amber settings not configured");
      return false;
    }

    const client = this.createClient(amber.apiToken);
    const intervals = await client.getCurrentPrices(amber.siteId, { next: 288, previous: 12, resolution: 5 });
    if (intervals.length === 0) {
      log.warn("amber poller: no intervals returned, skipping upsert this cycle");
      return false;
    }

    const fetchedAt = this.now();
    const priceRows = intervals.map((interval) => toPriceRow(interval, fetchedAt));
    await this.upsertPricesFn(priceRows);

    const byChannel = groupByChannel(intervals);
    for (const [channel, channelIntervals] of byChannel) {
      await this.insertForecastSnapshotFn({
        fetched_at: fetchedAt,
        channel,
        payload: channelIntervals.map((interval) => interval.raw) as PriceForecastSnapshotRow["payload"],
      });
    }

    const currentStarts = intervals
      .filter((interval) => interval.type === "CurrentInterval")
      .map((interval) => interval.intervalStart.getTime());
    const latestStarts = currentStarts.length > 0 ? currentStarts : intervals.map((i) => i.intervalStart.getTime());
    this.lastIntervalStart = new Date(Math.max(...latestStarts));
    return true;
  }
}
