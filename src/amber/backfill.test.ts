import { describe, expect, test } from "bun:test";
import type { NormalizedUsage } from "./client";
import { backfillUsage, type UsageSource } from "./backfill";

function makeUsage(overrides: Partial<NormalizedUsage> = {}): NormalizedUsage {
  return {
    type: "Usage",
    channelType: "general",
    channelIdentifier: "E1",
    durationMin: 30,
    intervalStart: new Date("2024-01-01T00:00:00.000Z"),
    kwh: 1,
    cost: 20,
    quality: "billable",
    renewables: 50,
    raw: {},
    ...overrides,
  };
}

describe("backfillUsage", () => {
  test("fetches one day at a time and returns combined normalised rows", async () => {
    const calls: { siteId: string; startDate: string; endDate: string }[] = [];
    const client: UsageSource = {
      getUsage: async (siteId, startDate, endDate) => {
        calls.push({ siteId, startDate, endDate });
        return [makeUsage({ raw: { day: startDate } })];
      },
    };

    const sleepCalls: number[] = [];
    const rows = await backfillUsage(client, "site-1", 3, {
      now: () => new Date("2024-01-10T00:00:00.000Z"),
      sleepFn: async (ms) => {
        sleepCalls.push(ms);
      },
    });

    expect(calls.length).toBe(3);
    // Day-by-day: startDate === endDate for every request.
    for (const call of calls) {
      expect(call.startDate).toBe(call.endDate);
      expect(call.siteId).toBe("site-1");
    }
    expect(calls.map((c) => c.startDate)).toEqual(["2024-01-07", "2024-01-08", "2024-01-09"]);

    expect(rows.length).toBe(3);
    expect(rows.map((r) => (r.raw as { day: string }).day)).toEqual(["2024-01-07", "2024-01-08", "2024-01-09"]);

    // A modest delay between requests, but not after the very last one.
    expect(sleepCalls.length).toBe(2);
    expect(sleepCalls.every((ms) => ms > 0)).toBe(true);
  });

  test("returns an empty array for days <= 0 without calling the client", async () => {
    let called = false;
    const client: UsageSource = {
      getUsage: async () => {
        called = true;
        return [];
      },
    };

    const rows = await backfillUsage(client, "site-1", 0);
    expect(rows).toEqual([]);
    expect(called).toBe(false);
  });

  test("a failing day is logged and skipped; other days still come back", async () => {
    const client: UsageSource = {
      getUsage: async (_siteId, startDate) => {
        if (startDate === "2024-01-08") throw new Error("amber 500");
        return [makeUsage({ raw: { day: startDate } })];
      },
    };

    const rows = await backfillUsage(client, "site-1", 3, {
      now: () => new Date("2024-01-10T00:00:00.000Z"),
      sleepFn: async () => {},
    });

    expect(rows.length).toBe(2);
    expect(rows.map((r) => (r.raw as { day: string }).day)).toEqual(["2024-01-07", "2024-01-09"]);
  });

  test("uses the provided delayMs between requests", async () => {
    const client: UsageSource = { getUsage: async () => [] };
    const sleepCalls: number[] = [];

    await backfillUsage(client, "site-1", 2, {
      now: () => new Date("2024-01-10T00:00:00.000Z"),
      delayMs: 250,
      sleepFn: async (ms) => {
        sleepCalls.push(ms);
      },
    });

    expect(sleepCalls).toEqual([250]);
  });
});
