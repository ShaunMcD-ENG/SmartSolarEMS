import type { Context, Hono } from "hono";
import { getCookie } from "hono/cookie";
import { z } from "zod";
import pkg from "../../package.json" with { type: "json" };
import { env } from "../config/env";
import type { SettingsKey, SettingsValue } from "../config/settings";
import type { OverrideStatus } from "../db/overrides";
import { createLogger } from "../lib/logger";
import {
  AuthService,
  clearSessionCookie,
  clientKey,
  requireAuth,
  SESSION_COOKIE_NAME,
  setSessionCookie,
  type AuthSettingsSource,
} from "./auth";
import { ASSUMED_ENERGY_OVERRIDE_MAX_MS, demandWindowConflict } from "./demand-window";
import type { AppDeps } from "./types";

const log = createLogger("api");

const startedAt = Date.now();

/** Range cap for GET /api/telemetry, per task spec. */
const TELEMETRY_RANGE_CAP_MS = 31 * 24 * 60 * 60 * 1000;
/** Grace period so "start now" requests aren't rejected by clock/network skew. */
const OVERRIDE_START_GRACE_MS = 60_000;

const SETTINGS_KEYS = [
  "admin_password_hash",
  "sigenergy",
  "amber",
  "battery",
  "goals",
  "demandWindow",
  "mode",
  "pricing",
] as const satisfies readonly SettingsKey[];

// Compile-time exhaustiveness check: fails to typecheck if SettingsKey (in
// src/config/settings.ts) ever gains or loses a member not reflected above.
type KeysMatch = (typeof SETTINGS_KEYS)[number] extends SettingsKey
  ? SettingsKey extends (typeof SETTINGS_KEYS)[number]
    ? true
    : never
  : never;
const _keysExhaustive: KeysMatch = true;
void _keysExhaustive;

function isSettingsKey(key: string): key is SettingsKey {
  return (SETTINGS_KEYS as readonly string[]).includes(key);
}

/** Masks a secret, keeping just enough to let an admin recognise "which one" without revealing it. */
function maskSecret(value: string): string {
  if (!value) return "";
  return `•••${value.slice(-4)}`;
}

function errorJson(c: Context, status: 400 | 401 | 403 | 404 | 409 | 429, error: string, detail?: unknown) {
  return c.json(detail === undefined ? { error } : { error, detail }, status);
}

function zodError(c: Context, err: z.ZodError) {
  return errorJson(c, 400, "validation_error", err.issues);
}

async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

const setupSchema = z.object({
  password: z.string().min(8, "password must be at least 8 characters"),
});

const loginSchema = z.object({
  password: z.string().min(1, "password is required"),
});

const overrideActionEnum = z.enum(["charge", "discharge", "self_consume", "idle"]);

const overrideCreateSchema = z
  .object({
    start_time: z.coerce.date(),
    end_time: z.coerce.date().nullable().optional(),
    action: overrideActionEnum,
    energy_wh: z.number().int().positive().nullable().optional(),
    power_w: z.number().int().positive().nullable().optional(),
    note: z.string().max(500).nullable().optional(),
    override_demand_window: z.boolean().optional().default(false),
  })
  .refine((d) => (d.end_time ?? null) !== null || (d.energy_wh ?? null) !== null, {
    message: "either end_time or energy_wh is required (see overrides table constraint)",
    path: ["end_time"],
  })
  .refine((d) => d.end_time == null || d.end_time.getTime() > d.start_time.getTime(), {
    message: "end_time must be after start_time",
    path: ["end_time"],
  });

const OVERRIDE_STATUSES: readonly OverrideStatus[] = [
  "pending",
  "active",
  "completed",
  "cancelled",
  "expired",
];

function isOverrideStatus(value: string): value is OverrideStatus {
  return (OVERRIDE_STATUSES as readonly string[]).includes(value);
}

/**
 * Registers every /api/* route directly on `app` (rather than a nested
 * sub-router) so first-boot-gate/auth middleware ordering and path matching
 * stay unambiguous. Call once per created app.
 */
