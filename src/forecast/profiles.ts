import type { Telemetry5mRow } from "../db/repositories";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 5-minute slots in a day: 24h * 60min / 5min. */
export const SLOTS_PER_DAY = 288;
export const SLOT_MINUTES = 5;

/** EWMA smoothing factor for the load profile (design/planner.md: "α≈0.2"). */
export const DEFAULT_EWMA_ALPHA = 0.2;

/** Percentile used for the solar "clear-sky-ish" envelope (design/planner.md: "90th percentile"). */
export const DEFAULT_SOLAR_PERCENTILE = 0.9;

/** clearnessFactor() clamp range (design/planner.md forecast section). */
export const CLEARNESS_MIN = 0.1;
export const CLEARNESS_MAX = 1.3;

/** Below this many minutes of daylight samples in the window, clearnessFactor() returns 1 (neutral). */
export const CLEARNESS_MIN_DAYLIGHT_MINUTES = 30;

// ---------------------------------------------------------------------------
// Timezone-aware slot-of-day
// ---------------------------------------------------------------------------

export type DayType = "weekday" | "weekend";

export interface SlotInfo {
  /** 0..287, the 5-minute slot within the local day. */
  slotOfDay: number;
  dayType: DayType;
  /** Local calendar date (YYYY-MM-DD in `tz`), used to fold observations day-by-day. */
  dateKey: string;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * Per-timezone Intl.DateTimeFormat cache: constructing a formatter is
 * comparatively expensive and profile builds call this once per row.
 */
const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(tz: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      // h23 avoids the en-US default hourCycle quirk that renders midnight as "24".
      hourCycle: "h23",
      weekday: "short",
    });
    formatterCache.set(tz, formatter);
  }
  return formatter;
}

/**
 * Computes local-timezone slot-of-day, weekday/weekend, and calendar date for
 * a UTC instant. Uses Intl.DateTimeFormat (IANA tz database) rather than a
 * fixed UTC offset so DST transitions (e.g. Australia/Sydney AEDT<->AEST) are
 * handled correctly — deliberately NOT `date.getHours()` (always local-to-the-
 * running-process) nor a hardcoded offset (wrong across DST boundaries).
 *
 * Known edge case: during the Australian DST "fall back" (clocks step back
 * 1h, first Sunday of April), local wall-clock time repeats for an hour, so
 * two distinct 5-minute telemetry buckets map to the same SlotInfo. This is
 * accepted as-is (folds as two observations of the same slot on the same
 * calendar day) — it affects one hour, one day a year, and disambiguating it
 * would require carrying UTC-offset state through the whole pipeline for
 * negligible profile-quality benefit.
 */
export function slotInfo(date: Date, tz: string): SlotInfo {
  const parts = formatterFor(tz).formatToParts(date);
  const get = (type: string): string => {
    const part = parts.find((p) => p.type === type);
    if (!part) throw new Error(`slotInfo: Intl.DateTimeFormat did not produce a "${type}" part`);
    return part.value;
  };

  const year = get("year");
  const month = get("month");
  const day = get("day");
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  const weekdayName = get("weekday");
  const weekday = WEEKDAY_INDEX[weekdayName];
  if (weekday === undefined) {
    throw new Error(`slotInfo: unrecognised weekday "${weekdayName}"`);
  }

  return {
    slotOfDay: hour * 12 + Math.floor(minute / 5),
    dayType: weekday === 0 || weekday === 6 ? "weekend" : "weekday",
    dateKey: `${year}-${month}-${day}`,
  };
}

// ---------------------------------------------------------------------------
// Load profile: EWMA of load_wh per (dayType, slotOfDay)
// ---------------------------------------------------------------------------

/**
 * Per-slot Wh, keyed by dayType; `null` means the slot has never been
 * observed (caller decides the cold-start fallback).
 */
export interface LoadProfile {
  weekday: (number | null)[];
  weekend: (number | null)[];
}

function emptySlots(): (number | null)[] {
  return new Array<number | null>(SLOTS_PER_DAY).fill(null);
}

