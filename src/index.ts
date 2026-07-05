import { env } from "./config/env";
import { createLogger } from "./lib/logger";
import { getDb, closeDb } from "./db/client";
import { runMigrations } from "./db/migrate";
import { createApp } from "./server/app";

const log = createLogger("index");

async function main(): Promise<void> {
  const config = env();

  log.info("=================================");
  log.info("        SmartSolarEMS");
  log.info("=================================");

  const sql = getDb();
  await runMigrations(sql);

  const app = createApp();

  Bun.serve({
    port: config.PORT,
    fetch: app.fetch,
  });

  log.info(`listening on port ${config.PORT}`, { tz: config.TZ });
}

main().catch(async (err) => {
  log.error("fatal error during startup", { error: String(err) });
  await closeDb();
  process.exit(1);
});
