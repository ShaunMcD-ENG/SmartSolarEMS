import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeDb, getDb } from "./client";
import { insertOverride, listOverrides, relevantOverrides, setOverrideStatus } from "./overrides";
import { isDbAvailable } from "./test-helpers";

const sql = getDb();
const dbUp = await isDbAvailable(sql);
const createdIds: number[] = [];

describe.skipIf(!dbUp)("overrides repository", () => {
  beforeAll(async () => {
    const { runMigrations } = await import("./migrate");
    await runMigrations(sql);
  });

  afterAll(async () => {
    if (createdIds.length > 0) {
      await sql`DELETE FROM overrides WHERE id = ANY(${createdIds})`;
    }
    await closeDb();
  });

  test("insert, list, relevant and status transitions", async () => {
    const start = new Date("2030-01-01T01:00:00Z");
    const charge = await insertOverride({
      start_time: start,
      end_time: null,
      action: "charge",
      energy_wh: 9000,
      power_w: null,
      override_demand_window: false,
      note: "charge 9 kWh from 1am",
    });
    createdIds.push(charge.id);
    expect(charge.status).toBe("pending");
    expect(charge.energy_wh).toBe(9000);

    const selfConsume = await insertOverride({
      start_time: new Date("2030-01-01T09:00:00Z"),
      end_time: new Date("2030-01-01T12:00:00Z"),
      action: "self_consume",
      energy_wh: null,
      power_w: null,
      override_demand_window: true,
      note: null,
    });
    createdIds.push(selfConsume.id);

    const relevant = await relevantOverrides(new Date("2030-01-01T00:00:00Z"));
    const ids = relevant.map((o) => o.id);
    expect(ids).toContain(charge.id);
    expect(ids).toContain(selfConsume.id);

    // Past its end_time → no longer relevant.
    const late = await relevantOverrides(new Date("2030-01-01T13:00:00Z"));
    expect(late.map((o) => o.id)).toContain(charge.id); // energy-target: stays until completed
    expect(late.map((o) => o.id)).not.toContain(selfConsume.id);

    expect(await setOverrideStatus(charge.id, "completed")).toBe(true);
    const after = await relevantOverrides(new Date("2030-01-01T00:00:00Z"));
    expect(after.map((o) => o.id)).not.toContain(charge.id);

    const listed = await listOverrides({ statuses: ["completed"] });
    expect(listed.map((o) => o.id)).toContain(charge.id);
  });

  test("rejects unbounded override (no end_time and no energy_wh)", async () => {
    expect(
      insertOverride({
        start_time: new Date("2030-01-02T00:00:00Z"),
        end_time: null,
        action: "discharge",
        energy_wh: null,
        power_w: null,
        override_demand_window: false,
        note: null,
      }),
    ).rejects.toThrow();
  });
});
