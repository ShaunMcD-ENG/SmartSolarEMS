import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Sql } from "./client";
import { getDb, closeDb } from "./client";
import { createLogger } from "../lib/logger";

const log = createLogger("migrate");

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

/**
 * First-line directive a migration file can use to opt out of the runner's
 * default transaction wrapping. Required for statements that Postgres/Timescale
 * refuse to run inside a transaction block (e.g. CREATE MATERIALIZED VIEW ...
 * WITH (timescaledb.continuous), add_compression_policy, add_retention_policy).
 * The migration is still recorded in schema_migrations once it succeeds.
 */
const NO_TRANSACTION_DIRECTIVE = "-- migrate:no-transaction";

function requiresNoTransaction(contents: string): boolean {
  return contents.trimStart().startsWith(NO_TRANSACTION_DIRECTIVE);
}

interface Migration {
  name: string;
  path: string;
}

async function listMigrations(): Promise<Migration[]> {
  let entries: string[];
  try {
    entries = await readdir(MIGRATIONS_DIR);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  return entries
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => {
      const numA = Number.parseInt(a, 10);
      const numB = Number.parseInt(b, 10);
      if (Number.isNaN(numA) || Number.isNaN(numB)) return a.localeCompare(b);
      return numA - numB;
    })
    .map((name) => ({ name, path: join(MIGRATIONS_DIR, name) }));
}

/** Ensures the schema_migrations tracking table exists. */
async function ensureMigrationsTable(sql: Sql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
}

/**
 * Applies every migration under src/db/migrations that has not yet been
 * recorded in schema_migrations, in ascending numeric-prefix order. Each
 * migration runs inside its own transaction, unless its first line is the
 * NO_TRANSACTION_DIRECTIVE, in which case it is applied unwrapped.
 */
export async function runMigrations(sql: Sql): Promise<string[]> {
  await ensureMigrationsTable(sql);

  const applied = new Set(
    (await sql<{ name: string }[]>`SELECT name FROM schema_migrations`).map((row) => row.name),
  );

  const migrations = await listMigrations();
  const pending = migrations.filter((m) => !applied.has(m.name));

  if (pending.length === 0) {
    log.info("no pending migrations");
    return [];
  }

  const ranNames: string[] = [];
  for (const migration of pending) {
    const contents = await readFile(migration.path, "utf8");
    log.info(`applying migration ${migration.name}`);
    if (requiresNoTransaction(contents)) {
      await sql.unsafe(contents);
      await sql`INSERT INTO schema_migrations (name) VALUES (${migration.name})`;
    } else {
      await sql.begin(async (tx) => {
        await tx.unsafe(contents);
        await tx`INSERT INTO schema_migrations (name) VALUES (${migration.name})`;
      });
    }
    ranNames.push(migration.name);
  }

  log.info(`applied ${ranNames.length} migration(s)`, { migrations: ranNames });
  return ranNames;
}

if (import.meta.main) {
  const sql = getDb();
  try {
    await runMigrations(sql);
  } catch (err) {
    log.error("migration run failed", { error: String(err) });
    process.exitCode = 1;
  } finally {
    await closeDb();
  }
}
