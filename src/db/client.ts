import postgres from "postgres";
import { env } from "../config/env";

export type Sql = ReturnType<typeof postgres>;

let instance: Sql | null = null;

/** Returns the shared postgres client, creating it lazily on first use. */
export function getDb(): Sql {
  if (!instance) {
    instance = postgres(env().DATABASE_URL, {
      onnotice: () => {
        // Suppress routine Postgres NOTICE noise (e.g. "extension already exists").
      },
    });
  }
  return instance;
}

/** Closes the shared client, if one was created. Safe to call multiple times. */
export async function closeDb(): Promise<void> {
  if (instance) {
    await instance.end({ timeout: 5 });
    instance = null;
  }
}
