-- Core application schema: settings, telemetry, prices, forecasts, plans, decisions, sessions.
-- See design/db-schema.md for the authoritative shape/rationale.

-- settings: single source of runtime configuration (admin-authed UI).
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- telemetry: raw Modbus poll samples, hypertable chunked by day.
CREATE TABLE IF NOT EXISTS telemetry (
  time TIMESTAMPTZ NOT NULL,
  pv_power_w INT,
  battery_power_w INT,       -- +charge / -discharge
  battery_soc_pct REAL,
  grid_power_w INT,          -- +import / -export
  load_power_w INT,
  ems_mode SMALLINT,
  extra JSONB,               -- raw/rare registers
  PRIMARY KEY (time)
);

SELECT create_hypertable(
  'telemetry', 'time',
  chunk_time_interval => INTERVAL '1 day',
  if_not_exists => TRUE
);

-- prices: latest known value per interval, upserted on each Amber poll.
CREATE TABLE IF NOT EXISTS prices (
  interval_start TIMESTAMPTZ NOT NULL,
  channel TEXT NOT NULL,               -- 'general' | 'feedIn' | 'controlledLoad'
  per_kwh REAL NOT NULL,               -- normalised: buy = cost you pay; sell = cents you EARN
  spot_per_kwh REAL,
  renewables REAL,
  spike_status TEXT,
  interval_type TEXT NOT NULL,         -- 'forecast' | 'current' | 'actual'
  estimate BOOLEAN,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (interval_start, channel)
);

SELECT create_hypertable(
  'prices', 'interval_start',
  chunk_time_interval => INTERVAL '7 days',
  if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS idx_prices_interval_start ON prices (interval_start);

-- price_forecast_snapshots: full forecast payload each poll, for forecast-accuracy scoring.
CREATE TABLE IF NOT EXISTS price_forecast_snapshots (
  fetched_at TIMESTAMPTZ NOT NULL,
  channel TEXT NOT NULL,
  payload JSONB NOT NULL,
  PRIMARY KEY (fetched_at, channel)
);

SELECT create_hypertable(
  'price_forecast_snapshots', 'fetched_at',
  chunk_time_interval => INTERVAL '7 days',
  if_not_exists => TRUE
);

-- forecasts: our own load/solar predictions, append-only.
CREATE TABLE IF NOT EXISTS forecasts (
  created_at TIMESTAMPTZ NOT NULL,
  target_start TIMESTAMPTZ NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('load', 'solar')),
  energy_wh REAL,
  model TEXT,
  PRIMARY KEY (created_at, target_start, kind)
);

SELECT create_hypertable(
  'forecasts', 'created_at',
  chunk_time_interval => INTERVAL '7 days',
  if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS idx_forecasts_target_start ON forecasts (target_start);

-- plans + plan_slots: each replan (every 5 min) writes one plan row + its slots.
CREATE TABLE IF NOT EXISTS plans (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  mode TEXT NOT NULL,
  current_soc_pct REAL,
  objective_cost_cents REAL,
  summary JSONB
);

CREATE INDEX IF NOT EXISTS idx_plans_created_at ON plans (created_at);

CREATE TABLE IF NOT EXISTS plan_slots (
  plan_id BIGINT NOT NULL REFERENCES plans (id) ON DELETE CASCADE,
  slot_start TIMESTAMPTZ NOT NULL,
  action TEXT NOT NULL CHECK (
    action IN (
      'charge_solar', 'charge_grid', 'discharge_load', 'discharge_grid', 'idle', 'self_consume'
    )
  ),
  battery_power_w INT,
  expected_soc_pct REAL,
  buy_price REAL,
  sell_price REAL,
  expected_load_wh REAL,
  expected_solar_wh REAL,
  expected_grid_wh REAL,
  reason TEXT,
  PRIMARY KEY (plan_id, slot_start)
);

CREATE INDEX IF NOT EXISTS idx_plan_slots_slot_start ON plan_slots (slot_start);

-- decisions: what the executor actually did each tick, hypertable chunked by day.
CREATE TABLE IF NOT EXISTS decisions (
  time TIMESTAMPTZ NOT NULL,
  slot_start TIMESTAMPTZ,
  mode TEXT NOT NULL CHECK (mode IN ('shadow', 'active')),
  action TEXT,
  battery_power_w INT,
  soc_pct REAL,
  plan_id BIGINT,
  reason TEXT,
  executed BOOLEAN,
  error TEXT,
  PRIMARY KEY (time)
);

SELECT create_hypertable(
  'decisions', 'time',
  chunk_time_interval => INTERVAL '1 day',
  if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS idx_decisions_slot_start ON decisions (slot_start);

-- sessions: signed session cookie backing store.
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
