# SmartSolarEMS — Database Schema Design

Postgres 16 + TimescaleDB. All timestamps `timestamptz`. Power in **watts**, energy in **Wh**,
prices in **cents/kWh (AUD)**, SOC in **percent (0–100)**.

## settings (plain table)
Single source of runtime configuration, editable via UI (admin-authed).
```
key text primary key,
value jsonb not null,
updated_at timestamptz not null default now()
```
Known keys (zod-validated in `src/config/settings.ts`):
- `admin_password_hash` (string; set on first boot via web UI)
- `sigenergy` { host, port=502, plantUnitId, inverterUnitId, pollIntervalMs=10000 }
- `amber` { apiToken, siteId, pollIntervalMs=300000 }
- `battery` { capacityWh, usableMinSocPct (inverter reserve), maxChargeW, maxDischargeW,
  roundTripEfficiency=0.90 }
- `goals` { maxCyclesPerDay=1, socTargets: [{ time:"HH:MM", socPct }], minCommandWindowMin=5 }
- `demandWindow` { enabled, start:"15:00", end:"20:00", bufferMin=10 }
- `mode` { shadow: true }   ← active control only when explicitly flipped
- `pricing` { spikeSellThreshold c/kWh optional }

## telemetry (hypertable, chunk 1 day)
```
time timestamptz not null,
pv_power_w int, battery_power_w int,          -- battery: +charge / -discharge
battery_soc_pct real, grid_power_w int,        -- grid: +import / -export
load_power_w int, ems_mode smallint,
extra jsonb                                    -- raw/rare registers
PK (time)
```
Continuous aggregate `telemetry_5m`: avg/min/max of each channel bucketed 5 min,
plus integrated energy (`avg_w * 300/3600` Wh). Used by forecasting + UI charts.

## prices (hypertable) — latest known value per interval, upserted on each poll
```
interval_start timestamptz not null,
channel text not null,               -- 'general' | 'feedIn' | 'controlledLoad'
per_kwh real not null,               -- normalised: buy = cost you pay; sell = ¢ you EARN
                                     -- (Amber feedIn sign is inverted at ingest)
spot_per_kwh real, renewables real, spike_status text,
interval_type text not null,         -- 'forecast' | 'current' | 'actual'
estimate boolean, updated_at timestamptz not null,
PK (interval_start, channel)
```

## price_forecast_snapshots (hypertable, append-only)
Full forecast payload each poll, for later forecast-accuracy scoring.
```
fetched_at timestamptz, channel text, payload jsonb, PK (fetched_at, channel)
```

## forecasts (hypertable, append-only) — our own load/solar predictions
```
created_at timestamptz, target_start timestamptz,
kind text ('load'|'solar'), energy_wh real, model text,
PK (created_at, target_start, kind)
```

## plans + plan_slots
Each replan (every 5 min) writes one row + its slots.
```
plans: id bigserial PK, created_at, mode text, current_soc_pct real,
       objective_cost_cents real, summary jsonb
plan_slots: plan_id bigint, slot_start timestamptz,
       action text ('charge_solar'|'charge_grid'|'discharge_load'|'discharge_grid'|
                    'idle'|'self_consume'),
       battery_power_w int, expected_soc_pct real,
       buy_price real, sell_price real,
       expected_load_wh real, expected_solar_wh real, expected_grid_wh real,
       reason text, PK (plan_id, slot_start)
```

## decisions (hypertable) — what the executor actually did each tick
```
time timestamptz, slot_start timestamptz, mode text ('shadow'|'active'),
action text, battery_power_w int, soc_pct real,
plan_id bigint, reason text, executed boolean, error text,
PK (time)
```

## overrides (plain table) — user-scheduled manual commands (migration 004)
```
id bigserial PK, created_at timestamptz not null default now(),
start_time timestamptz not null, end_time timestamptz,   -- end null = until energy target met
action text not null,        -- 'charge' | 'discharge' | 'self_consume' | 'idle'
energy_wh int,               -- e.g. "charge 9 kWh" → 9000; null = hold action for window
power_w int,                 -- optional explicit power; null = planner picks (≤ limits)
override_demand_window boolean not null default false,  -- true only after double-confirm
status text not null default 'pending',  -- pending|active|completed|cancelled|expired
note text
```
Semantics: overrides pin planner slots in [start_time, end_time) to the action (energy-target
overrides run from start_time until energy_wh delivered, then complete). Overrides beat all
automatic behaviour EXCEPT demand-window protection: slots inside the demand window+buffer
revert to self-consumption unless override_demand_window=true. Safety limits (min reserve
SOC, max charge/discharge power) always apply regardless.

## sessions (plain)
```
id text PK, created_at, expires_at
```

## Retention / compression
- telemetry: compress after 7 days, retain 2 years.
- prices/forecasts/decisions: retain 2 years (small).
Set via timescale policies in migrations.
