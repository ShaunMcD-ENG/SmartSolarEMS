import { describe, expect, test } from "bun:test";
import type { Telemetry5mRow } from "../db/repositories";
import { buildLoadProfile, buildSolarProfile, clearnessFactor, slotInfo } from "./profiles";

/** Minimal Telemetry5mRow with every other channel null, for profile-building tests. */
function row(bucket: Date, opts: { load?: number | null; pv?: number | null } = {}): Telemetry5mRow {
  return {
    bucket,
    pv_power_w_avg: null,
    battery_power_w_avg: null,
    grid_power_w_avg: null,
    load_power_w_avg: null,
    battery_soc_pct_avg: null,
    battery_soc_pct_last: null,
    pv_energy_wh: opts.pv ?? null,
    battery_energy_wh: null,
    grid_energy_wh: null,
    load_energy_wh: opts.load ?? null,
  };
}

describe("slotInfo", () => {
  test("computes slot-of-day and dayType in UTC for a weekday and a weekend date", () => {
    // 2024-01-01 is a Monday, 2024-01-06 is a Saturday; both at 08:00 UTC = slot 96.
    expect(slotInfo(new Date("2024-01-01T08:00:00Z"), "UTC")).toEqual({
      slotOfDay: 96,
      dayType: "weekday",
      dateKey: "2024-01-01",
    });
    expect(slotInfo(new Date("2024-01-06T08:00:00Z"), "UTC")).toEqual({
      slotOfDay: 96,
      dayType: "weekend",
      dateKey: "2024-01-06",
    });
  });

  test("midnight UTC maps to slot 0, not slot 24 (Intl h24 quirk guard)", () => {
    expect(slotInfo(new Date("2024-01-01T00:00:00Z"), "UTC").slotOfDay).toBe(0);
  });

  describe("Australia/Sydney DST 'fall back' (2026-04-05, AEDT -> AEST)", () => {
    // Confirmed via Intl directly: offset is +11 (AEDT) through 2026-04-04T15:55Z,
    // then steps back to +10 (AEST) at 2026-04-04T16:00Z. Local wall-clock time
    // 02:00-02:55 on 2026-04-05 therefore occurs twice (once under each offset).
    test("slot-of-day progresses correctly up to the transition", () => {
      // 2026-04-04T14:55Z = 01:55 AEDT local -> slot 23.
      expect(slotInfo(new Date("2026-04-04T14:55:00Z"), "Australia/Sydney")).toEqual({
        slotOfDay: 23,
        dayType: "weekend", // 2026-04-05 is a Sunday
        dateKey: "2026-04-05",
      });
      // 2026-04-04T15:00Z = 02:00 AEDT local -> slot 24.
      expect(slotInfo(new Date("2026-04-04T15:00:00Z"), "Australia/Sydney")).toEqual({
        slotOfDay: 24,
        dayType: "weekend",
        dateKey: "2026-04-05",
      });
    });

    test("the repeated local hour (02:00 AEST, after clocks fall back) maps to the same SlotInfo as its AEDT occurrence", () => {
      const aedtOccurrence = slotInfo(new Date("2026-04-04T15:00:00Z"), "Australia/Sydney");
      const aestOccurrence = slotInfo(new Date("2026-04-04T16:00:00Z"), "Australia/Sydney");
      // Documented, accepted behaviour: both map to local 02:00 on 2026-04-05.
      expect(aestOccurrence).toEqual(aedtOccurrence);
    });

    test("slot-of-day resumes progressing normally once the transition is past", () => {
      // 2026-04-04T17:00Z = 03:00 AEST local -> slot 36.
      expect(slotInfo(new Date("2026-04-04T17:00:00Z"), "Australia/Sydney")).toEqual({
        slotOfDay: 36,
        dayType: "weekend",
        dateKey: "2026-04-05",
      });
    });
  });
});

