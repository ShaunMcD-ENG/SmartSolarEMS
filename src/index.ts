import { PricePoller } from "./amber/poller";
import { env } from "./config/env";
import type { SettingsKey } from "./config/settings";
import { SettingsService } from "./config/settings";
import { closeDb, getDb } from "./db/client";
import { runMigrations } from "./db/migrate";
import { insertOverride, listOverrides, relevantOverrides, setOverrideStatus } from "./db/overrides";
import {
  decisionsBetween,
  insertDecision,
  insertForecasts,
  insertPlan,
  latestPlan,
  latestTelemetry,
  pricesBetween,
  telemetry5mBetween,
  telemetryBetween,
} from "./db/repositories";
import { ExecutorService, type ExecutorModbusClient } from "./executor/service";
import { ForecastService } from "./forecast/service";
import { createLogger } from "./lib/logger";
import { SigenergyClient } from "./modbus/client";
import { TelemetryPoller } from "./modbus/poller";
import { PlannerService } from "./planner/service";
import { createSqlSessionStore } from "./server/auth";
import { createApp } from "./server/app";
import type { AppDeps, PollerStatusLike } from "./server/types";

const log = createLogger("index");

/** How often the collector supervisor re-checks settings for newly-configured (or changed) collectors. */
const RECONCILE_INTERVAL_MS = 60_000;
/** How often ForecastService rebuilds its load/solar profiles from telemetry history. */
const FORECAST_REFRESH_INTERVAL_MS = 60 * 60_000;

const NOT_CONFIGURED_STATUS: PollerStatusLike = { running: false, lastSuccess: null, lastError: null };

interface CollectorState {
  modbusClient: SigenergyClient | null;
  modbusPoller: TelemetryPoller | null;
  /** host|port|plantUnitId|inverterUnitId of the currently-running modbus client, to detect config changes. */
  modbusFingerprint: string | null;
  amberPoller: PricePoller | null;
  amberStarted: boolean;
}

function sigenergyFingerprint(cfg: {
  host: string;
  port: number;
  plantUnitId: number;
  inverterUnitId: number;
}): string {
  return `${cfg.host}|${cfg.port}|${cfg.plantUnitId}|${cfg.inverterUnitId}`;
}

/**
 * Starts (or restarts, on host/port/unit-id change) the Modbus telemetry
 * poller once `sigenergy.host` is non-empty. A stale SigenergyClient would
 * otherwise keep talking to an old host after a settings change, so unlike
 * Amber below, this one does need active reconciliation.
 */
