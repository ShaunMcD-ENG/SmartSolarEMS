-- Structured override/protection info per plan slot, replacing the executor's
-- reason-string heuristic (see progress.md "Notes / Open Questions" hardening
-- candidate 2). Mirrors src/planner/optimiser.ts OptimiserSlotResult's
-- pinnedByOverrideId/demandWindowProtected fields.

ALTER TABLE plan_slots
  ADD COLUMN pinned_override_id BIGINT,
  ADD COLUMN demand_window_protected BOOLEAN;
