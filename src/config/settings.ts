import { z } from "zod";
import type { Sql } from "../db/client";
import { getDb } from "../db/client";
import { createLogger } from "../lib/logger";

const log = createLogger("settings");

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const socTargetSchema = z.object({
  time: z.string().regex(HHMM_RE, "expected HH:MM"),
  socPct: z.number().min(0).max(100),
});

/** zod schema for each known settings key, per design/db-schema.md. */
const schemas = {
  admin_password_hash: z.string().min(1),
  sigenergy: z.object({
    host: z.string(),
    port: z.number().int().positive().default(502),
    plantUnitId: z.number().int(),
    inverterUnitId: z.number().int(),
    pollIntervalMs: z.number().int().positive().default(10000),
  }),
  amber: z.object({
    apiToken: z.string(),
    siteId: z.string(),
    pollIntervalMs: z.number().int().positive().default(300000),
  }),
  battery: z.object({
    capacityWh: z.number().positive(),
    usableMinSocPct: z.number().min(0).max(100),
    maxChargeW: z.number().nonnegative(),
    maxDischargeW: z.number().nonnegative(),
    roundTripEfficiency: z.number().min(0).max(1).default(0.9),
  }),
  goals: z.object({
    maxCyclesPerDay: z.number().positive().default(1),
    socTargets: z.array(socTargetSchema).default([]),
    minCommandWindowMin: z.number().positive().default(5),
  }),
  demandWindow: z.object({
    enabled: z.boolean().default(false),
    start: z.string().regex(HHMM_RE).default("15:00"),
    end: z.string().regex(HHMM_RE).default("20:00"),
    bufferMin: z.number().nonnegative().default(10),
  }),
  mode: z.object({
    shadow: z.boolean().default(true),
  }),
  pricing: z.object({
    spikeSellThreshold: z.number().optional(),
  }),
} as const;

export type Schemas = typeof schemas;
export type SettingsKey = keyof Schemas;
export type SettingsValue<K extends SettingsKey> = z.infer<Schemas[K]>;

/**
 * Fallback values returned by `get()` when a key has never been written to the
 * DB. `admin_password_hash` is intentionally absent: its missing-ness is the
 * first-boot signal, and it has no default hash to fall back to, so `get()`
 * resolves it to null instead.
 */
const DEFAULTS: { [K in SettingsKey]?: SettingsValue<K> } = {
  sigenergy: { host: "", port: 502, plantUnitId: 1, inverterUnitId: 1, pollIntervalMs: 10000 },
  amber: { apiToken: "", siteId: "", pollIntervalMs: 300000 },
  battery: {
    capacityWh: 10000,
    usableMinSocPct: 10,
    maxChargeW: 5000,
    maxDischargeW: 5000,
    roundTripEfficiency: 0.9,
  },
  goals: { maxCyclesPerDay: 1, socTargets: [], minCommandWindowMin: 5 },
  demandWindow: { enabled: false, start: "15:00", end: "20:00", bufferMin: 10 },
  mode: { shadow: true },
  pricing: {},
};

/** Per-key field names whose values must never be logged verbatim. */
const SECRET_FIELDS: Partial<Record<SettingsKey, readonly string[]>> = {
  amber: ["apiToken"],
};

/** Redacts secret sub-fields (and whole-value secrets) before logging. */
function redact(key: SettingsKey, value: unknown): unknown {
  if (key === "admin_password_hash") return "[redacted]";
  const secretFields = SECRET_FIELDS[key];
  if (!secretFields || typeof value !== "object" || value === null) return value;
  const clone: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  for (const field of secretFields) {
    if (field in clone) clone[field] = "[redacted]";
  }
  return clone;
}

/**
 * Typed, cached accessor for the `settings` table. Values are validated
 * against the zod schema for their key on both read and write; missing keys
 * fall back to documented defaults (except secrets/admin_password_hash,
 * which resolve to null so callers can detect "not configured").
 */
export class SettingsService {
  private readonly sql: Sql;
  private readonly cache = new Map<SettingsKey, unknown>();

  constructor(sql: Sql = getDb()) {
    this.sql = sql;
  }

  /** Drops all cached values, forcing the next get() to re-read from the DB. */
  invalidate(key?: SettingsKey): void {
    if (key) this.cache.delete(key);
    else this.cache.clear();
  }

  async get<K extends SettingsKey>(key: K): Promise<SettingsValue<K> | null> {
    if (this.cache.has(key)) return this.cache.get(key) as SettingsValue<K> | null;

    const rows = await this.sql<{ value: unknown }[]>`
      SELECT value FROM settings WHERE key = ${key}
    `;

    let result: SettingsValue<K> | null;
    if (rows.length === 0) {
      const fallback = DEFAULTS[key];
      result = fallback === undefined ? null : (fallback as SettingsValue<K>);
    } else {
      result = schemas[key].parse(rows[0]!.value) as SettingsValue<K>;
    }

    this.cache.set(key, result);
    return result;
  }

  async set<K extends SettingsKey>(key: K, value: SettingsValue<K>): Promise<void> {
    const parsed = schemas[key].parse(value) as SettingsValue<K>;

    await this.sql`
      INSERT INTO settings (key, value, updated_at)
      VALUES (${key}, ${this.sql.json(parsed)}, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at
    `;

    this.invalidate(key);
    log.info("setting updated", { key, value: redact(key, parsed) });
  }

  /** Fetches every known key (defaults applied where unset). */
  async getAll(): Promise<{ [K in SettingsKey]: SettingsValue<K> | null }> {
    const keys = Object.keys(schemas) as SettingsKey[];
    const entries = await Promise.all(keys.map(async (key) => [key, await this.get(key)] as const));
    return Object.fromEntries(entries) as { [K in SettingsKey]: SettingsValue<K> | null };
  }

  /** True until an admin password has been set (drives the first-boot setup flow). */
  async isFirstBoot(): Promise<boolean> {
    const hash = await this.get("admin_password_hash");
    return hash === null;
  }
}
