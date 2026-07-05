import { describe, expect, test } from "bun:test";
import type { TelemetryRow } from "../db/repositories";
import type { Telemetry } from "./client";
import { TelemetryPoller, type PollIntervalSource, type TelemetrySource } from "./poller";

const SAMPLE_TELEMETRY: Telemetry = {
  pvPowerW: 3000,
  batteryPowerW: 1500,
  batterySocPct: 55.5,
  gridPowerW: -200,
  loadPowerW: 1300,
  emsMode: 7,
  runningState: 1,
};

/** Fake telemetry source whose readTelemetry() behaviour is swappable per test. */
function makeFakeClient(impl: () => Promise<Telemetry>): TelemetrySource {
  return { readTelemetry: () => impl() };
}

/** Mutable settings fake — `pollIntervalMs` can be changed mid-test to simulate a settings edit. */
class FakeSettings implements PollIntervalSource {
  pollIntervalMs: number;
  constructor(initialMs: number) {
    this.pollIntervalMs = initialMs;
  }
  async get(): Promise<{ pollIntervalMs: number }> {
    return { pollIntervalMs: this.pollIntervalMs };
  }
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("TelemetryPoller", () => {
  test("polls immediately and inserts a normalised telemetry row", async () => {
    const client = makeFakeClient(async () => SAMPLE_TELEMETRY);
    const settings = new FakeSettings(1000);
    const inserted: TelemetryRow[] = [];
    const poller = new TelemetryPoller(client, settings, async (row) => {
      inserted.push(row);
    });

    poller.start();
    await wait(15);
    poller.stop();

    expect(inserted.length).toBeGreaterThanOrEqual(1);
    expect(inserted[0]).toMatchObject({
      pv_power_w: 3000,
      battery_power_w: 1500,
      battery_soc_pct: 55.5,
      grid_power_w: -200,
      load_power_w: 1300,
      ems_mode: 7,
      extra: { runningState: 1 },
    });
    expect(poller.status().lastError).toBeNull();
    expect(poller.status().consecutiveFailures).toBe(0);
  });

  test("re-reads the poll interval every cycle so a settings change takes effect without restart", async () => {
    const client = makeFakeClient(async () => SAMPLE_TELEMETRY);
    const settings = new FakeSettings(5);
    const inserted: TelemetryRow[] = [];
    const poller = new TelemetryPoller(client, settings, async (row) => {
      inserted.push(row);
    });

    poller.start();
    await wait(40); // several 5ms cycles
    const countAtFastInterval = inserted.length;
    expect(countAtFastInterval).toBeGreaterThan(2);

    settings.pollIntervalMs = 100000; // effectively "stop polling for a long time"
    const countRightAfterChange = inserted.length;
    await wait(40);
    poller.stop();

    // Once the long interval takes effect, no further ticks should have landed.
    expect(inserted.length).toBeLessThanOrEqual(countRightAfterChange + 1);
  });

  test("counts consecutive failures and resets the count on the next success", async () => {
    let shouldFail = true;
    let calls = 0;
    const client = makeFakeClient(async () => {
      calls += 1;
      if (shouldFail) throw new Error("connection refused");
      return SAMPLE_TELEMETRY;
    });
    const settings = new FakeSettings(5);
    const poller = new TelemetryPoller(client, settings, async () => {});

    poller.start();
    await wait(25);
    expect(poller.status().consecutiveFailures).toBeGreaterThan(0);
    expect(poller.status().lastError).toBe("connection refused");
    expect(poller.status().lastSuccess).toBeNull();

    shouldFail = false;
    await wait(15);
    poller.stop();

    expect(poller.status().consecutiveFailures).toBe(0);
    expect(poller.status().lastError).toBeNull();
    expect(poller.status().lastSuccess).not.toBeNull();
    expect(calls).toBeGreaterThan(1);
  });

  test("stop() halts further polling", async () => {
    const client = makeFakeClient(async () => SAMPLE_TELEMETRY);
    const settings = new FakeSettings(5);
    const inserted: TelemetryRow[] = [];
    const poller = new TelemetryPoller(client, settings, async (row) => {
      inserted.push(row);
    });

    poller.start();
    await wait(15);
    poller.stop();
    const countAtStop = inserted.length;
    expect(poller.status().running).toBe(false);

    await wait(30);
    expect(inserted.length).toBe(countAtStop);
  });

  test("start() is idempotent — calling it twice does not create a second polling loop", async () => {
    const client = makeFakeClient(async () => SAMPLE_TELEMETRY);
    const settings = new FakeSettings(20);
    const inserted: TelemetryRow[] = [];
    const poller = new TelemetryPoller(client, settings, async (row) => {
      inserted.push(row);
    });

    poller.start();
    poller.start();
    await wait(15);
    poller.stop();

    // Only one immediate tick should have fired, not two.
    expect(inserted.length).toBe(1);
  });
});
