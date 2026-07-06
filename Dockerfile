# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1: deps — full install (dev deps included, needed for the vite build).
# Bun blocks package lifecycle scripts by default; we rely on that (no
# trustedDependencies, no --allow-scripts, ever).
# ---------------------------------------------------------------------------
FROM oven/bun:1.3 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# ---------------------------------------------------------------------------
# Stage 2: prod-deps — production-only node_modules for the runtime image.
# ---------------------------------------------------------------------------
FROM oven/bun:1.3 AS prod-deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# ---------------------------------------------------------------------------
# Stage 3: build — compile the React dashboard (vite build → src/web/dist).
# The server itself needs no transpile step: Bun runs TypeScript directly.
# ---------------------------------------------------------------------------
FROM oven/bun:1.3 AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json bun.lock tsconfig.json ./
COPY src ./src
RUN bun run build:web

# ---------------------------------------------------------------------------
# Stage 4: runtime — slim image, non-root, prod deps only.
# Migrations run automatically at boot (src/index.ts calls runMigrations()).
# ---------------------------------------------------------------------------
FROM oven/bun:1.3-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8080

COPY --from=prod-deps --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json tsconfig.json ./
COPY --chown=bun:bun src ./src
COPY --from=build --chown=bun:bun /app/src/web/dist ./src/web/dist

# The oven/bun images ship a non-root `bun` user.
USER bun

EXPOSE 8080

# curl doesn't exist in the slim image; use bun's built-in fetch instead.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "src/index.ts"]