export function registerApiRoutes(app: Hono, deps: AppDeps): void {
  const now = deps.now ?? (() => new Date());
  const version = deps.version ?? pkg.version ?? "0.0.0";
  const tz = env().TZ;

  const authSettings: AuthSettingsSource = {
    get: (key) => deps.settings.get(key),
    set: (key, value) => deps.settings.set(key, value),
    isFirstBoot: () => deps.settings.isFirstBoot(),
  };
  const auth = new AuthService(authSettings, deps.sessions, now);
  const requireAuthMw = requireAuth(auth);

  // ---------------------------------------------------------------------
  // First-boot gate: while no admin password is set, the only mutating
  // call allowed is POST /api/setup. Reads (GET) are never blocked here.
  // ---------------------------------------------------------------------
  app.use("/api/*", async (c, next) => {
    if (c.req.method === "GET") return next();
    if (c.req.path === "/api/setup") return next();
    if (await deps.settings.isFirstBoot()) {
      return errorJson(c, 403, "first_boot_setup_required", "complete POST /api/setup first");
    }
    return next();
  });

  // ---------------------------------------------------------------------
  // Public routes
  // ---------------------------------------------------------------------

  app.get("/api/health", (c) =>
    c.json({ status: "ok", version, uptime: Math.floor((Date.now() - startedAt) / 1000) }),
  );

  app.get("/api/auth/status", async (c) => {
    const firstBoot = await deps.settings.isFirstBoot();
    const authenticated = await auth.verify(getCookie(c, SESSION_COOKIE_NAME));
    return c.json({ firstBoot, authenticated });
  });

  app.post("/api/setup", async (c) => {
    if (!(await deps.settings.isFirstBoot())) {
      return errorJson(c, 403, "already_configured");
    }
    const parsed = setupSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) return zodError(c, parsed.error);

    const session = await auth.setup(parsed.data.password);
    setSessionCookie(c, session.id, session.expiresAt);
    return c.json({ ok: true });
  });

  app.post("/api/login", async (c) => {
    const key = clientKey(c);
    if (!auth.checkLoginRateLimit(key)) {
      return errorJson(c, 429, "too_many_attempts", "try again in a minute");
    }

    const parsed = loginSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) return zodError(c, parsed.error);

    const session = await auth.login(parsed.data.password);
    if (!session) {
      auth.recordLoginFailure(key);
      return errorJson(c, 401, "invalid_credentials");
    }
    auth.clearLoginRateLimit(key);
    setSessionCookie(c, session.id, session.expiresAt);
    return c.json({ ok: true });
  });

  app.post("/api/logout", async (c) => {
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);
    if (sessionId) await auth.logout(sessionId);
    clearSessionCookie(c);
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------------
  // Authenticated reads
  // ---------------------------------------------------------------------

  app.get("/api/status", requireAuthMw, async (c) => {
    let mode: SettingsValue<"mode"> | null = null;
    let dbOk = true;
    try {
      mode = await deps.settings.get("mode");
    } catch (err) {
      dbOk = false;
      log.error("status: settings read failed", { error: err instanceof Error ? err.message : String(err) });
    }

    return c.json({
      mode: mode?.shadow === false ? "active" : "shadow",
      modbus: deps.pollers.modbus.status(),
      amber: deps.pollers.amber.status(),
      executor: deps.executor?.status() ?? null,
      db: { ok: dbOk },
      version,
      uptime: Math.floor((Date.now() - startedAt) / 1000),
    });
  });

  app.get("/api/telemetry", requireAuthMw, async (c) => {
    const parsed = z
      .object({
        from: z.coerce.date(),
        to: z.coerce.date(),
        res: z.enum(["raw", "5m"]).optional().default("5m"),
      })
      .safeParse({
        from: c.req.query("from"),
        to: c.req.query("to"),
        res: c.req.query("res"),
      });
    if (!parsed.success) return zodError(c, parsed.error);

    const { from, to, res } = parsed.data;
    if (to.getTime() < from.getTime()) return errorJson(c, 400, "invalid_range", "to must be >= from");
    if (to.getTime() - from.getTime() > TELEMETRY_RANGE_CAP_MS) {
      return errorJson(c, 400, "range_too_large", "max telemetry range is 31 days");
    }

    const rows =
      res === "raw" ? await deps.repos.telemetryBetween(from, to) : await deps.repos.telemetry5mBetween(from, to);
    return c.json({ res, rows });
  });

  app.get("/api/prices", requireAuthMw, async (c) => {
    const parsed = z
      .object({
        from: z.coerce.date(),
        to: z.coerce.date(),
        channel: z.enum(["general", "feedIn", "controlledLoad"]).optional().default("general"),
      })
      .safeParse({
        from: c.req.query("from"),
        to: c.req.query("to"),
        channel: c.req.query("channel"),
      });
    if (!parsed.success) return zodError(c, parsed.error);
    if (parsed.data.to.getTime() < parsed.data.from.getTime()) {
      return errorJson(c, 400, "invalid_range", "to must be >= from");
    }

    const rows = await deps.repos.pricesBetween(parsed.data.from, parsed.data.to, parsed.data.channel);
    return c.json({ rows });
  });

  app.get("/api/plan/latest", requireAuthMw, async (c) => {
    const plan = await deps.repos.latestPlan();
    return c.json({ plan });
  });

  app.get("/api/decisions", requireAuthMw, async (c) => {
    const parsed = z
      .object({ from: z.coerce.date(), to: z.coerce.date() })
      .safeParse({ from: c.req.query("from"), to: c.req.query("to") });
    if (!parsed.success) return zodError(c, parsed.error);
    if (parsed.data.to.getTime() < parsed.data.from.getTime()) {
      return errorJson(c, 400, "invalid_range", "to must be >= from");
    }

    const rows = await deps.repos.decisionsBetween(parsed.data.from, parsed.data.to);
    return c.json({ rows });
  });

  app.get("/api/forecast/accuracy", requireAuthMw, async (c) => {
    const parsed = z
      .object({ from: z.coerce.date(), to: z.coerce.date() })
      .safeParse({ from: c.req.query("from"), to: c.req.query("to") });
    if (!parsed.success) return zodError(c, parsed.error);
    if (parsed.data.to.getTime() < parsed.data.from.getTime()) {
      return errorJson(c, 400, "invalid_range", "to must be >= from");
    }

    const result = await deps.forecastService.accuracy(parsed.data.from, parsed.data.to);
    return c.json(result);
  });

  // ---------------------------------------------------------------------
  // Authenticated writes: settings
  // ---------------------------------------------------------------------

  app.get("/api/settings", requireAuthMw, async (c) => {
    const all = await deps.settings.getAll();
    const { admin_password_hash, amber, ...rest } = all;

    return c.json({
      ...rest,
      amber: amber ? { ...amber, apiToken: maskSecret(amber.apiToken) } : amber,
      adminPasswordSet: admin_password_hash !== null,
    });
  });

  app.put("/api/settings/:key", requireAuthMw, async (c) => {
    const key = c.req.param("key");
    if (!isSettingsKey(key)) return errorJson(c, 400, "unknown_setting_key", key);
    if (key === "admin_password_hash") {
      return errorJson(c, 400, "not_directly_settable", "use POST /api/setup to configure the admin password");
    }

    const body = await readJsonBody(c);

    if (key === "mode") {
      const parsed = z.object({ shadow: z.boolean(), confirm: z.string().optional() }).safeParse(body);
      if (!parsed.success) return zodError(c, parsed.error);
      if (parsed.data.shadow === false && parsed.data.confirm !== "ACTIVATE") {
        return errorJson(
          c,
          400,
          "confirmation_required",
          'set confirm: "ACTIVATE" in the request body to arm real inverter control',
        );
      }
      await deps.settings.set("mode", { shadow: parsed.data.shadow });
      return c.json({ ok: true });
    }

    try {
      await deps.settings.set(key, body as SettingsValue<typeof key>);
    } catch (err) {
      if (err instanceof z.ZodError) return zodError(c, err);
      throw err;
    }
    return c.json({ ok: true });
  });

  // ---------------------------------------------------------------------
  // Authenticated writes: overrides
  // ---------------------------------------------------------------------

  app.get("/api/overrides", requireAuthMw, async (c) => {
    const raw = c.req.queries("status") ?? (c.req.query("status") ? [c.req.query("status")!] : []);
    const statusValues = raw.flatMap((v) => v.split(",")).filter((v) => v.length > 0);

    const invalid = statusValues.find((v) => !isOverrideStatus(v));
    if (invalid) return errorJson(c, 400, "invalid_status", invalid);

    const statuses = statusValues.length > 0 ? (statusValues as OverrideStatus[]) : undefined;
    const rows = await deps.overridesRepo.listOverrides(statuses ? { statuses } : {});
    return c.json({ rows });
  });

  app.post("/api/overrides", requireAuthMw, async (c) => {
    const parsed = overrideCreateSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) return zodError(c, parsed.error);
    const data = parsed.data;

    if (data.start_time.getTime() < now().getTime() - OVERRIDE_START_GRACE_MS) {
      return errorJson(c, 400, "validation_error", "start_time must be now or in the future");
    }

    const demandWindow = await deps.settings.get("demandWindow");
    if (demandWindow?.enabled && !data.override_demand_window) {
      const effectiveEnd = data.end_time ?? new Date(data.start_time.getTime() + ASSUMED_ENERGY_OVERRIDE_MAX_MS);
      if (demandWindowConflict(demandWindow, tz, data.start_time, effectiveEnd)) {
        return c.json(
          { error: "demand_window_conflict", demandWindow, requiresConfirmation: true },
          409,
        );
      }
    }

    const row = await deps.overridesRepo.insertOverride({
      start_time: data.start_time,
      end_time: data.end_time ?? null,
      action: data.action,
      energy_wh: data.energy_wh ?? null,
      power_w: data.power_w ?? null,
      override_demand_window: data.override_demand_window,
      note: data.note ?? null,
    });
    return c.json(row, 201);
  });

  app.post("/api/overrides/:id/cancel", requireAuthMw, async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return errorJson(c, 400, "invalid_id");

    const ok = await deps.overridesRepo.setOverrideStatus(id, "cancelled");
    if (!ok) return errorJson(c, 404, "not_found");
    return c.json({ ok: true });
  });
}
