# SmartSolarEMS — Progress Tracker

> Source of truth for project state across sessions. Update after every completed phase/task.
> Lead engineer (Fable) coordinates; Sonnet agents execute; lead reviews and commits.

## Project Summary

Home Energy Management System for a Sigenergy inverter + battery, using Amber Australia
wholesale pricing. Collects telemetry via Modbus TCP, stores in Postgres/TimescaleDB,
forecasts usage/solar/prices, plans 24h ahead in 5-min slots, and decides charge/discharge
actions. Runs in **shadow mode** (log decisions only) until trusted, then **active mode**
(writes remote-EMS commands to inverter). Exposes an MCP server for Claude-based auditing.
Web UI (dashboard + settings) behind an admin password set on first boot. Ships as a Docker
image on DockerHub for unRAID.

## Hard Requirements (from owner)

- Node-compatible web app, **TypeScript**, **Bun** package manager/runtime. No npm.
- **No install scripts** (never add `trustedDependencies`; Bun blocks lifecycle scripts by default).
- Git commits must contain **no Claude/AI attribution of any kind**.
- Postgres + timeseries plugin (TimescaleDB) for telemetry, prices, decisions.
- Amber Australia API for pricing (5-min intervals); commands aligned to 5-min price windows,
  with configurable "min command window".
- Shadow mode: ingest + decide + log decisions to DB without controlling the inverter.
- MCP server endpoint so Claude can audit logic/decisions.
- Admin password configured on first visit to web URL; protects settings/goals.
- Settings page: Sigenergy IP, goals, targets, all configuration.
- Max battery cycles/day target (1 = fill/drain once; ≥2 = buy-low/sell-high trading up to limit).
- Solar = free energy, infinitely preferable to grid; minimise grid draw.
- Target battery % at a given time of day.
- Respect inverter minimum reserve SOC in all decisions.
- Optional **demand window** (e.g. 15:00–20:00): avoid grid import during window, with a
  configurable buffer (default 10 min) either side; battery must be pre-charged to cover it.
- Charge in cheapest periods (~4am, midday); discharge at peak (~18:00–21:00); opportunistic
  sell during price spikes any time, if it won't force grid import later.
- Plan full next 24h; replan every 5 min as prices/solar/usage diverge from forecast.
- **User override commands** (added 2026-07-05): user can schedule manual actions ahead of
  time (e.g. "charge 9 kWh starting 01:00", "self-consumption 09:00–12:00"). Overrides beat
  all automatic/predicted behaviour, EXCEPT the configured demand window: demand-window
  self-consumption beats the override unless the user explicitly double-confirms
  ("yes, continue into the demand window") when creating it.
- Learn/improve forecasts over time. (Later: outside temperature input from Home Assistant.)
- Unit tests; verify code as much as possible.
- Branding: **SmartSolarEMS**.

## Architecture Decisions

| Area | Decision | Rationale |
|---|---|---|
| Runtime | Bun 1.3+ (`Bun.serve`) | Owner requirement; fast TS-native |
| Web framework | Hono | TS-first, Bun-native, tiny |
| Frontend | React + Vite + Recharts, built with Bun | SPA served statically by Hono |
| DB | Postgres 16 + TimescaleDB, `postgres` (porsager) driver | Owner requirement |
| Migrations | Plain SQL files + tiny in-repo runner | Minimal deps |
| Modbus | `modbus-serial` (TCP) | De-facto standard lib |
| MCP | `@modelcontextprotocol/sdk`, streamable HTTP at `/mcp` | Official SDK |
| Auth | Admin password via `Bun.password` (argon2id), signed session cookie | No extra deps |
| Scheduler | Wall-clock-aligned 5-min tick loop in-process | Aligns to Amber intervals |
| Validation | zod | Schemas for config/API |
| Tests | `bun test` | Built-in |
| Docker | Multi-stage Bun image + docker-compose w/ timescaledb | unRAID target |

## Module Layout

```
src/
  config/     env + DB-backed settings service
  db/         client, migration runner, migrations/*.sql
  modbus/     Sigenergy register map, poller, command writer
  amber/      Amber API client + price poller
  forecast/   usage/solar/price forecasting (learning)
  planner/    24h rolling optimizer (5-min slots)
  executor/   shadow/active decision executor + safety guards
  server/     Hono app, auth, REST API
  mcp/        MCP server (tools/resources for auditing)
  web/        React frontend (vite)
docs/         Sigenergy Modbus register map, Amber API reference
```

## Phase Plan & Status

- [x] **Phase 0 — Research docs**: Sigenergy Modbus register map + Amber API reference → `docs/` ✓ (official protocol PDFs v2.7/v2.9; watchdog behaviour UNVERIFIED — client must implement its own supervisory fail-safe)
- [x] **Phase 1 — Scaffold**: package.json, tsconfig, Hono server, config, logger, docker-compose.dev, migration runner, bun test smoke ✓ (9 tests green; dev DB on port **5434**, 5433 was taken)
- [x] **Phase 2 — DB schema**: telemetry, prices, forecasts, plans, decisions, settings, sessions hypertables/tables ✓ (29 tests green; migrate.ts supports `-- migrate:no-transaction`; repo helpers in src/db/repositories.ts; settings service in src/config/settings.ts)
- [x] **Phase 3 — Collectors**: Modbus poller (telemetry), Amber poller (prices, current+forecast) ✓ (73 tests across both; control methods implemented but unused until executor phase)
- [x] **Phase 4 — Forecasting**: usage & solar prediction (time-of-day/day-of-week profiles, EWMA learning), price forecast passthrough from Amber ✓ (30 tests; accuracy() gives MAPE/bias by horizon bucket; cold-start = flat 500 W load, zero solar)
- [x] **Phase 4b — Overrides storage**: migration 004 + src/db/overrides.ts (lead-built) ✓
- [ ] **Phase 5 — Planner**: 24h rolling plan, 5-min slots; constraints: min reserve, max cycles/day, target SOC@time, demand window+buffer, solar-first; objective: cost min / revenue max
- [ ] **Phase 6 — Executor**: shadow mode (log only) + active mode (Modbus remote-EMS writes), safety guards, min command window
- [ ] **Phase 7 — Web UI**: dashboard (live telemetry, prices, plan, decisions), settings page, first-boot admin setup, auth
- [ ] **Phase 8 — MCP server**: tools to query state/plan/decisions/forecast accuracy
- [ ] **Phase 9 — Packaging**: Dockerfile, compose for unRAID, DockerHub publish instructions, README
- [ ] **Phase 10 — Hardening**: end-to-end verification, extra tests, forecast accuracy metrics

## Session Log

### 2026-07-05 (session 1)
- Project charter + tracker created. Git repo initialised.
- Lead wrote design/db-schema.md + design/planner.md (DP-over-SOC optimizer, Lagrangian cycle limit).
- Phase 1 scaffold done & verified (typecheck + 9 tests). Dev TimescaleDB running on :5434, migration 001 applied.
- Phase 0 research agent still running; Phase 2 (schema + settings service) agent launched.

## Notes / Open Questions

- Sigenergy remote-EMS register semantics must be verified against real inverter before
  active mode is ever enabled (shadow mode default ON, stored in settings).
- Later feature: outside temperature ingestion (Home Assistant push or scrape) for forecasts.
- Amber `advancedPrice`/`range` fields are NOT sign-flipped for feedIn (only perKwh/spotPerKwh
  are, per docs) — verify against real feed-in forecast data once a live token is configured.
