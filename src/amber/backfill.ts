import { createLogger } from "../lib/logger";
import type { NormalizedUsage } from "./client";

const log = createLogger("amber-backfill");

/** Modest spacing between requests so day-by-day backfill stays well under Amber's
 * ~50-requests-per-5-min account-wide budget (docs/amber-api.md §2). */
const DEFAULT_DELAY_MS = 1100;

/** Minimal client surface backfill needs — lets tests inject a fake without a real AmberClient. */
export interface UsageSource {
  getUsage(siteId: string, startDate: string, endDate: string): Promise<NormalizedUsage[]>;
}

export interface BackfillUsageOptions {
  now?: () => Date;
  sleepFn?: (ms: number) => Promise<void>;
  /** Delay between day-by-day requests; default DEFAULT_DELAY_MS. */
  delayMs?: number;
}

/** YYYY-MM-DD, per the `date` query param format documented for /sites/{id}/usage. */
function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Backfills `/sites/{siteId}/usage` one calendar day at a time (rather than the
 * documented max-7-day-per-request span) so a single slow/failed day doesn't
 * lose the whole range, and so the modest inter-request delay keeps us well
 * under Amber's per-account rate limit. Storage wiring (e.g. an `insertUsage`
 * repository function) is intentionally out of scope here — this just returns
 * normalised rows for the caller to persist.
 *
 * Note: day boundaries are computed in UTC (via `now`/`Date#toISOString`) for
 * simplicity; Amber's `date` field is a NEM-time (UTC+10) trading day, so a
 * day's `startDate`/`endDate` here may be offset by a few hours from the exact
 * NEM trading-day boundary. Acceptable for a coarse historical backfill; flagged
 * as a known simplification.
 */
export async function backfillUsage(
  client: UsageSource,
  siteId: string,
  days: number,
  options: BackfillUsageOptions = {},
): Promise<NormalizedUsage[]> {
  const { now = () => new Date(), sleepFn = defaultSleep, delayMs = DEFAULT_DELAY_MS } = options;
  if (days <= 0) return [];

  const today = now();
  const rows: NormalizedUsage[] = [];

  for (let offsetDays = days; offsetDays >= 1; offsetDays--) {
    const day = new Date(today.getTime() - offsetDays * 24 * 60 * 60 * 1000);
    const dateStr = formatDate(day);

    try {
      const usage = await client.getUsage(siteId, dateStr, dateStr);
      rows.push(...usage);
    } catch (err) {
      log.error("amber backfill: failed to fetch usage for day, skipping", {
        date: dateStr,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (offsetDays > 1) await sleepFn(delayMs);
  }

  return rows;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
