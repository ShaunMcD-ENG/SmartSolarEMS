import { afterEach, describe, expect, test } from "bun:test";
import { getDb } from "../db/client";
import { isDbAvailable } from "../db/test-helpers";
import { SettingsService } from "./settings";

const sql = getDb();
const dbAvailable = await isDbAvailable(sql);

/** Keys this suite writes to; deleted after every test to leave the DB as found. */
const TEST_KEYS = ["battery", "amber", "goals", "admin_password_hash"] as const;

async function cleanup(): Promise<void> {
  for (const key of TEST_KEYS) {
    await sql`DELETE FROM settings WHERE key = ${key}`;
  }
}

describe.skipIf(!dbAvailable)("SettingsService", () => {
  afterEach(cleanup);

  test("get() returns the documented default when a key has never been set", async () => {
    await cleanup();
    const settings = new SettingsService(sql);

    expect(await settings.get("battery")).toEqual({
      capacityWh: 10000,
      usableMinSocPct: 10,
      maxChargeW: 5000,
      maxDischargeW: 5000,
      roundTripEfficiency: 0.9,
    });
    expect(await settings.get("mode")).toEqual({ shadow: true });
    expect(await settings.get("goals")).toEqual({
      maxCyclesPerDay: 1,
      socTargets: [],
      minCommandWindowMin: 5,
    });
  });

  test("admin_password_hash resolves to null when unset (no default)", async () => {
    await cleanup();
    const settings = new SettingsService(sql);
    expect(await settings.get("admin_password_hash")).toBeNull();
  });

  test("set() then get() roundtrips a validated value and invalidates the cache", async () => {
    await cleanup();
    const settings = new SettingsService(sql);

    const custom = {
      capacityWh: 15000,
      usableMinSocPct: 15,
      maxChargeW: 6000,
      maxDischargeW: 6000,
      roundTripEfficiency: 0.95,
    };
    await settings.set("battery", custom);
    expect(await settings.get("battery")).toEqual(custom);

    // A second, independent instance reading from the DB sees the same value.
    const settings2 = new SettingsService(sql);
    expect(await settings2.get("battery")).toEqual(custom);
  });

  test("set() rejects a value that fails validation", async () => {
    await cleanup();
    const settings = new SettingsService(sql);
    await expect(
      settings.set("battery", {
        capacityWh: -5,
        usableMinSocPct: 10,
        maxChargeW: 5000,
        maxDischargeW: 5000,
        roundTripEfficiency: 0.9,
      }),
    ).rejects.toThrow();
  });

  test("isFirstBoot() reflects presence of admin_password_hash", async () => {
    await cleanup();
    const settings = new SettingsService(sql);

    expect(await settings.isFirstBoot()).toBe(true);
    await settings.set("admin_password_hash", "argon2id$test-hash-value");
    expect(await settings.isFirstBoot()).toBe(false);
  });

  test("getAll() includes defaults and explicitly-set values together", async () => {
    await cleanup();
    const settings = new SettingsService(sql);
    await settings.set("goals", { maxCyclesPerDay: 2, socTargets: [], minCommandWindowMin: 5 });

    const all = await settings.getAll();
    expect(all.goals?.maxCyclesPerDay).toBe(2);
    expect(all.mode).toEqual({ shadow: true });
    expect(all.admin_password_hash).toBeNull();
  });

  test("never logs secret values (amber apiToken, admin_password_hash)", async () => {
    await cleanup();
    const settings = new SettingsService(sql);

    const logged: unknown[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logged.push(args);
    };

    try {
      await settings.set("amber", {
        apiToken: "SECRET_AMBER_TOKEN_abc123",
        siteId: "site-1",
        pollIntervalMs: 300000,
      });
      await settings.set("admin_password_hash", "SECRET_PASSWORD_HASH_xyz789");
    } finally {
      console.log = originalLog;
    }

    const serialized = JSON.stringify(logged);
    expect(serialized).not.toContain("SECRET_AMBER_TOKEN_abc123");
    expect(serialized).not.toContain("SECRET_PASSWORD_HASH_xyz789");
    expect(serialized).toContain("[redacted]");
  });
});