async function reconcileModbus(settings: SettingsService, state: CollectorState): Promise<void> {
  const cfg = await settings.get("sigenergy").catch((err: unknown) => {
    log.warn("collector supervisor: failed to read sigenergy settings", { error: String(err) });
    return null;
  });
  const configured = !!cfg && cfg.host.trim().length > 0;

  if (!configured) {
    if (state.modbusPoller) {
      log.info("sigenergy config cleared; stopping telemetry poller");
      state.modbusPoller.stop();
      state.modbusClient?.disconnect();
      state.modbusPoller = null;
      state.modbusClient = null;
      state.modbusFingerprint = null;
    }
    return;
  }

  const fingerprint = sigenergyFingerprint(cfg);
  if (state.modbusPoller && state.modbusFingerprint === fingerprint) return;

  if (state.modbusPoller) {
    log.info("sigenergy config changed; restarting telemetry poller", { host: cfg.host, port: cfg.port });
    state.modbusPoller.stop();
    state.modbusClient?.disconnect();
  }

  const client = new SigenergyClient(cfg);
  try {
    await client.connect();
  } catch (err) {
    log.warn("initial sigenergy connect failed; client will keep retrying in the background", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const poller = new TelemetryPoller(client, settings);
  poller.start();

  state.modbusClient = client;
  state.modbusPoller = poller;
  state.modbusFingerprint = fingerprint;
  log.info("telemetry poller started", { host: cfg.host, port: cfg.port });
}

/**
 * Starts the Amber price poller once `amber.apiToken`/`siteId` are both set.
 * Unlike Modbus, PricePoller re-reads its settings fresh every cycle
 * internally (see src/amber/poller.ts runCycle()), so once started it never
 * needs to be recreated on a token/siteId change — only the initial start
 * needs supervising here.
 */
async function reconcileAmber(settings: SettingsService, state: CollectorState): Promise<void> {
  if (state.amberStarted) return;

  const cfg = await settings.get("amber").catch((err: unknown) => {
    log.warn("collector supervisor: failed to read amber settings", { error: String(err) });
    return null;
  });
  const configured = !!cfg && cfg.apiToken.trim().length > 0 && cfg.siteId.trim().length > 0;
  if (!configured) return;

  const poller = new PricePoller(settings);
  poller.start();
  state.amberPoller = poller;
  state.amberStarted = true;
  log.info("price poller started");
}

interface CollectorSupervisor {
  pollers: AppDeps["pollers"];
  /** Current shared SigenergyClient, if sigenergy is configured — used by the executor so it never opens a second TCP connection. */
  getModbusClient(): SigenergyClient | null;
  stop(): Promise<void>;
}

/**
 * Brings the Modbus/Amber collectors up as soon as their settings are
 * configured, re-checking every RECONCILE_INTERVAL_MS so saving settings via
 * the web UI takes effect without restarting the process.
 */
function startCollectorSupervisor(settings: SettingsService): CollectorSupervisor {
  const state: CollectorState = {
    modbusClient: null,
    modbusPoller: null,
    modbusFingerprint: null,
    amberPoller: null,
    amberStarted: false,
  };

  const tick = async (): Promise<void> => {
    await reconcileModbus(settings, state);
    await reconcileAmber(settings, state);
  };

  void tick();
  const timer = setInterval(() => void tick(), RECONCILE_INTERVAL_MS);

  return {
    pollers: {
      modbus: { status: () => state.modbusPoller?.status() ?? NOT_CONFIGURED_STATUS },
      amber: { status: () => state.amberPoller?.status() ?? NOT_CONFIGURED_STATUS },
    },
    getModbusClient: () => state.modbusClient,
    async stop() {
      clearInterval(timer);
      state.modbusPoller?.stop();
      state.modbusClient?.disconnect();
      state.amberPoller?.stop();
    },
  };
}

/**
 * Delegates to whatever SigenergyClient the collector supervisor currently
 * holds (it can be replaced on a host/port/unit-id settings change) so the
 * executor shares the poller's single TCP connection rather than opening its
 * own. Throws if sigenergy isn't configured yet — callers (ExecutorService,
 * active-mode-only) already treat control-write failures as safety events.
 */
function makeExecutorClient(supervisor: CollectorSupervisor): ExecutorModbusClient {
  function requireClient(): SigenergyClient {
    const client = supervisor.getModbusClient();
    if (!client) throw new Error("sigenergy is not configured (no shared Modbus client available)");
    return client;
  }
  return {
    readSocLimits: () => requireClient().readSocLimits(),
    enableRemoteEms: (on) => requireClient().enableRemoteEms(on),
    setControlMode: (mode) => requireClient().setControlMode(mode),
    setChargePowerW: (watts) => requireClient().setChargePowerW(watts),
    setDischargePowerW: (watts) => requireClient().setDischargePowerW(watts),
  };
}

async function main(): Promise<void> {
  const config = env();

  log.info("=================================");
  log.info("        SmartSolarEMS");
  log.info("=================================");

  const sql = getDb();
  await runMigrations(sql);

  const settings = new SettingsService(sql);
  const sessions = createSqlSessionStore(sql);

  const supervisor = startCollectorSupervisor(settings);

  // ForecastService wants `get(key: string): Promise<unknown>` (any key, see
  // src/forecast/service.ts ForecastSettingsSource) whereas SettingsService's
  // get<K extends SettingsKey> is narrower than that at the type level, so it
  // needs an explicit adapter rather than being passed directly (unlike the
  // single-fixed-key poller settings sources below).
  const forecastService = new ForecastService({
    fetchTelemetry5m: (from, to) => telemetry5mBetween(from, to, sql),
    insertForecasts: (rows) => insertForecasts(rows, sql),
    settings: { get: (key: string) => settings.get(key as SettingsKey) },
  });
  await forecastService.refreshProfiles();
  const forecastRefreshTimer = setInterval(() => void forecastService.refreshProfiles(), FORECAST_REFRESH_INTERVAL_MS);

  const plannerService = new PlannerService({
    pricesBetween: (from, to, channel) => pricesBetween(from, to, channel, sql),
    forecast: (now, horizonSlots) => forecastService.forecast(now, horizonSlots),
    latestTelemetry: () => latestTelemetry(sql),
    settings,
    relevantOverrides: (at) => relevantOverrides(at, sql),
    setOverrideStatus: (id, status) => setOverrideStatus(id, status, sql),
    insertPlan: (plan, slots) => insertPlan(plan, slots, sql),
  });

  // Executor shares the collector supervisor's single SigenergyClient (see
  // makeExecutorClient) rather than opening a second TCP connection. It self-
  // selects shadow/active per tick from mode.shadow, so it's always started.
  const executor = new ExecutorService({
    runOnce: (now) => plannerService.runOnce(now),
    client: makeExecutorClient(supervisor),
    settings,
    insertDecision: (row) => insertDecision(row, sql),
    latestTelemetry: () => latestTelemetry(sql),
    tz: config.TZ,
  });
  executor.start();

  const deps: AppDeps = {
    settings,
    sessions,
    pollers: supervisor.pollers,
    forecastService,
    repos: {
      latestTelemetry: () => latestTelemetry(sql),
      telemetryBetween: (from, to) => telemetryBetween(from, to, sql),
      telemetry5mBetween: (from, to) => telemetry5mBetween(from, to, sql),
      pricesBetween: (from, to, channel) => pricesBetween(from, to, channel, sql),
      latestPlan: () => latestPlan(sql),
      decisionsBetween: (from, to) => decisionsBetween(from, to, sql),
    },
    overridesRepo: {
      insertOverride: (input) => insertOverride(input, sql),
      listOverrides: (opts) => listOverrides(opts, sql),
      setOverrideStatus: (id, status) => setOverrideStatus(id, status, sql),
    },
    executor: { status: () => executor.status() },
  };

  const app = createApp(deps);
  const server = Bun.serve({ port: config.PORT, fetch: app.fetch });
  log.info(`listening on port ${config.PORT}`, { tz: config.TZ });

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`received ${signal}, shutting down`);
    clearInterval(forecastRefreshTimer);
    // Executor stops first so, in active mode, it can hand control back to
    // the inverter (disable remote EMS) while the shared Modbus client and
    // DB are still up.
    await executor.stop();
    await supervisor.stop();
    server.stop();
    await closeDb();
    process.exit(0);
  }
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch(async (err) => {
  log.error("fatal error during startup", { error: String(err) });
  await closeDb();
  process.exit(1);
});
