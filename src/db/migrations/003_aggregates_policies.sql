-- migrate:no-transaction
-- Continuous aggregate + compression/retention policies.
-- These use Timescale APIs (CREATE MATERIALIZED VIEW ... WITH (timescaledb.continuous),
-- add_compression_policy, add_retention_policy) that cannot run inside a transaction
-- block, so this file is applied by the runner without wrapping BEGIN/COMMIT.

-- telemetry_5m: 5-minute rollup of raw telemetry, used by forecasting + UI charts.
CREATE MATERIALIZED VIEW IF NOT EXISTS telemetry_5m
WITH (timescaledb.continuous) AS
-- Aggregates are cast to double precision (rather than left as numeric) so the
-- `postgres` driver decodes them as JS numbers automatically.
SELECT
  time_bucket('5 minutes', time) AS bucket,
  avg(pv_power_w)::double precision AS pv_power_w_avg,
  avg(battery_power_w)::double precision AS battery_power_w_avg,
  avg(grid_power_w)::double precision AS grid_power_w_avg,
  avg(load_power_w)::double precision AS load_power_w_avg,
  avg(battery_soc_pct)::double precision AS battery_soc_pct_avg,
  last(battery_soc_pct, time) AS battery_soc_pct_last,
  (avg(pv_power_w) / 12.0)::double precision AS pv_energy_wh,
  (avg(battery_power_w) / 12.0)::double precision AS battery_energy_wh,
  (avg(grid_power_w) / 12.0)::double precision AS grid_energy_wh,
  (avg(load_power_w) / 12.0)::double precision AS load_energy_wh
FROM telemetry
GROUP BY bucket
WITH NO DATA;

-- Refresh recent buckets every 5 minutes, with a ~10 minute lag so slow-arriving
-- samples for a bucket have landed before it is materialized.
SELECT add_continuous_aggregate_policy(
  'telemetry_5m',
  start_offset => INTERVAL '3 days',
  end_offset => INTERVAL '10 minutes',
  schedule_interval => INTERVAL '5 minutes',
  if_not_exists => TRUE
);

-- Compress raw telemetry chunks older than 7 days.
ALTER TABLE telemetry SET (
  timescaledb.compress,
  timescaledb.compress_orderby = 'time DESC'
);

SELECT add_compression_policy('telemetry', INTERVAL '7 days', if_not_exists => TRUE);

-- Retention: 2 years for telemetry, decisions, forecasts, price_forecast_snapshots.
SELECT add_retention_policy('telemetry', INTERVAL '2 years', if_not_exists => TRUE);
SELECT add_retention_policy('decisions', INTERVAL '2 years', if_not_exists => TRUE);
SELECT add_retention_policy('forecasts', INTERVAL '2 years', if_not_exists => TRUE);
SELECT add_retention_policy('price_forecast_snapshots', INTERVAL '2 years', if_not_exists => TRUE);
