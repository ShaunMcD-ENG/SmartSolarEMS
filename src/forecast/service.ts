import { env } from "../config/env";
import type { Sql } from "../db/client";
import { getDb } from "../db/client";
import type { ForecastRow, Telemetry5mRow } from "../db/repositories";
import { createLogger } from "../lib/logger";
import type { DayType, LoadProfile, SolarProfile } from "./profiles";
import { SLOTS_PER_DAY, SLOT_MINUTES, buildLoadProfile, buildSolarProfile, clearnessFactor, slotInfo } from "./profiles";

const log = createLogger("forecast-service");

const SLOT_MS = SLOT_MINUTES * 60_000;
const PROFILE_WINDOW_DAYS = 28;
const REFRESH_INTERVAL_MS = 60 * 60_000; // recompute profiles at most hourly
const PERSISTENCE_WINDOW_MIN = 30;
const CLEARNESS_WINDOW_HOURS = 2;
/** Persistence blend weight w = exp(-h/PERSISTENCE_DECAY_SLOTS), h = slots ahead. */
const PERSISTENCE_DECAY_SLOTS = 12;
/** Cold-start flat load fallback, per design/planner.md ("500 W -> 41.7 Wh/slot"). */
const DEFAULT_COLD_START_LOAD_W = 500;
const MODEL_TAG = "profile-v1";
/** Below this actual-Wh magnitude, a forecast point is excluded from MAPE (avoids /~0 blowups). */
const MAPE_MIN_ACTUAL_WH = 1;

export interface ForecastSlot {
  slotStart: Date;
  loadWh: number;
  solarWh: number;
}

export type HorizonBucket = "0-1h" | "1-4h" | "4-12h" | "12-24h";
const HORIZON_BUCKETS: readonly HorizonBucket[] = ["0-1h", "1-4h", "4-12h", "12-24h"];

export interface HorizonBucketAccuracy {
  n: number;
  /** Mean absolute percentage error, in percent (0-100+); null if no samples had a usable (non-~0) actual. */
  mape: number | null;
  /** Mean (forecast - actual), in Wh; positive = over-forecasting. Null if no samples. */
  biasWh: number | null;
}

export interface AccuracyResult {
  load: Record<HorizonBucket, HorizonBucketAccuracy>;
  solar: Record<HorizonBucket, HorizonBucketAccuracy>;
}

/**
 * Structural subset of SettingsService (src/config/settings.ts) — accepted
 * for architectural consistency with the rest of the app (every long-lived
 * service takes an injected settings source) and as a forward-compatible
 * hook. NOTE: the `settings` table schema (design/db-schema.md) currently has
 * no forecast-specific keys, and adding one is out of scope here (this task
 * is scoped to src/forecast/ only), so nothing is read from it yet — tz comes
 * from `tz` / env().TZ, and the cold-start default is a constructor option.
 * See the final report for this noted as a deliberate spec deviation.
 */
export interface ForecastSettingsSource {
  get(key: string): Promise<unknown>;
}

export interface ForecastServiceDeps {
  fetchTelemetry5m: (from: Date, to: Date) => Promise<Telemetry5mRow[]>;
  insertForecasts: (rows: ForecastRow[]) => Promise<void>;
  settings: ForecastSettingsSource;
  /** Injectable clock for tests; defaults to `() => new Date()`. */
  now?: () => Date;
  /** IANA timezone for slot-of-day computation; defaults to env().TZ. */
  tz?: string;
  /** Cold-start flat load fallback in watts; defaults to 500 W. */
  coldStartDefaultLoadW?: number;
  /** Reads back previously-snapshotted forecasts, for accuracy(). Defaults to querying the `forecasts` table directly. */
  fetchForecasts?: (from: Date, to: Date) => Promise<ForecastRow[]>;
}

async function defaultFetchForecasts(from: Date, to: Date, sql: Sql = getDb()): Promise<ForecastRow[]> {
  return sql<ForecastRow[]>`
    SELECT created_at, target_start, kind, energy_wh, model
    FROM forecasts
    WHERE target_start BETWEEN ${from} AND ${to}
    ORDER BY target_start
  `;
}

function horizonBucketOf(hours: number): HorizonBucket | null {
  if (hours < 0) return null;
  if (hours < 1) return "0-1h";
  if (hours < 4) return "1-4h";
  if (hours < 12) return "4-12h";
  if (hours < 24) return "12-24h";
  return null;
}

interface Accumulator {
  errors: number[];
  biases: number[];
}

