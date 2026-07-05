import type { SettingsKey, SettingsValue } from "../config/settings";
import type { OverrideInput, OverrideRow } from "../db/overrides";
import type { DecisionRow, PlanWithSlots, PriceRow, Telemetry5mRow, TelemetryRow } from "../db/repositories";
import type {
  ForecastServiceLike,
  OverridesRepoLike,
  PollerStatusLike,
  PollersLike,
  ReposLike,
  SettingsLike,
} from "../server/types";

// Self-contained fakes for src/mcp tests. Deliberately does NOT reuse/extend
// src/server/test-helpers.ts (out of scope to edit — see task boundaries),
// so this duplicates a little of its shape; kept intentionally small.

const ALL_KEYS: readonly SettingsKey[] = [
  "admin_password_hash",
  "sigenergy",
  "amber",
  "battery",
  "goals",
  "demandWindow",
  "mode",
  "pricing",
  "mcp",
];

/** Mirrors src/config/settings.ts DEFAULTS, for fakes only. */
const TEST_DEFAULTS: { [K in SettingsKey]?: SettingsValue<K> } = {
  sigenergy: { host: "", port: 502, plantUnitId: 1, inverterUnitId: 1, pollIntervalMs: 10000 },
  amber: { apiToken: "", siteId: "", pollIntervalMs: 300000 },
  battery: { capacityWh: 10000, usableMinSocPct: 10, maxChargeW: 5000, maxDischargeW: 5000, roundTripEfficiency: 0.9 },
  goals: { maxCyclesPerDay: 1, socTargets: [], minCommandWindowMin: 5 },
  demandWindow: { enabled: false, start: "15:00", end: "20:00", bufferMin: 10 },
  mode: { shadow: true },
  pricing: {},
  mcp: { enabled: true, token: "" },
};

/** In-memory SettingsLike including the `mcp` key (unlike src/server/test-helpers.ts's InMemorySettings, whose getAll() predates it). */
export class FakeSettings implements SettingsLike {
  private readonly store = new Map<SettingsKey, unknown>();

  constructor(initial: Partial<{ [K in SettingsKey]: SettingsValue<K> }> = {}) {
    for (const [key, value] of Object.entries(initial)) this.store.set(key as SettingsKey, value);
  }

  async get<K extends SettingsKey>(key: K): Promise<SettingsValue<K> | null> {
    if (this.store.has(key)) return this.store.get(key) as SettingsValue<K>;
    return (TEST_DEFAULTS[key] ?? null) as SettingsValue<K> | null;
  }

  async set<K extends SettingsKey>(key: K, value: SettingsValue<K>): Promise<void> {
    this.store.set(key, value);
  }

  async getAll(): Promise<{ [K in SettingsKey]: SettingsValue<K> | null }> {
    const entries = await Promise.all(ALL_KEYS.map(async (key) => [key, await this.get(key)] as const));
    return Object.fromEntries(entries) as { [K in SettingsKey]: SettingsValue<K> | null };
  }

  async isFirstBoot(): Promise<boolean> {
    return (await this.get("admin_password_hash")) === null;
  }
}

const NOT_CONFIGURED: PollerStatusLike = { running: false, lastSuccess: null, lastError: null };

export function fakePollers(overrides: Partial<PollersLike> = {}): PollersLike {
  return {
    modbus: { status: () => NOT_CONFIGURED },
    amber: { status: () => NOT_CONFIGURED },
    ...overrides,
  };
}

function emptyBucket() {
  return { n: 0, mape: null, biasWh: null };
}

export function fakeForecastService(overrides: Partial<ForecastServiceLike> = {}): ForecastServiceLike {
  return {
    accuracy: async () => ({
      load: { "0-1h": emptyBucket(), "1-4h": emptyBucket(), "4-12h": emptyBucket(), "12-24h": emptyBucket() },
      solar: { "0-1h": emptyBucket(), "1-4h": emptyBucket(), "4-12h": emptyBucket(), "12-24h": emptyBucket() },
    }),
    ...overrides,
  };
}

export function fakeRepos(overrides: Partial<ReposLike> = {}): ReposLike {
  return {
    latestTelemetry: async (): Promise<TelemetryRow | null> => null,
    telemetryBetween: async (): Promise<TelemetryRow[]> => [],
    telemetry5mBetween: async (): Promise<Telemetry5mRow[]> => [],
    pricesBetween: async (): Promise<PriceRow[]> => [],
    latestPlan: async (): Promise<PlanWithSlots | null> => null,
    decisionsBetween: async (): Promise<DecisionRow[]> => [],
    ...overrides,
  };
}

export function fakeOverridesRepo(overrides: Partial<OverridesRepoLike> = {}): OverridesRepoLike {
  return {
    insertOverride: async (input: OverrideInput): Promise<OverrideRow> => ({
      ...input,
      id: 1,
      created_at: new Date(),
      status: "pending",
    }),
    listOverrides: async (): Promise<OverrideRow[]> => [],
    setOverrideStatus: async (): Promise<boolean> => true,
    ...overrides,
  };
}
