import type { SettingsKey, SettingsValue } from "../config/settings";
import type {
  DecisionRow,
  PlanWithSlots,
  PriceRow,
  Telemetry5mRow,
  TelemetryRow,
} from "../db/repositories";
import type { OverrideInput, OverrideRow, OverrideStatus } from "../db/overrides";
import type { AccuracyResult } from "../forecast/service";
import type { SessionStore } from "./auth";

/**
 * Structural subset of `SettingsService` (src/config/settings.ts) that the
 * server layer needs. Declared locally (rather than importing the concrete
 * class as the dependency type) so tests can inject an in-memory fake — same
 * pattern as `PollIntervalSource`/`AmberSettingsSource` in src/modbus/poller.ts
 * and src/amber/poller.ts. The real `SettingsService` satisfies this
 * structurally.
 */
export interface SettingsLike {
  get<K extends SettingsKey>(key: K): Promise<SettingsValue<K> | null>;
  set<K extends SettingsKey>(key: K, value: SettingsValue<K>): Promise<void>;
  getAll(): Promise<{ [K in SettingsKey]: SettingsValue<K> | null }>;
  isFirstBoot(): Promise<boolean>;
}

/** Minimal shape both TelemetryPoller.status() and PricePoller.status() satisfy. */
export interface PollerStatusLike {
  running: boolean;
  lastSuccess: Date | null;
  lastError: string | null;
}

export interface PollersLike {
  modbus: { status(): PollerStatusLike };
  amber: { status(): PollerStatusLike };
}

/**
 * Structural mirror of ExecutorService.status() (src/executor/service.ts),
 * declared locally per this file's usual pattern (see PollerStatusLike above)
 * so tests can inject a fake without importing the executor module.
 */
export interface ExecutorStatusLike {
  running: boolean;
  mode: "shadow" | "active";
  lastTick: Date | null;
  lastAction: string | null;
  lastError: string | null;
  consecutiveModbusFailures: number;
  failSafeEngaged: boolean;
}

/** Structural subset of ForecastService (src/forecast/service.ts). */
export interface ForecastServiceLike {
  accuracy(from: Date, to: Date): Promise<AccuracyResult>;
}

/** Structural subset of the repository functions in src/db/repositories.ts. */
export interface ReposLike {
  latestTelemetry(): Promise<TelemetryRow | null>;
  telemetryBetween(from: Date, to: Date): Promise<TelemetryRow[]>;
  telemetry5mBetween(from: Date, to: Date): Promise<Telemetry5mRow[]>;
  pricesBetween(from: Date, to: Date, channel: string): Promise<PriceRow[]>;
  latestPlan(): Promise<PlanWithSlots | null>;
  decisionsBetween(from: Date, to: Date): Promise<DecisionRow[]>;
}

/** Structural subset of src/db/overrides.ts. */
export interface OverridesRepoLike {
  insertOverride(input: OverrideInput): Promise<OverrideRow>;
  listOverrides(opts?: { statuses?: OverrideStatus[]; limit?: number }): Promise<OverrideRow[]>;
  setOverrideStatus(id: number, status: OverrideStatus): Promise<boolean>;
}

/**
 * Everything the Hono app needs, injected so tests can pass fakes instead of
 * live DB/Modbus/Amber/forecast wiring. Real wiring is assembled in
 * src/index.ts.
 */
export interface AppDeps {
  settings: SettingsLike;
  sessions: SessionStore;
  pollers: PollersLike;
  forecastService: ForecastServiceLike;
  repos: ReposLike;
  overridesRepo: OverridesRepoLike;
  /** Optional (added once src/index.ts wires up ExecutorService); /api/status includes it when present. */
  executor?: { status(): ExecutorStatusLike };
  /** Injectable clock for tests; defaults to `() => new Date()`. */
  now?: () => Date;
  /** Reported by /api/health and /api/status; defaults to package.json's version. */
  version?: string;
  /** Directory to serve the built frontend from, if it exists; defaults to src/web/dist. */
  webDistDir?: string;
  /**
   * Mounts the read-only MCP audit endpoint (POST/GET/DELETE /mcp, see
   * src/mcp/server.ts) when true. All data the MCP tools read is already
   * present elsewhere on AppDeps (settings/pollers/forecastService/repos/
   * overridesRepo/executor), so this is a plain opt-in toggle rather than a
   * bag of extra dependencies — same shape as `webDistDir` above. Real wiring
   * (src/index.ts) always sets this; most tests that don't exercise /mcp can
   * leave it unset.
   */
  mcp?: boolean;
  /**
   * Test seams for the MCP `explain_decision` tool (src/mcp/tools.ts):
   * fetching an arbitrary plan by id, or the latest/nearest-to-a-time
   * decision row, isn't part of ReposLike above, so production wiring
   * (src/index.ts) leaves these unset and the MCP layer's own DB-backed
   * defaults (src/mcp/queries.ts) are used instead. Tests that exercise
   * explain_decision through the HTTP layer (app.request()) can set these to
   * avoid needing a live DB.
   */
  planById?: (id: number) => Promise<PlanWithSlots | null>;
  latestDecision?: () => Promise<DecisionRow | null>;
  nearestDecision?: (target: Date) => Promise<DecisionRow | null>;
}
