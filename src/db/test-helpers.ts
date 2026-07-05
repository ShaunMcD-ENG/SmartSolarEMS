import type { Sql } from "./client";

/**
 * Probes the DB with a short timeout so DB-dependent test suites can
 * `describe.skipIf(!(await isDbAvailable(sql)))` and still pass in CI
 * environments where no Postgres instance is running.
 */
export async function isDbAvailable(sql: Sql, timeoutMs = 2000): Promise<boolean> {
  try {
    await Promise.race([
      sql`SELECT 1`,
      new Promise((_resolve, reject) => setTimeout(() => reject(new Error("db probe timeout")), timeoutMs)),
    ]);
    return true;
  } catch {
    return false;
  }
}
