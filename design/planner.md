# SmartSolarEMS — Planner / Optimizer Design

## Problem
Every 5 minutes, produce a plan for the next 24 h (288 slots of 5 min) choosing battery
power per slot to minimise net electricity cost, subject to physical and user constraints.
The executor acts only on the first slot; the rest is the published intent.

## Inputs (per replan)
- `prices[t]`: buyPrice (general channel ¢/kWh) and sellPrice (feedIn, normalised so
  positive = earnings) for each slot from Amber forecast; last known values extended if
  the forecast horizon is shorter than 24 h.
- `solarWh[t]`, `loadWh[t]`: forecast energy per slot from the forecast module.
- State: current SOC %, battery capacityWh, minReserveSoc (max of inverter reserve and
  user setting), maxChargeW, maxDischargeW, round-trip efficiency η (split as
  ηc = ηd = √η).
- Goals: maxCyclesPerDay, socTargets [{time, socPct}], demandWindow {start, end, bufferMin},
  minCommandWindowMin.

## Model
Slot energy balance (all Wh, 5-min slots):
```
solar[t] + dischargeOut[t] + gridImport[t] = load[t] + chargeIn[t] + gridExport[t]
SOC[t+1] = SOC[t] + chargeIn[t]*ηc − dischargeOut[t]/ηd
```
Slot cost = gridImport*buy[t]/1000 − gridExport*sell[t]/1000 (cents).
Solar is free: it offsets load first, then charges, then exports — this falls out of cost
minimisation naturally since buy[t] > 0 ≥ cost of solar.

## Algorithm: Dynamic Program over SOC
- Discretise SOC into steps of capacity/200 (0.5 %), floor at minReserve, cap 100 %.
- Discretise battery power into ~21 levels in [−maxDischargeW, +maxChargeW] (always include
  0 and the exact levels needed to hit socTargets).
- Backward DP: `V[t][s]` = minimal cost from slot t at SOC s to horizon end.
  Transition enumerates battery power levels; grid flow is derived from the balance
  equation; cost from prices. Terminal value: small credit `V[T][s] = −s·avgFutureBuy`
  so end-of-horizon energy isn't dumped.
- ~288 × 200 × 21 ≈ 1.2 M transitions → well under 100 ms in Bun.

### Constraints
- **Min reserve**: SOC states below floor are unreachable (−∞ / pruned).
- **Demand window + buffer**: for slots inside [start−buffer, end+buffer], any transition
  with gridImport > small tolerance (e.g. 50 Wh) gets infinite cost. The DP then naturally
  pre-charges beforehand at the cheapest prior slots.
- **SOC target at time**: at the target slot, states below target get a large penalty
  (soft constraint, 1000 ¢/% shortfall) — soft so an impossible target degrades gracefully.
- **Max cycles/day**: throughput constraint Σ chargeIn ≤ maxCycles × usableCapacity per
  calendar day. Implemented as a Lagrangian penalty λ (¢/kWh) added to every charged kWh;
  outer loop binary-searches λ ∈ [0, 500] (≤8 iterations) until planned throughput fits the
  remaining daily budget (budget minus throughput already used today, measured from
  telemetry). λ=0 tried first; skip search if already within budget.
- **Spike selling**: no special case needed — a price spike raises sell[t] and the DP sells
  if and only if the energy isn't worth more later (covering the demand window / avoiding
  later imports), which is exactly the requirement.
- **Min command window**: post-process — merge/hold actions so a commanded state persists
  ≥ minCommandWindowMin before changing (executor also enforces).
- **User overrides** (see db-schema.md `overrides` table): before running the DP, active
  pending overrides pin their slots — the transition set for a pinned slot is restricted to
  the override action (charge at power_w or max rate until energy_wh delivered; discharge
  likewise; self_consume = battery follows net load, no grid trade; idle = battery power 0).
  The DP still optimises all unpinned slots *around* the pinned ones (it sees the resulting
  SOC trajectory). Precedence: safety (min reserve, power limits) > demand window
  (unless override_demand_window=true) > user override > automatic optimisation. Slot 0's
  `reason` must say when an override or demand-window protection is in charge. Overrides
  whose energy target is met are marked completed; past-window ones expired.

### Outputs
For each slot: action label, battery_power_w (signed), expected SOC trajectory, expected
grid flow, prices used, and a human-readable `reason` for slot 0 (e.g. "charging from grid
@ 4.2 ¢ to cover demand window 15:00–20:00"). Stored in `plans`/`plan_slots`.

## Forecast module (feeds the planner)
- **Load**: per-slot profile keyed by (weekday|weekend, slot-of-day), learned as EWMA
  (α≈0.2) over daily observations from `telemetry_5m`. Near-term (next 2 h) blended with
  "persistence" of the last 30 min of actual load (weight decaying with horizon).
- **Solar**: per-slot clear-profile learned as high-quantile (e.g. 90th percentile over
  trailing 28 days) of production per slot; scale today's remaining profile by a clearness
  factor = actual/predicted over the last 2 daylight hours. Night = 0.
- **Prices**: use Amber's own forecasts (incl. advancedPrice.predicted when present);
  no local price model in v1.
- Every prediction is snapshotted into `forecasts` so accuracy (MAPE by horizon) is
  reportable in the UI and via MCP.

## Executor
Tick aligned to wall-clock 5-min boundaries (:00, :05…), a few seconds after, so fresh
Amber prices are in.
1. Load current plan slot; re-check safety: never discharge below reserve, never exceed
   power limits, demand-window import guard.
2. **Shadow mode**: write a `decisions` row (executed=false, mode=shadow) — no Modbus write.
3. **Active mode**: translate to Sigenergy remote-EMS registers (per docs/sigenergy-modbus.md),
   write, verify by read-back, record decision (executed=true) or error. On repeated Modbus
   failure: fail safe — hand control back to inverter's max-self-consumption mode and alert.
4. Honour minCommandWindowMin: don't flip charge↔discharge before the window elapses
   (idle→action is allowed).