/**
 * Builds the load profile by folding calendar days oldest -> newest, applying
 * an EWMA update per (dayType, slotOfDay) cell: `next = alpha*obs + (1-alpha)*prev`.
 * Folding oldest-first means the most recent day ends up weighted highest,
 * per design/planner.md.
 *
 * Missing slots (a day with no telemetry row for a given slot) are skipped
 * for that day/slot rather than treated as zero — the previous EWMA value
 * (from an older day) carries forward unchanged, so a data gap doesn't drag
 * the profile toward zero.
 *
 * If a slot has more than one observation within the same calendar day (can
 * happen across the DST "fall back" hour, see slotInfo()), the observations
 * are averaged before the EWMA update so that hour isn't double-weighted.
 */
export function buildLoadProfile(
  rows: readonly Telemetry5mRow[],
  tz: string,
  alpha: number = DEFAULT_EWMA_ALPHA,
): LoadProfile {
  const sorted = [...rows].sort((a, b) => a.bucket.getTime() - b.bucket.getTime());

  // Map preserves insertion order; since rows are chronological, each day's
  // key is first inserted in oldest-to-newest order too.
  const days = new Map<string, { dayType: DayType; slots: Map<number, number[]> }>();

  for (const row of sorted) {
    if (row.load_energy_wh === null) continue;
    const info = slotInfo(row.bucket, tz);
    let day = days.get(info.dateKey);
    if (!day) {
      day = { dayType: info.dayType, slots: new Map() };
      days.set(info.dateKey, day);
    }
    const existing = day.slots.get(info.slotOfDay);
    if (existing) existing.push(row.load_energy_wh);
    else day.slots.set(info.slotOfDay, [row.load_energy_wh]);
  }

  const profile: LoadProfile = { weekday: emptySlots(), weekend: emptySlots() };

  for (const day of days.values()) {
    const target = profile[day.dayType];
    for (const [slot, values] of day.slots) {
      const observed = values.reduce((sum, v) => sum + v, 0) / values.length;
      const prior = target[slot] ?? null;
      target[slot] = prior === null ? observed : alpha * observed + (1 - alpha) * prior;
    }
  }

  return profile;
}

// ---------------------------------------------------------------------------
// Solar profile: trailing high-percentile envelope per slotOfDay
// ---------------------------------------------------------------------------

/** Per-slot Wh; 0 where no daylight has ever been observed for that slot. */
export type SolarProfile = number[];

/** Linear-interpolation percentile (values need not be pre-sorted). */
function percentileOf(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 1) return sorted[0]!;
  const idx = p * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const frac = idx - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

/**
 * Builds the solar "clear-sky-ish" envelope: the p90 (default) of pv_energy_wh
 * pooled per slotOfDay across the whole trailing window (no day folding —
 * unlike load, solar has no weekday/weekend structure, only time-of-day and
 * weather). Slots with no observations (always night for that slot) are 0.
 */
export function buildSolarProfile(
  rows: readonly Telemetry5mRow[],
  tz: string,
  percentile: number = DEFAULT_SOLAR_PERCENTILE,
): SolarProfile {
  const buckets: number[][] = Array.from({ length: SLOTS_PER_DAY }, () => []);

  for (const row of rows) {
    if (row.pv_energy_wh === null) continue;
    const { slotOfDay } = slotInfo(row.bucket, tz);
    buckets[slotOfDay]!.push(row.pv_energy_wh);
  }

  return buckets.map((values) => (values.length === 0 ? 0 : Math.max(0, percentileOf(values, percentile))));
}

// ---------------------------------------------------------------------------
// Clearness factor: today's actual-vs-predicted solar ratio, near-term
// ---------------------------------------------------------------------------

/**
 * Ratio of recently-actual to recently-predicted solar energy (e.g. summed
 * over the last 2 daylight hours), clamped to [CLEARNESS_MIN, CLEARNESS_MAX].
 * Returns 1 (neutral — trust the profile as-is) when there isn't enough
 * daylight data to trust the ratio: night, just after sunrise, or a gappy
 * feed. `daylightSampleMinutes` is the caller-computed total time covered by
 * samples where the profile predicted nonzero solar (i.e. "this slot should
 * have been daylight").
 */
export function clearnessFactor(
  recentActualWh: number,
  recentPredictedWh: number,
  daylightSampleMinutes: number,
): number {
  if (daylightSampleMinutes < CLEARNESS_MIN_DAYLIGHT_MINUTES) return 1;
  if (!(recentPredictedWh > 0)) return 1;

  const ratio = recentActualWh / recentPredictedWh;
  if (!Number.isFinite(ratio)) return 1;

  return Math.min(CLEARNESS_MAX, Math.max(CLEARNESS_MIN, ratio));
}
