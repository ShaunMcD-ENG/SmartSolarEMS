/**
 * Demand-window conflict detection for user overrides (design/db-schema.md
 * `overrides` table, progress.md "demand window" hard requirement).
 *
 * The demand window (e.g. 15:00-20:00, +/- a buffer) is specified as local
 * wall-clock HH:MM and recurs daily; overrides are absolute UTC instants. This
 * module converts between the two using Intl.DateTimeFormat (IANA tz
 * database) rather than a fixed UTC offset, so it stays correct across DST
 * transitions.
 */

export interface DemandWindowConfig {
  enabled: boolean;
  start: string; // "HH:MM"
  end: string; // "HH:MM"
  bufferMin: number;
}

/** Conservative assumed duration for open-ended (energy-target) overrides, per task spec. */
export const ASSUMED_ENERGY_OVERRIDE_MAX_MS = 6 * 60 * 60_000;

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
      second: "2-digit",
      hourCycle: "h23",
    });
    formatterCache.set(tz, formatter);
  }
  return formatter;
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  dateKey: string;
}

function localParts(date: Date, tz: string): LocalParts {
  const parts = formatterFor(tz).formatToParts(date);
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const year = get("year");
  const month = get("month");
  const day = get("day");
  return {
    year,
    month,
    day,
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
    dateKey: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
  };
}

/** UTC-offset (in minutes, east-positive) of `tz` at `date`. */
function utcOffsetMinutes(date: Date, tz: string): number {
  const p = localParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - date.getTime()) / 60_000);
}

/** The UTC instant corresponding to local wall-clock `hhmm` on local calendar date `dateKey`, in `tz`. */
function localHhmmToUtc(dateKey: string, hhmm: string, tz: string): Date {
  const [year, month, day] = dateKey.split("-").map(Number) as [number, number, number];
  const [hour, minute] = hhmm.split(":").map(Number) as [number, number];
  const naiveUtcMs = Date.UTC(year, month - 1, day, hour, minute);

  // The offset can only differ between our first guess and the true answer
  // across a DST transition at this exact date/time, so two passes always
  // converge (and one is enough in the overwhelming majority of cases).
  let candidate = new Date(naiveUtcMs);
  for (let i = 0; i < 2; i++) {
    const offsetMin = utcOffsetMinutes(candidate, tz);
    const next = new Date(naiveUtcMs - offsetMin * 60_000);
    if (next.getTime() === candidate.getTime()) break;
    candidate = next;
  }
  return candidate;
}

/**
 * True if [overrideStart, overrideEnd) overlaps the demand window (expanded
 * by bufferMin on both sides) on any of the local calendar days the override
 * touches. Checks the override's local start date plus the adjacent day
 * before/after, so windows near local midnight are still caught.
 */
export function demandWindowConflict(
  demandWindow: DemandWindowConfig,
  tz: string,
  overrideStart: Date,
  overrideEnd: Date,
): boolean {
  if (!demandWindow.enabled) return false;

  const bufferMs = demandWindow.bufferMin * 60_000;
  const dateKeys = new Set<string>();
  for (const dayOffsetMs of [-86_400_000, 0, 86_400_000]) {
    dateKeys.add(localParts(new Date(overrideStart.getTime() + dayOffsetMs), tz).dateKey);
  }

  for (const dateKey of dateKeys) {
    const windowStart = localHhmmToUtc(dateKey, demandWindow.start, tz);
    let windowEnd = localHhmmToUtc(dateKey, demandWindow.end, tz);
    if (windowEnd <= windowStart) {
      windowEnd = new Date(windowEnd.getTime() + 86_400_000); // window crosses local midnight
    }

    const bufferedStart = new Date(windowStart.getTime() - bufferMs);
    const bufferedEnd = new Date(windowEnd.getTime() + bufferMs);

    if (overrideStart.getTime() < bufferedEnd.getTime() && overrideEnd.getTime() > bufferedStart.getTime()) {
      return true;
    }
  }

  return false;
}
