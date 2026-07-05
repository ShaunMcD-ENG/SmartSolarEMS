-- User-scheduled manual commands. Semantics (see design/db-schema.md):
-- overrides pin planner slots in [start_time, end_time) to the action; energy-target
-- overrides run from start_time until energy_wh delivered. Precedence:
-- safety > demand window (unless override_demand_window) > override > automatic.

CREATE TABLE overrides (
  id bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  start_time timestamptz NOT NULL,
  end_time timestamptz,
  action text NOT NULL CHECK (action IN ('charge', 'discharge', 'self_consume', 'idle')),
  energy_wh int,
  power_w int,
  override_demand_window boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'completed', 'cancelled', 'expired')),
  note text,
  CONSTRAINT override_bounded CHECK (end_time IS NOT NULL OR energy_wh IS NOT NULL)
);

CREATE INDEX overrides_window_idx ON overrides (start_time) WHERE status IN ('pending', 'active');
