import { z } from "zod";
import { createLogger } from "../lib/logger";

const log = createLogger("amber-client");

const DEFAULT_BASE_URL = "https://api.amber.com.au/v1";

/** Default single-retry backoff when a response carries no usable rate-limit header. */
const DEFAULT_BACKOFF_MS = 1000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Base error for any non-2xx Amber API response (after the single retry, if any). */
export class AmberApiError extends Error {
  readonly status?: number;
  readonly body?: unknown;

  constructor(message: string, opts: { status?: number; body?: unknown } = {}) {
    super(message);
    this.name = "AmberApiError";
    this.status = opts.status;
    this.body = opts.body;
  }
}

/** Thrown when a 429 response is still rate-limited after the single retry. */
export class AmberRateLimitError extends AmberApiError {
  readonly retryAfterMs?: number;

  constructor(message: string, opts: { status?: number; body?: unknown; retryAfterMs?: number } = {}) {
    super(message, opts);
    this.name = "AmberRateLimitError";
    this.retryAfterMs = opts.retryAfterMs;
  }
}

// ---------------------------------------------------------------------------
// Tolerant enum helper — per docs/amber-api.md, unknown enum values (e.g. Amber
// adding a new `descriptor`/`spikeStatus` value) must never throw. This keeps the
// known values as the "expected" type for editor support/documentation while
// still accepting (and passing through unchanged) any other string.
// ---------------------------------------------------------------------------

function looseEnum<const T extends readonly string[]>(_known: T): z.ZodType<T[number] | (string & {})> {
  return z.string() as unknown as z.ZodType<T[number] | (string & {})>;
}

const CHANNEL_TYPES = ["general", "controlledLoad", "feedIn"] as const;
const SITE_STATUSES = ["pending", "active", "closed"] as const;
const SPIKE_STATUSES = ["none", "potential", "spike"] as const;
const PRICE_DESCRIPTORS = [
  "negative",
  "extremelyLow",
  "veryLow",
  "low",
  "neutral",
  "high",
  "spike",
] as const;
const TOU_PERIODS = ["offPeak", "shoulder", "solarSponge", "peak"] as const;
const TOU_SEASONS = [
  "default",
  "summer",
  "autumn",
  "winter",
  "spring",
  "nonSummer",
  "holiday",
  "weekend",
  "weekendHoliday",
  "weekday",
] as const;
const USAGE_QUALITIES = ["estimated", "billable"] as const;

export type ChannelType = (typeof CHANNEL_TYPES)[number] | (string & {});

// ---------------------------------------------------------------------------
// Sites
// ---------------------------------------------------------------------------

const channelSchema = z.looseObject({
  identifier: z.string(),
  type: looseEnum(CHANNEL_TYPES),
  tariff: z.string(),
});

const siteSchema = z.looseObject({
  id: z.string(),
  nmi: z.string(),
  channels: z.array(channelSchema),
  network: z.string(),
  status: looseEnum(SITE_STATUSES),
  activeFrom: z.string().optional(),
  closedOn: z.string().optional(),
  intervalLength: z.number(),
});

export type Site = z.infer<typeof siteSchema>;

// ---------------------------------------------------------------------------
// Price intervals
// ---------------------------------------------------------------------------

const rangeSchema = z
  .object({ min: z.number(), max: z.number() })
  .nullable()
  .optional();

const advancedPriceSchema = z
  .object({ low: z.number(), predicted: z.number(), high: z.number() })
  .nullable()
  .optional();

const tariffInformationSchema = z
  .looseObject({
    period: looseEnum(TOU_PERIODS).optional(),
    season: looseEnum(TOU_SEASONS).optional(),
    block: z.number().optional(),
    demandWindow: z.boolean().optional(),
  })
  .nullable()
  .optional();

const baseIntervalFields = {
  duration: z.number(),
  spotPerKwh: z.number(),
  perKwh: z.number(),
  date: z.string(),
  nemTime: z.string(),
  startTime: z.string().optional(),
  endTime: z.string().optional(),
  renewables: z.number(),
  channelType: looseEnum(CHANNEL_TYPES),
  tariffInformation: tariffInformationSchema,
  spikeStatus: looseEnum(SPIKE_STATUSES),
  descriptor: looseEnum(PRICE_DESCRIPTORS),
} as const;

const actualIntervalSchema = z.looseObject({
  type: z.literal("ActualInterval"),
  ...baseIntervalFields,
});

const currentIntervalSchema = z.looseObject({
  type: z.literal("CurrentInterval"),
  ...baseIntervalFields,
  estimate: z.boolean(),
  range: rangeSchema,
  advancedPrice: advancedPriceSchema,
});

const forecastIntervalSchema = z.looseObject({
  type: z.literal("ForecastInterval"),
  ...baseIntervalFields,
  range: rangeSchema,
  advancedPrice: advancedPriceSchema,
});

const intervalSchema = z.discriminatedUnion("type", [
  actualIntervalSchema,
  currentIntervalSchema,
  forecastIntervalSchema,
]);

export type RawInterval = z.infer<typeof intervalSchema>;
export type IntervalType = RawInterval["type"];

