# SmartSolarEMS

Home energy management system for a Sigenergy inverter + battery, using Amber
Electric wholesale pricing. Polls telemetry over Modbus TCP, stores it in
Postgres/TimescaleDB, forecasts solar/usage/price, plans 24 hours ahead in
5-minute slots, and drives charge/discharge decisions through a shadow-mode
(log-only) or active (inverter-writing) executor. Includes a React dashboard
and an MCP server for Claude-based auditing of decisions.

## Development setup

```bash
bun install
docker compose -f docker-compose.dev.yml up -d
cp .env.example .env
bun run migrate
bun run dev
```

The dev server listens on `PORT` (default `8080`); health check at
`GET /api/health`.

## Scripts

- `bun run dev` — start the server with file watching
- `bun run start` — start the server (no watch)
- `bun test` — run unit tests
- `bun run typecheck` — type-check with `tsc --noEmit`
- `bun run migrate` — apply pending SQL migrations from `src/db/migrations/`
- `bun run build:web` — build the React dashboard (Vite)