function emptyHorizonAccumulators(): Record<HorizonBucket, Accumulator> {
  return {
    "0-1h": { errors: [], biases: [] },
    "1-4h": { errors: [], biases: [] },
    "4-12h": { errors: [], biases: [] },
    "12-24h": { errors: [], biases: [] },
  };
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function summarize(accumulators: Record<HorizonBucket, Accumulator>): Record<HorizonBucket, HorizonBucketAccuracy> {
  const result = {} as Record<HorizonBucket, HorizonBucketAccuracy>;
  for (const bucket of HORIZON_BUCKETS) {
    const { errors, biases } = accumulators[bucket];
    result[bucket] = {
      n: biases.length,
      mape: errors.length > 0 ? mean(errors) * 100 : null,
      biasWh: biases.length > 0 ? mean(biases) : null,
    };
  }
  return result;
}

/**
 * Produces load/solar forecasts from EWMA/percentile profiles built off
 * trailing telemetry_5m history (see ./profiles.ts), blended near-term with
 * persistence of very recent actuals. Every forecast() call snapshots its
 * output into the `forecasts` table (via injected insertForecasts) so
 * accuracy() can later score it. See design/planner.md "Forecast module".
 */
export class ForecastService {
  private readonly fetchTelemetry5m: ForecastServiceDeps["fetchTelemetry5m"];
  private readonly insertForecastsFn: ForecastServiceDeps["insertForecasts"];
  private readonly fetchForecastsFn: (from: Date, to: Date) => Promise<ForecastRow[]>;
  /** Reserved, currently unread — see ForecastSettingsSource doc comment. */
  private readonly settings: ForecastSettingsSource;
  private readonly now: () => Date;
  private readonly tz: string;
  private readonly coldStartDefaultLoadWh: number;

  private loadProfile: LoadProfile | null = null;
  private solarProfile: SolarProfile | null = null;
  private lastRefreshedAt: Date | null = null;
  private warnedColdStart = false;

  constructor(deps: ForecastServiceDeps) {
    this.fetchTelemetry5m = deps.fetchTelemetry5m;
    this.insertForecastsFn = deps.insertForecasts;
    this.fetchForecastsFn = deps.fetchForecasts ?? defaultFetchForecasts;
    this.settings = deps.settings;
    this.now = deps.now ?? (() => new Date());
    this.tz = deps.tz ?? env().TZ;
    this.coldStartDefaultLoadWh = (deps.coldStartDefaultLoadW ?? DEFAULT_COLD_START_LOAD_W) * (SLOT_MINUTES / 60);
  }

  /**
   * Rebuilds the in-memory load/solar profiles from the trailing 28 days of
   * telemetry_5m. Cheap query, but there's no benefit to running it more than
   * hourly, so repeated calls within REFRESH_INTERVAL_MS are a no-op unless
   * `force` is passed (or this is the very first call).
   */
  async refreshProfiles(force = false): Promise<void> {
    const nowTs = this.now();
    const isFirstRefresh = this.lastRefreshedAt === null;
    if (!force && !isFirstRefresh && nowTs.getTime() - this.lastRefreshedAt!.getTime() < REFRESH_INTERVAL_MS) {
      return;
    }

    const from = new Date(nowTs.getTime() - PROFILE_WINDOW_DAYS * 24 * 60 * 60_000);
    const rows = await this.fetchTelemetry5m(from, nowTs);

    this.loadProfile = buildLoadProfile(rows, this.tz);
    this.solarProfile = buildSolarProfile(rows, this.tz);
    this.lastRefreshedAt = nowTs;

    // Heuristic for "no/insufficient history": fewer than a full day of
    // 5-minute samples on the very first refresh. Logged once so it doesn't
    // spam every hourly refresh while the profile is still filling in.
    if (isFirstRefresh && rows.length < SLOTS_PER_DAY && !this.warnedColdStart) {
      this.warnedColdStart = true;
      log.warn(
        "forecast: insufficient telemetry history for profile-based forecasting yet; falling back to flat cold-start defaults (load) and zero (solar). Predictions will improve as telemetry_5m accrues (targets 28 days of history).",
        { observedRows: rows.length, coldStartDefaultLoadWh: this.coldStartDefaultLoadWh },
      );
    }
  }

  /** Mean load_energy_wh over the trailing PERSISTENCE_WINDOW_MIN minutes; null if no data. */
  private recentPersistenceLoadWh(rows: readonly Telemetry5mRow[], now: Date): number | null {
    const cutoff = now.getTime() - PERSISTENCE_WINDOW_MIN * 60_000;
    const values: number[] = [];
    for (const row of rows) {
      const t = row.bucket.getTime();
      if (t < cutoff || t > now.getTime()) continue;
      if (row.load_energy_wh !== null) values.push(row.load_energy_wh);
    }
    return values.length === 0 ? null : mean(values);
  }

  /** Actual-vs-profile solar ratio over the trailing CLEARNESS_WINDOW_HOURS, restricted to profile-daylight slots. */
  private recentClearness(rows: readonly Telemetry5mRow[], now: Date, solarProfile: SolarProfile): number {
    const cutoff = now.getTime() - CLEARNESS_WINDOW_HOURS * 60 * 60_000;
    let actualSum = 0;
    let predictedSum = 0;
    let daylightSlotCount = 0;

    for (const row of rows) {
      const t = row.bucket.getTime();
      if (t < cutoff || t > now.getTime()) continue;
      const { slotOfDay } = slotInfo(row.bucket, this.tz);
      const predicted = solarProfile[slotOfDay] ?? 0;
      if (predicted <= 0) continue; // profile says this slot is night; skip
      daylightSlotCount += 1;
      predictedSum += predicted;
      actualSum += row.pv_energy_wh ?? 0;
    }

    return clearnessFactor(actualSum, predictedSum, daylightSlotCount * SLOT_MINUTES);
  }

  /**
   * Forecasts the next `horizonSlots` 5-minute slots from `now`, snapshotting
   * every predicted slot into the forecasts table (kind 'load' and 'solar',
   * model "profile-v1").
   */
  async forecast(now: Date, horizonSlots: number = SLOTS_PER_DAY): Promise<ForecastSlot[]> {
    await this.refreshProfiles();
    const loadProfile = this.loadProfile ?? { weekday: [], weekend: [] };
    const solarProfile = this.solarProfile ?? [];

    const recentFrom = new Date(now.getTime() - CLEARNESS_WINDOW_HOURS * 60 * 60_000);
    const recentRows = await this.fetchTelemetry5m(recentFrom, now);

    const slot0Start = new Date(Math.floor(now.getTime() / SLOT_MS) * SLOT_MS);
    const info0 = slotInfo(slot0Start, this.tz);
    const fallbackLoadWh = loadProfile[info0.dayType][info0.slotOfDay] ?? this.coldStartDefaultLoadWh;
    const persistenceLoadWh = this.recentPersistenceLoadWh(recentRows, now) ?? fallbackLoadWh;
    const clearness = this.recentClearness(recentRows, now, solarProfile);

    const slots: ForecastSlot[] = [];
    const forecastRows: ForecastRow[] = [];

    for (let h = 0; h < horizonSlots; h++) {
      const slotStart = new Date(slot0Start.getTime() + h * SLOT_MS);
      const info = slotInfo(slotStart, this.tz);
      const loadProfileWh = loadProfile[info.dayType][info.slotOfDay] ?? this.coldStartDefaultLoadWh;
      const solarProfileWh = solarProfile[info.slotOfDay] ?? 0;

      const w = Math.exp(-h / PERSISTENCE_DECAY_SLOTS);
      const loadWh = w * persistenceLoadWh + (1 - w) * loadProfileWh;
      const solarWh = Math.max(0, solarProfileWh * clearness);

      slots.push({ slotStart, loadWh, solarWh });
      forecastRows.push(
        { created_at: now, target_start: slotStart, kind: "load", energy_wh: loadWh, model: MODEL_TAG },
        { created_at: now, target_start: slotStart, kind: "solar", energy_wh: solarWh, model: MODEL_TAG },
      );
    }

    await this.insertForecastsFn(forecastRows);
    return slots;
  }

  /**
   * Scores previously-snapshotted forecasts (target_start in [from, to])
   * against telemetry_5m actuals, grouped by kind and horizon bucket
   * (0-1h/1-4h/4-12h/12-24h, measured from each forecast's own created_at).
   * Points whose actual is ~0 Wh are excluded from MAPE (division blowup —
   * common for solar at night) but still counted in bias.
   */
  async accuracy(from: Date, to: Date): Promise<AccuracyResult> {
    const [forecasts, actualRows] = await Promise.all([
      this.fetchForecastsFn(from, to),
      this.fetchTelemetry5m(from, to),
    ]);

    const actualsByBucket = new Map<number, Telemetry5mRow>();
    for (const row of actualRows) actualsByBucket.set(row.bucket.getTime(), row);

    const accumulators: Record<"load" | "solar", Record<HorizonBucket, Accumulator>> = {
      load: emptyHorizonAccumulators(),
      solar: emptyHorizonAccumulators(),
    };

    for (const forecastRow of forecasts) {
      if (forecastRow.energy_wh === null) continue;
      const actualRow = actualsByBucket.get(forecastRow.target_start.getTime());
      if (!actualRow) continue;

      const actual = forecastRow.kind === "load" ? actualRow.load_energy_wh : actualRow.pv_energy_wh;
      if (actual === null) continue;

      const horizonHours = (forecastRow.target_start.getTime() - forecastRow.created_at.getTime()) / 3_600_000;
      const bucket = horizonBucketOf(horizonHours);
      if (!bucket) continue;

      const target = accumulators[forecastRow.kind][bucket];
      target.biases.push(forecastRow.energy_wh - actual);
      if (Math.abs(actual) >= MAPE_MIN_ACTUAL_WH) {
        target.errors.push(Math.abs((forecastRow.energy_wh - actual) / actual));
      }
    }

    return {
      load: summarize(accumulators.load),
      solar: summarize(accumulators.solar),
    };
  }
}

export type { DayType, LoadProfile, SolarProfile };