/**
 * Normalised interval, ready for storage. `perKwh`/`spotPerKwh` are normalised
 * at the boundary per docs/amber-api.md §5: `feedIn` sign is flipped so that,
 * in our domain, positive = cents you EARN per kWh exported; `general`/
 * `controlledLoad` stay cost-positive (positive = cents you pay). `range` and
 * `advancedPrice` are passed through *unmodified* (raw, cost-positive
 * convention) — docs/amber-api.md only documents the sign gotcha for
 * `perKwh`/`spotPerKwh`, not for these, so we don't guess at a sign flip for
 * them (see deviations note in the task report).
 */
export interface NormalizedInterval {
  type: IntervalType;
  channelType: ChannelType;
  durationMin: number;
  /** Interval START (Amber's `nemTime` is interval-END, fixed UTC+10, no DST). */
  intervalStart: Date;
  /** Normalised: earn-positive for feedIn, cost-positive for general/controlledLoad. */
  perKwh: number;
  /** Same normalisation as perKwh. */
  spotPerKwh: number;
  renewables: number | null;
  spikeStatus: string | null;
  descriptor: string | null;
  tariffInformation: unknown | null;
  /** Only meaningful for CurrentInterval; null for Actual/Forecast. */
  estimate: boolean | null;
  range: { min: number; max: number } | null;
  advancedPrice: { low: number; predicted: number; high: number } | null;
  /** Original API payload for this interval, verbatim (for forecast-snapshot storage). */
  raw: unknown;
}

/**
 * NEM time is a fixed UTC+10 offset year-round (no daylight saving) and always
 * represents the END of the interval (docs/amber-api.md §6). If the string
 * already carries a timezone designator, it's respected as-is; otherwise
 * `+10:00` is assumed, per the documented fixed-offset convention.
 */
export function nemTimeToUtc(nemTime: string): Date {
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/.test(nemTime);
  const iso = hasOffset ? nemTime : `${nemTime}+10:00`;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`amber-client: invalid nemTime value: ${nemTime}`);
  }
  return parsed;
}

/** Interval START = interval END (derived from nemTime) minus duration minutes. */
export function intervalStartFromNemTime(nemTime: string, durationMin: number): Date {
  const end = nemTimeToUtc(nemTime);
  return new Date(end.getTime() - durationMin * 60_000);
}

/** feedIn perKwh/spotPerKwh sign is inverted by the API; flip it to earn-positive. */
function normalizeChannelPrice(channelType: string, rawValue: number): number {
  return channelType === "feedIn" ? -rawValue : rawValue;
}

