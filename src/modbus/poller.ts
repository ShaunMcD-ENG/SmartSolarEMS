import { insertTelemetry } from "../db/repositories";
import { createLogger } from "../lib/logger";
import type { Telemetry } from "./client";

const log = createLogger("modbus-poller");

/** Used when the `sigenergy` setting is unset or unreadable (e.g. DB hiccup mid-poll). */
const FALLBACK_POLL_INTERVAL_MS = 10000;

export interface PollerStatus {
  running: boolean;
  lastSuccess: Date | null;
  lastError: string | null;
  consecutiveFailures: number;
}

/** Minimal client surface the poller needs — lets tests inject a fake without a real transport. */
export interface TelemetrySource {
  readTelemetry(): Promise<Telemetry>;
}

/**
 * Minimal settings surface the poller needs. `SettingsService` (src/config/settings.ts)
 * satisfies this structurally — its generic `get<K extends SettingsKey>()` is
 * assignable to this single-key signature — so real wiring just passes a
 * `SettingsService` instance without needing this type to import it.
 */
export interface PollIntervalSource {
  get(key: "sigenergy"): Promise<{ pollIntervalMs: number } | null>;
}

/**
 * Polls `client.readTelemetry()` on a loop, writing normalised rows via
 * `insertTelemetry`. The poll interval (`sigenergy.pollIntervalMs`) is re-read from
 * settings before every cycle so a settings change takes effect without a restart.
 * Failures are logged and counted but never stop the loop — Modbus/network hiccups
 * are expected and the poller just keeps retrying on the same schedule.
 */
export class TelemetryPoller {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = true;

  private lastSuccess: Date | null = null;
  private lastError: string | null = null;
  private consecutiveFailures = 0;

  constructor(
    private readonly client: TelemetrySource,
    private readonly settings: PollIntervalSource,
    private readonly insert: typeof insertTelemetry = insertTelemetry,
  ) {}

  /** Starts polling immediately, then again every `sigenergy.pollIntervalMs`. Idempotent. */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.timer = setTimeout(() => {
      void this.tick();
    }, 0);
  }

  /** Stops the loop. Any in-flight tick still finishes but no further tick is scheduled. */
  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  status(): PollerStatus {
    return {
      running: !this.stopped,
      lastSuccess: this.lastSuccess,
      lastError: this.lastError,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    try {
      const telemetry = await this.client.readTelemetry();
      await this.insert({
        time: new Date(),
        pv_power_w: telemetry.pvPowerW,
        battery_power_w: telemetry.batteryPowerW,
        battery_soc_pct: telemetry.batterySocPct,
        grid_power_w: telemetry.gridPowerW,
        load_power_w: telemetry.loadPowerW,
        ems_mode: telemetry.emsMode,
        extra: { runningState: telemetry.runningState },
      });
      this.lastSuccess = new Date();
      this.lastError = null;
      this.consecutiveFailures = 0;
    } catch (err) {
      this.consecutiveFailures += 1;
      this.lastError = err instanceof Error ? err.message : String(err);
      log.error("telemetry poll failed", {
        error: this.lastError,
        consecutiveFailures: this.consecutiveFailures,
      });
    } finally {
      if (!this.stopped) {
        const intervalMs = await this.currentIntervalMs();
        if (!this.stopped) {
          this.timer = setTimeout(() => {
            void this.tick();
          }, intervalMs);
        }
      }
    }
  }

  private async currentIntervalMs(): Promise<number> {
    try {
      const sigenergy = await this.settings.get("sigenergy");
      return sigenergy?.pollIntervalMs ?? FALLBACK_POLL_INTERVAL_MS;
    } catch (err) {
      log.warn("failed to read sigenergy.pollIntervalMs, using fallback", {
        error: err instanceof Error ? err.message : String(err),
        fallbackMs: FALLBACK_POLL_INTERVAL_MS,
      });
      return FALLBACK_POLL_INTERVAL_MS;
    }
  }
}
