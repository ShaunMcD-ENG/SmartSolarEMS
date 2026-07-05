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

## MCP audit endpoint

SmartSolarEMS exposes a read-only [MCP](https://modelcontextprotocol.io) server over
Streamable HTTP at `POST/GET/DELETE /mcp`, so you can point Claude at your running
instance and ask it to audit what the system has been deciding and why — e.g. "why did
it charge from the grid at 2am last night?" or "has the forecast been accurate this
week?". Every tool is strictly read-only in v1: nothing exposed here can change settings,
overrides, or write to the inverter.

Tools available: `get_system_status`, `get_settings` (secrets masked), `get_current_state`,
`get_latest_plan`, `get_decisions`, `get_prices`, `get_telemetry`, `get_forecast_accuracy`,
`list_overrides`, and `explain_decision` (the most useful one — give it a time, or
`"latest"`, and it returns the decision plus the plan, prices, and telemetry around it).

The endpoint is disabled unless a token is set. To (re)generate one, log in to the web UI
first, then:

```bash
curl -X POST http://<host>:8080/api/mcp/token/regenerate \
  -H "cookie: <your session cookie>"
```

This returns `{ "token": "..." }` **once, in full** — `GET /api/settings` only ever shows
it masked afterwards, so store it somewhere safe. Regenerating replaces the previous
token immediately. To disable the endpoint entirely without discarding the token, set
`mcp.enabled` to `false` via `PUT /api/settings/mcp`.

Point a Streamable-HTTP-capable MCP client at it — for Claude Code, add this to your MCP
config:

```json
{
  "mcpServers": {
    "smartsolarems": {
      "type": "http",
      "url": "http://<host>:8080/mcp",
      "headers": {
        "Authorization": "Bearer <token>"
      }
    }
  }
}
```
