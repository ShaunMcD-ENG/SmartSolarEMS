-- Initial migration: enable TimescaleDB.
-- Note: the `schema_migrations` tracking table itself is created and managed
-- by the migration runner (src/db/migrate.ts), not by a migration file.

CREATE EXTENSION IF NOT EXISTS timescaledb;