export function normalizeInterval(raw: RawInterval): NormalizedInterval {
  return {
    type: raw.type,
    channelType: raw.channelType,
    durationMin: raw.duration,
    intervalStart: intervalStartFromNemTime(raw.nemTime, raw.duration),
    perKwh: normalizeChannelPrice(raw.channelType, raw.perKwh),
    spotPerKwh: normalizeChannelPrice(raw.channelType, raw.spotPerKwh),
    renewables: raw.renewables ?? null,
    spikeStatus: raw.spikeStatus ?? null,
    descriptor: raw.descriptor ?? null,
    tariffInformation: raw.tariffInformation ?? null,
    estimate: raw.type === "CurrentInterval" ? raw.estimate : null,
    range: raw.type === "ActualInterval" ? null : (raw.range ?? null),
    advancedPrice: raw.type === "ActualInterval" ? null : (raw.advancedPrice ?? null),
    raw,
  };
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

const usageSchema = z.looseObject({
  type: z.literal("Usage"),
  channelIdentifier: z.string(),
  kwh: z.number(),
  quality: looseEnum(USAGE_QUALITIES),
  cost: z.number(),
  ...baseIntervalFields,
});

export type RawUsage = z.infer<typeof usageSchema>;

export interface NormalizedUsage {
  type: "Usage";
  channelType: ChannelType;
  channelIdentifier: string;
  durationMin: number;
  intervalStart: Date;
  /** Consumed (positive) or generated (negative) kWh — kept as documented, no sign flip. */
  kwh: number;
  /** Total cost for the interval, incl. GST, as documented (no sign flip). */
  cost: number;
  quality: string;
  renewables: number | null;
  raw: unknown;
}

export function normalizeUsage(raw: RawUsage): NormalizedUsage {
  return {
    type: "Usage",
    channelType: raw.channelType,
    channelIdentifier: raw.channelIdentifier,
    durationMin: raw.duration,
    intervalStart: intervalStartFromNemTime(raw.nemTime, raw.duration),
    kwh: raw.kwh,
    cost: raw.cost,
    quality: raw.quality,
    renewables: raw.renewables ?? null,
    raw,
  };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface AmberClientOptions {
  baseUrl?: string;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchFn?: typeof fetch;
  /** Injectable for tests so retry-backoff tests don't need to sleep for real. */
  sleepFn?: (ms: number) => Promise<void>;
}

/** Reads Retry-After (seconds or HTTP-date) then RateLimit-Reset (seconds) for backoff. */
function retryDelayMs(headers: Headers): number {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
    const asDate = Date.parse(retryAfter);
    if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  }
  const rateLimitReset = headers.get("ratelimit-reset");
  if (rateLimitReset !== null) {
    const seconds = Number(rateLimitReset);
    if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
  }
  return DEFAULT_BACKOFF_MS;
}

async function readBodySafely(res: Response): Promise<unknown> {
  try {
    return await res.clone().json();
  } catch {
    try {
      return await res.text();
    } catch {
      return undefined;
    }
  }
}

/**
 * Thin client over Amber Electric's public API (docs/amber-api.md). Bearer-auth,
 * zod-validated (tolerant of unknown enum values/extra fields), single-retry with
 * backoff on 429/5xx honouring RateLimit- and Retry-After headers, typed errors
 * otherwise. Sign/timestamp normalisation happens here at the boundary so nothing
 * downstream has to know about Amber's feed-in sign gotcha or interval-ending
 * nemTime convention.
 */
export class AmberClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;

  constructor(
    private readonly token: string,
    options: AmberClientOptions = {},
  ) {
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleepFn = options.sleepFn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private buildUrl(path: string, query: Record<string, string | number | undefined> = {}): string {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  /** Issues the request, retrying exactly once on 429/5xx with header-driven backoff. */
  private async fetchJson(path: string, query: Record<string, string | number | undefined> = {}): Promise<unknown> {
    const url = this.buildUrl(path, query);
    const doFetch = (): Promise<Response> =>
      this.fetchFn(url, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
        },
      });

    let res = await doFetch();

    if (!res.ok && (res.status === 429 || res.status >= 500)) {
      const delayMs = retryDelayMs(res.headers);
      log.warn("amber request failed, retrying once", { path, status: res.status, delayMs });
      await this.sleepFn(delayMs);
      res = await doFetch();
    }

    if (!res.ok) {
      const body = await readBodySafely(res);
      const message = `Amber API request failed: ${res.status} ${res.statusText} for ${path}`;
      if (res.status === 429) {
        throw new AmberRateLimitError(message, { status: res.status, body, retryAfterMs: retryDelayMs(res.headers) });
      }
      throw new AmberApiError(message, { status: res.status, body });
    }

    return res.json();
  }

  async getSites(): Promise<Site[]> {
    const json = await this.fetchJson("/sites");
    const result = z.array(siteSchema).safeParse(json);
    if (!result.success) {
      throw new AmberApiError("amber-client: failed to parse /sites response", { body: result.error.issues });
    }
    return result.data;
  }

  /**
   * Fetches current + surrounding forecast/actual intervals for every channel at
   * the site (general/controlledLoad/feedIn all come back in one response, per
   * docs/amber-api.md — filter by `channelType`, don't rely on array position).
   * Defaults (`next=288`, `previous=12`, `resolution=5`) cover 24h of 5-min
   * forecast plus the last hour of actuals.
   */
  async getCurrentPrices(
    siteId: string,
    opts: { next?: number; previous?: number; resolution?: 5 | 30 } = {},
  ): Promise<NormalizedInterval[]> {
    const { next = 288, previous = 12, resolution = 5 } = opts;
    const json = await this.fetchJson(`/sites/${encodeURIComponent(siteId)}/prices/current`, {
      next,
      previous,
      resolution,
    });
    return this.parseIntervals(json);
  }

  /** Fetches priced intervals between startDate/endDate (inclusive, max 7-day span). */
  async getPrices(
    siteId: string,
    startDate: string,
    endDate: string,
    resolution: 5 | 30 = 5,
  ): Promise<NormalizedInterval[]> {
    const json = await this.fetchJson(`/sites/${encodeURIComponent(siteId)}/prices`, {
      startDate,
      endDate,
      resolution,
    });
    return this.parseIntervals(json);
  }

  /** Fetches metered usage between startDate/endDate (inclusive, max 7-day span). */
  async getUsage(siteId: string, startDate: string, endDate: string): Promise<NormalizedUsage[]> {
    const json = await this.fetchJson(`/sites/${encodeURIComponent(siteId)}/usage`, {
      startDate,
      endDate,
    });
    return this.parseUsage(json);
  }

  /** Parses each element independently so one malformed interval never fails the batch. */
  private parseIntervals(json: unknown): NormalizedInterval[] {
    if (!Array.isArray(json)) {
      throw new AmberApiError("amber-client: expected an array of intervals");
    }
    const out: NormalizedInterval[] = [];
    for (const item of json) {
      const result = intervalSchema.safeParse(item);
      if (result.success) {
        out.push(normalizeInterval(result.data));
      } else {
        log.warn("amber-client: skipping unparsable interval", { issues: result.error.issues });
      }
    }
    return out;
  }

  private parseUsage(json: unknown): NormalizedUsage[] {
    if (!Array.isArray(json)) {
      throw new AmberApiError("amber-client: expected an array of usage records");
    }
    const out: NormalizedUsage[] = [];
    for (const item of json) {
      const result = usageSchema.safeParse(item);
      if (result.success) {
        out.push(normalizeUsage(result.data));
      } else {
        log.warn("amber-client: skipping unparsable usage record", { issues: result.error.issues });
      }
    }
    return out;
  }
}
