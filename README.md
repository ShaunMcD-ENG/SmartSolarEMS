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

## Deployment (Docker / unRAID)

SmartSolarEMS ships as a single Docker image (multi-stage build on `oven/bun`,
non-root runtime) plus a TimescaleDB container. Database migrations run
automatically every time the app boots, so upgrades are just "pull the new
image and restart".

### Build & publish to Docker Hub

```bash
docker build -t <dockerhub-user>/smartsolarems:latest .
docker push <dockerhub-user>/smartsolarems:latest
```

A single-arch `linux/amd64` image is all a typical unRAID server needs. If you
also want ARM (e.g. to test on a Raspberry Pi or Apple Silicon), build
multi-arch with buildx instead:

```bash
docker buildx build --platform linux/amd64,linux/arm64 \
  -t <dockerhub-user>/smartsolarems:latest --push .
```

### Install on unRAID — recommended: Compose Manager

1. Install the **Compose Manager** plugin from Community Applications.
2. Create a new stack and paste in this repo's `docker-compose.yml`, replacing
   `image: smartsolarems:latest` with your published
   `<dockerhub-user>/smartsolarems:latest` (or keep `build: .` if you cloned
   the repo onto the server).
3. Set `POSTGRES_PASSWORD` (and `TZ` if you're not in Sydney) in the stack's
   env, then bring the stack up.

The app waits for the database healthcheck before starting, applies
migrations, and listens on port 8080. The database is deliberately not
published on a host port — uncomment the `ports` block under `db` in
`docker-compose.yml` if you want to reach Postgres from the LAN.

### Install on unRAID — alternative: plain Docker UI

Add two containers from the Docker tab (put them on the same custom Docker
network so they can resolve each other by name):

1. **Database** — image `timescale/timescaledb:latest-pg16`, a path mapping
   for `/var/lib/postgresql/data` (e.g. `/mnt/user/appdata/smartsolarems-db`),
   and env `POSTGRES_PASSWORD=<your password>`, `POSTGRES_DB=smartsolarems`.
2. **App** — image `<dockerhub-user>/smartsolarems:latest`, port mapping
   `8080 → 8080`, and these env vars:

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | `postgres://postgres:<password>@<db-container>:5432/smartsolarems` |
| `PORT` | no | default `8080` |
| `TZ` | no | default `Australia/Sydney` — drives 5-min slot alignment + day boundaries |
| `SESSION_SECRET` | no | auto-generated at boot if unset; set one to keep web logins valid across restarts |

### First boot

1. Browse to `http://<server>:8080`.
2. Set the admin password on the first-boot setup screen.
3. Log in, open **Settings**, and configure the Sigenergy inverter IP and your
   Amber API token + site ID.
4. The system starts in **SHADOW mode** by default: it collects telemetry and
   prices, plans, and logs every decision it *would* make, but never writes to
   the inverter. Switch to active mode from Settings only once you trust the
   decisions (the change requires an explicit `ACTIVATE` confirmation).

### Data persistence & upgrades

- All state (telemetry, prices, plans, decisions, settings, sessions) lives in
  Postgres — the compose file keeps it in the named volume
  `smartsolarems-db-data`. Back up that volume (or the appdata path you
  mapped) and you can rebuild everything else.
- The app container is stateless: to upgrade, pull the new image and restart.
  Pending SQL migrations are applied automatically at boot before the server
  starts listening.

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
