import type { Sql } from "./client";
import { getDb } from "./client";

// Row shapes mirror the DB columns (snake_case) directly, same as repositories.ts.

export type OverrideAction = "charge" | "discharge" | "self_consume" | "idle";
export type OverrideStatus = "pending" | "active" | "completed" | "cancelled" | "expired";

export interface OverrideInput {
  start_time: Date;
  end_time: Date | null;
  action: OverrideAction;
  energy_wh: number | null;
  power_w: number | null;
  override_demand_window: boolean;
  note: string | null;
}

export interface OverrideRow extends OverrideInput {
  id: number;
  created_at: Date;
  status: OverrideStatus;
}

/** Wire shape of an overrides row: bigserial `id` (oid 20) comes back from `postgres` as a string. */
type RawOverrideRow = Omit<OverrideRow, "id"> & { id: string | number };

/**
 * Normalises a raw driver row into OverrideRow: `id` is coerced to a real JS
 * number at this boundary so `OverrideRow.id: number` is genuinely true for
 * every caller (ids are bigserial but far below 2^53). Same convention as
 * `toNum` in src/db/repositories.ts.
 */
function toOverrideRow(row: RawOverrideRow): OverrideRow {
  return { ...row, id: Number(row.id) };
}

export async function insertOverride(input: OverrideInput, sql: Sql = getDb()): Promise<OverrideRow> {
  const [row] = await sql<RawOverrideRow[]>`
    INSERT INTO overrides (
      start_time, end_time, action, energy_wh, power_w, override_demand_window, note
    ) VALUES (
      ${input.start_time}, ${input.end_time}, ${input.action}, ${input.energy_wh},
      ${input.power_w}, ${input.override_demand_window}, ${input.note}
    )
    RETURNING *
  `;
  if (!row) throw new Error("override insert returned no row");
  return toOverrideRow(row);
}

export async function listOverrides(
  opts: { statuses?: OverrideStatus[]; limit?: number } = {},
  sql: Sql = getDb(),
): Promise<OverrideRow[]> {
  const statuses = opts.statuses ?? null;
  const rows = await sql<RawOverrideRow[]>`
    SELECT * FROM overrides
    ${statuses ? sql`WHERE status = ANY(${statuses})` : sql``}
    ORDER BY start_time DESC
    LIMIT ${opts.limit ?? 100}
  `;
  return rows.map(toOverrideRow);
}

/**
 * Overrides that can influence planning at/after `at`: pending or active, and not
 * already past their end_time. Energy-target overrides (end_time null) stay relevant
 * until explicitly completed/expired by the planner or executor.
 */
export async function relevantOverrides(at: Date, sql: Sql = getDb()): Promise<OverrideRow[]> {
  const rows = await sql<RawOverrideRow[]>`
    SELECT * FROM overrides
    WHERE status IN ('pending', 'active')
      AND (end_time IS NULL OR end_time > ${at})
    ORDER BY start_time ASC
  `;
  return rows.map(toOverrideRow);
}

export async function setOverrideStatus(
  id: number,
  status: OverrideStatus,
  sql: Sql = getDb(),
): Promise<boolean> {
  const result = await sql`UPDATE overrides SET status = ${status} WHERE id = ${id}`;
  return result.count > 0;
}
