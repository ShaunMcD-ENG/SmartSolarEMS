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

export async function insertOverride(input: OverrideInput, sql: Sql = getDb()): Promise<OverrideRow> {
  const [row] = await sql<OverrideRow[]>`
    INSERT INTO overrides (
      start_time, end_time, action, energy_wh, power_w, override_demand_window, note
    ) VALUES (
      ${input.start_time}, ${input.end_time}, ${input.action}, ${input.energy_wh},
      ${input.power_w}, ${input.override_demand_window}, ${input.note}
    )
    RETURNING *
  `;
  if (!row) throw new Error("override insert returned no row");
  return row;
}

export async function listOverrides(
  opts: { statuses?: OverrideStatus[]; limit?: number } = {},
  sql: Sql = getDb(),
): Promise<OverrideRow[]> {
  const statuses = opts.statuses ?? null;
  return sql<OverrideRow[]>`
    SELECT * FROM overrides
    ${statuses ? sql`WHERE status = ANY(${statuses})` : sql``}
    ORDER BY start_time DESC
    LIMIT ${opts.limit ?? 100}
  `;
}

/**
 * Overrides that can influence planning at/after `at`: pending or active, and not
 * already past their end_time. Energy-target overrides (end_time null) stay relevant
 * until explicitly completed/expired by the planner or executor.
 */
export async function relevantOverrides(at: Date, sql: Sql = getDb()): Promise<OverrideRow[]> {
  return sql<OverrideRow[]>`
    SELECT * FROM overrides
    WHERE status IN ('pending', 'active')
      AND (end_time IS NULL OR end_time > ${at})
    ORDER BY start_time ASC
  `;
}

export async function setOverrideStatus(
  id: number,
  status: OverrideStatus,
  sql: Sql = getDb(),
): Promise<boolean> {
  const result = await sql`UPDATE overrides SET status = ${status} WHERE id = ${id}`;
  return result.count > 0;
}
