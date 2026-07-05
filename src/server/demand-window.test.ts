import { describe, expect, test } from "bun:test";
import { ASSUMED_ENERGY_OVERRIDE_MAX_MS, demandWindowConflict, type DemandWindowConfig } from "./demand-window";

const TZ = "Australia/Sydney";

const WINDOW: DemandWindowConfig = { enabled: true, start: "15:00", end: "20:00", bufferMin: 10 };

describe("demandWindowConflict", () => {
  test("never conflicts when demandWindow is disabled", () => {
    const disabled: DemandWindowConfig = { ...WINDOW, enabled: false };
    // AEST (winter, UTC+10): 15:00-20:00 local is 05:00-10:00 UTC.
    const start = new Date("2026-07-05T06:00:00Z");
    const end = new Date("2026-07-05T07:00:00Z");
    expect(demandWindowConflict(disabled, TZ, start, end)).toBe(false);
  });

  test("conflicts when the override sits fully inside the window (AEST, winter)", () => {
    // 2026-07-05 is winter in Sydney: AEST = UTC+10, so 16:00-18:00 local = 06:00-08:00 UTC.
    const start = new Date("2026-07-05T06:00:00Z");
    const end = new Date("2026-07-05T08:00:00Z");
    expect(demandWindowConflict(WINDOW, TZ, start, end)).toBe(true);
  });

  test("does not conflict well outside the window + buffer", () => {
    // 02:00-03:00 local, nowhere near 15:00-20:00 +/- 10 min.
    const start = new Date("2026-07-04T16:00:00Z"); // 2026-07-05T02:00 local
    const end = new Date("2026-07-04T17:00:00Z");
    expect(demandWindowConflict(WINDOW, TZ, start, end)).toBe(false);
  });

  test("conflicts when the override only overlaps the buffer, not the window itself", () => {
    // Window is 15:00-20:00 local with a 10 min buffer either side: 14:50-20:10.
    // An override 14:52-14:58 local overlaps only the pre-window buffer.
    const start = new Date("2026-07-05T04:52:00Z"); // 14:52 local (UTC+10)
    const end = new Date("2026-07-05T04:58:00Z");
    expect(demandWindowConflict(WINDOW, TZ, start, end)).toBe(true);
  });

  test("does not conflict just outside the buffered window", () => {
    // 14:00-14:45 local ends 5 min before the buffered window opens (14:50).
    const start = new Date("2026-07-05T04:00:00Z");
    const end = new Date("2026-07-05T04:45:00Z");
    expect(demandWindowConflict(WINDOW, TZ, start, end)).toBe(false);
  });

  test("open-ended (energy-target) overrides are treated as up to 6h long", () => {
    // Starts 09:00 local, no end_time -> caller assumes start + 6h = 15:00 local,
    // which lands exactly on the window open -> conflict.
    const start = new Date("2026-07-04T23:00:00Z"); // 2026-07-05T09:00 local
    const effectiveEnd = new Date(start.getTime() + ASSUMED_ENERGY_OVERRIDE_MAX_MS);
    expect(demandWindowConflict(WINDOW, TZ, start, effectiveEnd)).toBe(true);
  });

  test("handles a demand window that crosses local midnight", () => {
    const overnight: DemandWindowConfig = { enabled: true, start: "22:00", end: "02:00", bufferMin: 0 };
    // 23:00-23:30 local, well inside the overnight window.
    const start = new Date("2026-07-05T13:00:00Z"); // 23:00 local (UTC+10)
    const end = new Date("2026-07-05T13:30:00Z");
    expect(demandWindowConflict(overnight, TZ, start, end)).toBe(true);
  });

  test("is DST-correct (AEDT, summer UTC+11)", () => {
    // 2026-01-05 is summer in Sydney: AEDT = UTC+11, so 16:00-18:00 local = 05:00-07:00 UTC.
    // (A fixed UTC+10 offset would misplace this by an hour.)
    const start = new Date("2026-01-05T05:00:00Z");
    const end = new Date("2026-01-05T07:00:00Z");
    expect(demandWindowConflict(WINDOW, TZ, start, end)).toBe(true);

    // 21:00-21:30 AEDT local (UTC+11) is comfortably past the buffered window (20:10 local).
    const afterWindow = new Date("2026-01-05T10:00:00Z");
    const afterWindowEnd = new Date("2026-01-05T10:30:00Z");
    expect(demandWindowConflict(WINDOW, TZ, afterWindow, afterWindowEnd)).toBe(false);
  });
});