describe("buildLoadProfile", () => {
  const slot96 = new Date("2024-01-01T08:00:00Z"); // Monday 08:00 UTC

  test("EWMA-folds oldest -> newest so the most recent day is weighted highest", () => {
    const rows = [
      row(new Date("2024-01-01T08:00:00Z"), { load: 100 }), // Mon
      row(new Date("2024-01-02T08:00:00Z"), { load: 200 }), // Tue
      row(new Date("2024-01-03T08:00:00Z"), { load: 300 }), // Wed
    ];
    const profile = buildLoadProfile(rows, "UTC");
    // day1: 100 (first obs). day2: 0.2*200 + 0.8*100 = 120. day3: 0.2*300 + 0.8*120 = 156.
    expect(profile.weekday[96]).toBeCloseTo(156, 6);
  });

  test("keeps weekday and weekend observations in separate buckets", () => {
    const rows = [
      row(new Date("2024-01-01T08:00:00Z"), { load: 100 }), // Mon (weekday)
      row(new Date("2024-01-06T08:00:00Z"), { load: 500 }), // Sat (weekend)
    ];
    const profile = buildLoadProfile(rows, "UTC");
    expect(profile.weekday[96]).toBeCloseTo(100, 6);
    expect(profile.weekend[96]).toBeCloseTo(500, 6);
  });

  test("a day missing the slot is skipped (previous EWMA value carries forward, not dragged to zero)", () => {
    const rows = [
      row(new Date("2024-01-01T08:00:00Z"), { load: 100 }), // Mon, has slot 96
      // 2024-01-02: no row at slot 96 at all (simulates a telemetry gap)
      row(new Date("2024-01-03T08:00:00Z"), { load: 300 }), // Wed, has slot 96
    ];
    const profile = buildLoadProfile(rows, "UTC");
    // day1: 100. day2: gap, unchanged (100). day3: 0.2*300 + 0.8*100 = 140.
    expect(profile.weekday[96]).toBeCloseTo(140, 6);
  });

  test("slots never observed are null (caller decides the cold-start fallback)", () => {
    const rows = [row(slot96, { load: 100 })];
    const profile = buildLoadProfile(rows, "UTC");
    expect(profile.weekday[0]).toBeNull();
    expect(profile.weekend[96]).toBeNull();
  });

  test("rows with a null load_energy_wh are ignored", () => {
    const rows = [row(slot96, { load: null }), row(new Date("2024-01-02T08:00:00Z"), { load: 50 })];
    const profile = buildLoadProfile(rows, "UTC");
    expect(profile.weekday[96]).toBeCloseTo(50, 6);
  });

  test("accepts an explicit alpha override", () => {
    const rows = [
      row(new Date("2024-01-01T08:00:00Z"), { load: 100 }),
      row(new Date("2024-01-02T08:00:00Z"), { load: 200 }),
    ];
    const profile = buildLoadProfile(rows, "UTC", 0.5);
    expect(profile.weekday[96]).toBeCloseTo(0.5 * 200 + 0.5 * 100, 6);
  });
});

describe("buildSolarProfile", () => {
  test("computes the 90th percentile (linear interpolation) per slot-of-day", () => {
    const noon = 144; // slot at 12:00 UTC
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const rows = values.map((pv, i) => row(new Date(`2024-01-${String(i + 1).padStart(2, "0")}T12:00:00Z`), { pv }));
    const profile = buildSolarProfile(rows, "UTC");
    // sorted = [10..100], idx = 0.9*9 = 8.1 -> interpolate between sorted[8]=90 and sorted[9]=100 -> 91.
    expect(profile[noon]).toBeCloseTo(91, 6);
  });

  test("slots with no observations at all are 0 (never-observed daylight)", () => {
    const rows = [row(new Date("2024-01-01T12:00:00Z"), { pv: 500 })];
    const profile = buildSolarProfile(rows, "UTC");
    expect(profile[0]).toBe(0); // midnight slot, never observed
  });

  test("rows with a null pv_energy_wh are ignored", () => {
    const rows = [row(new Date("2024-01-01T12:00:00Z"), { pv: null })];
    const profile = buildSolarProfile(rows, "UTC");
    expect(profile[144]).toBe(0);
  });

  test("accepts an explicit percentile override", () => {
    const values = [10, 20, 30, 40, 50];
    const rows = values.map((pv, i) => row(new Date(`2024-01-0${i + 1}T06:00:00Z`), { pv }));
    const profile = buildSolarProfile(rows, "UTC", 0.5); // median
    expect(profile[72]).toBeCloseTo(30, 6);
  });
});

describe("clearnessFactor", () => {
  test("returns 1 (neutral) when fewer than 30 minutes of daylight samples are available", () => {
    expect(clearnessFactor(1000, 500, 25)).toBe(1);
    expect(clearnessFactor(0, 0, 0)).toBe(1);
  });

  test("returns 1 when there is no predicted solar to compare against (night / zero profile)", () => {
    expect(clearnessFactor(100, 0, 60)).toBe(1);
  });

  test("passes through an in-range ratio unclamped", () => {
    expect(clearnessFactor(80, 100, 60)).toBeCloseTo(0.8, 6);
  });

  test("clamps a high ratio (overcast profile beaten by unusually clear conditions) to CLEARNESS_MAX", () => {
    expect(clearnessFactor(250, 100, 60)).toBe(1.3);
  });

  test("clamps a low ratio (heavy cloud) to CLEARNESS_MIN", () => {
    expect(clearnessFactor(1, 100, 60)).toBe(0.1);
  });
});
