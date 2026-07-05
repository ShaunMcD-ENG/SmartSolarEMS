import type { SettingsKey, SettingsValue } from "../config/settings";
import type { OverrideInput, OverrideRow } from "../db/overrides";
import type {
  DecisionRow,
  PlanWithSlots,
  PriceRow,
  Telemetry5mRow,
  TelemetryRow,
} from "../db/repositories";
import type { SessionRecord, SessionStore } from "./auth";
import type { AppDeps, PollerStatusLike } from "./types";

/** Mirrors the documented defaults in src/config/settings.ts DEFAULTS, for fakes only. */
const FAKE_DEFAULTS: { [K in SettingsKey]?: SettingsValue<K> } = {
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

const SETTINGS_KEYS = [
  "admin_password_hash",
  "sigenergy",
  "amber",
  "battery",
  "goals",
  "demandWindow",
  "mode",
  "pricing",
] as const satisfies readonly SettingsKey[];

/**
 * In-memory stand-in for SettingsService (no DB), for tests. Values passed
 * to the constructor are used as-is (NOT re-validated against the real zod
 * schemas) so tests can be terse; this is deliberately a dumb store.
 */
export class InMemorySettings {
  private readonly store = new Map<SettingsKey, unknown>();

  constructor(initial: { [K in SettingsKey]?: SettingsValue<K> } = {}) {
    for (const [key, value] of Object.entries(initial)) {
      this.store.set(key as SettingsKey, value);
    }
  }

  async get<K extends SettingsKey>(key: K): Promise<SettingsValue<K> | null> {
    if (this.store.has(key)) return this.store.get(key) as SettingsValue<K>;
    const fallback = FAKE_DEFAULTS[key];
    return (fallback ?? null) as SettingsValue<K> | null;
  }

  async set<K extends SettingsKey>(key: K, value: SettingsValue<K>): Promise<void> {
    this.store.set(key, value);
  }

  async getAll(): Promise<{ [K in SettingsKey]: SettingsValue<K> | null }> {
    const entries = await Promise.all(SETTINGS_KEYS.map(async (key) => [key, await this.get(key)] as const));
    return Object.fromEntries(entries) as { [K in SettingsKey]: SettingsValue<K> | null };
  }

  async isFirstBoot(): Promise<boolean> {
    return (await this.get("admin_password_hash")) === null;
  }
}

/** In-memory stand-in for the `sessions` table (no DB), for tests. */
export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRecord>();

  async create(record: SessionRecord): Promise<void> {
    this.sessions.set(record.id, record);
  }

  async find(id: string): Promise<SessionRecord | null> {
    return this.sessions.get(id) ?? null;
  }

  async remove(id: string): Promise<void> {
    this.sessions.delete(id);
  }

  size(): number {
    return this.sessions.size;
  }
}

const NOT_CONFIGURED_STATUS: PollerStatusLike = { running: false, lastSuccess: null, lastError: null };

/** Builds a fully-fake AppDeps with empty-but-well-typed repos/overrides/forecast, for tests. */
export function makeFakeDeps(overrides: Partial<AppDeps> = {}): AppDeps {
  const defaults: AppDeps = {
    settings: new InMemorySettings(),
    sessions: new InMemorySessionStore(),
    pollers: {
      modbus: { status: () => NOT_CONFIGURED_STATUS },
      amber: { status: () => NOT_CONFIGURED_STATUS },
    },
    forecastService: {
      accuracy: async () => ({
        load: emptyAccuracy(),
        solar: emptyAccuracy(),
      }),
    },
    repos: {
      latestTelemetry: async (): Promise<TelemetryRow | null> => null,
      telemetryBetween: async (): Promise<TelemetryRow[]> => [],
      telemetry5mBetween: async (): Promise<Telemetry5mRow[]> => [],
      pricesBetween: async (): Promise<PriceRow[]> => [],
      latestPlan: async (): Promise<PlanWithSlots | null> => null,
      decisionsBetween: async (): Promise<DecisionRow[]> => [],
    },
    overridesRepo: {
      insertOverride: async (input: OverrideInput): Promise<OverrideRow> => ({
        ...input,
        id: 1,
        created_at: new Date(),
        status: "pending",
      }),
      listOverrides: async (): Promise<OverrideRow[]> => [],
      setOverrideStatus: async (): Promise<boolean> => true,
    },
  };

  return { ...defaults, ...overrides };
}

function emptyAccuracy() {
  const bucket = { n: 0, mape: null, biasWh: null };
  return {
    "0-1h": bucket,
    "1-4h": bucket,
    "4-12h": bucket,
    "12-24h": bucket,
  };
}
