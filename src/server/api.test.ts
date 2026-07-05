import { afterEach, describe, expect, test } from "bun:test";
import { SettingsService } from "../config/settings";
import { getDb } from "../db/client";
import { isDbAvailable } from "../db/test-helpers";
import { createApp } from "./app";
import { InMemorySettings, makeFakeDeps } from "./test-helpers";
import type { AppDeps } from "./types";

function extractCookie(res: Response): string {
  const header = res.headers.get("set-cookie");
  if (!header) throw new Error("expected a Set-Cookie header");
  return header.split(";")[0]!;
}

/** bun-types declares Response.json() as Promise<unknown>; this centralises the `any` cast. */
function readJson(res: Response): Promise<any> {
  return res.json();
}

/** Boots an app already past first-boot (admin password = `password`), returning app + session cookie. */
async function bootedApp(
  password: string,
  overrides: Partial<AppDeps> = {},
): Promise<{ app: ReturnType<typeof createApp>; cookie: string }> {
  const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
  const settings = (overrides.settings as InMemorySettings | undefined) ?? new InMemorySettings();
  await settings.set("admin_password_hash", hash);

  const app = createApp(makeFakeDeps({ ...overrides, settings }));
  const loginRes = await app.request("/api/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  expect(loginRes.status).toBe(200);
  return { app, cookie: extractCookie(loginRes) };
}

describe("first-boot gate", () => {
  test("GET /api/auth/status reports firstBoot true before setup", async () => {
    const app = createApp(makeFakeDeps());
    const res = await app.request("/api/auth/status");
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ firstBoot: true, authenticated: false });
  });

  test("mutating routes other than /api/setup are 403 before setup", async () => {
    const app = createApp(makeFakeDeps());

    const login = await app.request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "whatever1" }),
    });
    expect(login.status).toBe(403);
    expect((await readJson(login)).error).toBe("first_boot_setup_required");

    const settingsPut = await app.request("/api/settings/mode", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shadow: true }),
    });
    expect(settingsPut.status).toBe(403);
  });

  test("POST /api/setup rejects a too-short password with 400", async () => {
    const app = createApp(makeFakeDeps());
    const res = await app.request("/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "short" }),
    });
    expect(res.status).toBe(400);
    expect((await readJson(res)).error).toBe("validation_error");
  });

  test("POST /api/setup succeeds once, then 403s on a second attempt", async () => {
    const settings = new InMemorySettings();
    const app = createApp(makeFakeDeps({ settings }));

    const first = await app.request("/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "a-strong-password" }),
    });
    expect(first.status).toBe(200);
    expect(first.headers.get("set-cookie")).toContain("sses=");

    const second = await app.request("/api/setup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "another-password" }),
    });
    expect(second.status).toBe(403);
    expect((await readJson(second)).error).toBe("already_configured");
  });
});

describe("login", () => {
  test("wrong password -> 401, right password -> 200 with session cookie", async () => {
    const hash = await Bun.password.hash("right-password", { algorithm: "argon2id" });
    const settings = new InMemorySettings({ admin_password_hash: hash });
    const app = createApp(makeFakeDeps({ settings }));

    const wrong = await app.request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong-password" }),
    });
    expect(wrong.status).toBe(401);

    const right = await app.request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "right-password" }),
    });
    expect(right.status).toBe(200);
    expect(right.headers.get("set-cookie")).toContain("sses=");
  });

  test("login rate limiting: 6th attempt in a minute is 429", async () => {
    const hash = await Bun.password.hash("right-password", { algorithm: "argon2id" });
    const settings = new InMemorySettings({ admin_password_hash: hash });
    const app = createApp(makeFakeDeps({ settings }));

    for (let i = 0; i < 5; i++) {
      const res = await app.request("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: "wrong-password" }),
      });
      expect(res.status).toBe(401);
    }

    const sixth = await app.request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong-password" }),
    });
    expect(sixth.status).toBe(429);
  });
});

describe("requireAuth on protected reads", () => {
  test("GET /api/status is 401 without a session, 200 with one", async () => {
    const { app, cookie } = await bootedApp("a-strong-password");

    const unauthed = await app.request("/api/status");
    expect(unauthed.status).toBe(401);

    const authed = await app.request("/api/status", { headers: { cookie } });
    expect(authed.status).toBe(200);
    const body = await readJson(authed);
    expect(body.mode).toBe("shadow");
    expect(body.db.ok).toBe(true);
  });
});

describe("GET /api/settings redaction", () => {
  test("amber.apiToken is masked, admin_password_hash is never returned, adminPasswordSet reflects state", async () => {
    const { app, cookie } = await bootedApp("a-strong-password");

    const putRes = await app.request("/api/settings/amber", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ apiToken: "sk-live-1234567890", siteId: "site-1", pollIntervalMs: 300000 }),
    });
    expect(putRes.status).toBe(200);

    const res = await app.request("/api/settings", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await readJson(res);

    expect(body.admin_password_hash).toBeUndefined();
    expect(body.adminPasswordSet).toBe(true);
    expect(body.amber.apiToken).not.toContain("1234567890".slice(0, 6));
    expect(body.amber.apiToken).toContain("7890");
    expect(body.amber.siteId).toBe("site-1");
  });

  test("unset amber token is masked to an empty string, not a fake-looking mask", async () => {
    const { app, cookie } = await bootedApp("a-strong-password");
    const res = await app.request("/api/settings", { headers: { cookie } });
    const body = await readJson(res);
    expect(body.amber.apiToken).toBe("");
  });
});

describe("PUT /api/settings/:key validation", () => {
  test("unknown key -> 400", async () => {
    const { app, cookie } = await bootedApp("a-strong-password");
    const res = await app.request("/api/settings/not_a_real_key", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ anything: true }),
    });
    expect(res.status).toBe(400);
    expect((await readJson(res)).error).toBe("unknown_setting_key");
  });

  test("admin_password_hash cannot be set directly -> 400", async () => {
    const { app, cookie } = await bootedApp("a-strong-password");
    const res = await app.request("/api/settings/admin_password_hash", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify("some-hash"),
    });
    expect(res.status).toBe(400);
    expect((await readJson(res)).error).toBe("not_directly_settable");
  });

  test("mode.shadow=false without confirm -> rejected; with confirm: ACTIVATE -> 200", async () => {
    const { app, cookie } = await bootedApp("a-strong-password");

    const withoutConfirm = await app.request("/api/settings/mode", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ shadow: false }),
    });
    expect([400, 409]).toContain(withoutConfirm.status);
    expect((await readJson(withoutConfirm)).error).toBe("confirmation_required");

    const withConfirm = await app.request("/api/settings/mode", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ shadow: false, confirm: "ACTIVATE" }),
    });
    expect(withConfirm.status).toBe(200);

    const statusRes = await app.request("/api/status", { headers: { cookie } });
    expect((await readJson(statusRes)).mode).toBe("active");
  });
});

describe("overrides", () => {
  test("validation failure: neither end_time nor energy_wh -> 400", async () => {
    const { app, cookie } = await bootedApp("a-strong-password");
    const res = await app.request("/api/overrides", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        start_time: new Date(Date.now() + 3600_000).toISOString(),
        action: "charge",
      }),
    });
    expect(res.status).toBe(400);
    expect((await readJson(res)).error).toBe("validation_error");
  });

  test("validation failure: invalid action enum -> 400", async () => {
    const { app, cookie } = await bootedApp("a-strong-password");
    const res = await app.request("/api/overrides", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        start_time: new Date(Date.now() + 3600_000).toISOString(),
        energy_wh: 9000,
        action: "levitate",
      }),
    });
    expect(res.status).toBe(400);
  });

  test("demand-window conflict -> 409, then succeeds with override_demand_window: true", async () => {
    const settings = new InMemorySettings({
      demandWindow: { enabled: true, start: "15:00", end: "20:00", bufferMin: 10 },
    });
    let inserted: unknown = null;
    const { app, cookie } = await bootedApp("a-strong-password", {
      settings,
      overridesRepo: {
        insertOverride: async (input) => {
          inserted = input;
          return { ...input, id: 42, created_at: new Date(), status: "pending" };
        },
        listOverrides: async () => [],
        setOverrideStatus: async () => true,
      },
    });

    // 2099-07-05 (far future, so it's always "in the future" regardless of when this
    // test runs) is winter in Australia/Sydney (AEST, UTC+10): 16:00-17:00 local =
    // 06:00-07:00 UTC, squarely inside the 15:00-20:00 (+/-10min) demand window.
    const body = {
      start_time: "2099-07-05T06:00:00Z",
      end_time: "2099-07-05T07:00:00Z",
      action: "discharge",
    };

    const conflictRes = await app.request("/api/overrides", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    });
    expect(conflictRes.status).toBe(409);
    const conflictBody = await readJson(conflictRes);
    expect(conflictBody.error).toBe("demand_window_conflict");
    expect(conflictBody.requiresConfirmation).toBe(true);
    expect(inserted).toBeNull();

    const confirmedRes = await app.request("/api/overrides", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ ...body, override_demand_window: true }),
    });
    expect(confirmedRes.status).toBe(201);
    expect(inserted).not.toBeNull();
  });

  test("GET /api/overrides filters by status, cancel transitions status", async () => {
    const calls: { id: number; status: string }[] = [];
    const { app, cookie } = await bootedApp("a-strong-password", {
      overridesRepo: {
        insertOverride: async (input) => ({ ...input, id: 1, created_at: new Date(), status: "pending" }),
        listOverrides: async (opts) => {
          if (opts?.statuses?.includes("cancelled")) {
            return [
              {
                id: 7,
                created_at: new Date(),
                start_time: new Date(),
                end_time: null,
                action: "idle",
                energy_wh: null,
                power_w: null,
                override_demand_window: false,
                status: "cancelled",
                note: null,
              },
            ];
          }
          return [];
        },
        setOverrideStatus: async (id, status) => {
          calls.push({ id, status });
          return true;
        },
      },
    });

    const res = await app.request("/api/overrides?status=cancelled", { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].id).toBe(7);

    const cancelRes = await app.request("/api/overrides/7/cancel", { method: "POST", headers: { cookie } });
    expect(cancelRes.status).toBe(200);
    expect(calls).toEqual([{ id: 7, status: "cancelled" }]);
  });

  test("cancel of a nonexistent override -> 404", async () => {
    const { app, cookie } = await bootedApp("a-strong-password", {
      overridesRepo: {
        insertOverride: async (input) => ({ ...input, id: 1, created_at: new Date(), status: "pending" }),
        listOverrides: async () => [],
        setOverrideStatus: async () => false,
      },
    });
    const res = await app.request("/api/overrides/999/cancel", { method: "POST", headers: { cookie } });
    expect(res.status).toBe(404);
  });
});

describe("read endpoints with injected fake repos", () => {
  test("GET /api/telemetry?res=5m returns 5m rows by default", async () => {
    const { app, cookie } = await bootedApp("a-strong-password", {
      repos: {
        latestTelemetry: async () => null,
        telemetryBetween: async () => [],
        telemetry5mBetween: async () => [
          {
            bucket: new Date("2026-01-01T00:00:00Z"),
            pv_power_w_avg: 100,
            battery_power_w_avg: 0,
            grid_power_w_avg: 0,
            load_power_w_avg: 100,
            battery_soc_pct_avg: 50,
            battery_soc_pct_last: 50,
            pv_energy_wh: 8,
            battery_energy_wh: 0,
            grid_energy_wh: 0,
            load_energy_wh: 8,
          },
        ],
        pricesBetween: async () => [],
        latestPlan: async () => null,
        decisionsBetween: async () => [],
      },
    });

    const res = await app.request(
      `/api/telemetry?from=${encodeURIComponent("2026-01-01T00:00:00Z")}&to=${encodeURIComponent("2026-01-01T01:00:00Z")}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.res).toBe("5m");
    expect(body.rows).toHaveLength(1);
  });

  test("GET /api/telemetry?res=raw uses the raw repo function", async () => {
    const { app, cookie } = await bootedApp("a-strong-password", {
      repos: {
        latestTelemetry: async () => null,
        telemetryBetween: async () => [
          {
            time: new Date("2026-01-01T00:00:00Z"),
            pv_power_w: 42,
            battery_power_w: null,
            battery_soc_pct: null,
            grid_power_w: null,
            load_power_w: null,
            ems_mode: null,
            extra: null,
          },
        ],
        telemetry5mBetween: async () => [],
        pricesBetween: async () => [],
        latestPlan: async () => null,
        decisionsBetween: async () => [],
      },
    });

    const res = await app.request(
      `/api/telemetry?res=raw&from=${encodeURIComponent("2026-01-01T00:00:00Z")}&to=${encodeURIComponent("2026-01-01T01:00:00Z")}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.res).toBe("raw");
    expect(body.rows[0].pv_power_w).toBe(42);
  });

  test("GET /api/telemetry rejects a range wider than 31 days", async () => {
    const { app, cookie } = await bootedApp("a-strong-password");
    const res = await app.request(
      `/api/telemetry?from=${encodeURIComponent("2026-01-01T00:00:00Z")}&to=${encodeURIComponent("2026-03-15T00:00:00Z")}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(400);
    expect((await readJson(res)).error).toBe("range_too_large");
  });

  test("GET /api/telemetry missing query params -> 400 validation_error", async () => {
    const { app, cookie } = await bootedApp("a-strong-password");
    const res = await app.request("/api/telemetry", { headers: { cookie } });
    expect(res.status).toBe(400);
    expect((await readJson(res)).error).toBe("validation_error");
  });

  test("GET /api/prices returns rows for the requested channel", async () => {
    const { app, cookie } = await bootedApp("a-strong-password", {
      repos: {
        latestTelemetry: async () => null,
        telemetryBetween: async () => [],
        telemetry5mBetween: async () => [],
        pricesBetween: async (_from, _to, channel) => [
          {
            interval_start: new Date("2026-01-01T00:00:00Z"),
            channel,
            per_kwh: 25.5,
            spot_per_kwh: 10,
            renewables: 50,
            spike_status: "none",
            interval_type: "actual",
            estimate: false,
            updated_at: new Date(),
          },
        ],
        latestPlan: async () => null,
        decisionsBetween: async () => [],
      },
    });

    const res = await app.request(
      `/api/prices?from=${encodeURIComponent("2026-01-01T00:00:00Z")}&to=${encodeURIComponent("2026-01-01T01:00:00Z")}&channel=feedIn`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.rows[0].channel).toBe("feedIn");
  });

  test("GET /api/plan/latest returns null when there is no plan", async () => {
    const { app, cookie } = await bootedApp("a-strong-password");
    const res = await app.request("/api/plan/latest", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual({ plan: null });
  });

  test("GET /api/decisions requires from/to", async () => {
    const { app, cookie } = await bootedApp("a-strong-password");
    const res = await app.request("/api/decisions", { headers: { cookie } });
    expect(res.status).toBe(400);
  });

  test("GET /api/forecast/accuracy proxies the injected forecast service", async () => {
    const emptyBucket = { n: 0, mape: null, biasWh: null };
    const { app, cookie } = await bootedApp("a-strong-password", {
      forecastService: {
        accuracy: async () => ({
          load: { "0-1h": { n: 3, mape: 12.5, biasWh: -10 }, "1-4h": emptyBucket, "4-12h": emptyBucket, "12-24h": emptyBucket },
          solar: { "0-1h": emptyBucket, "1-4h": emptyBucket, "4-12h": emptyBucket, "12-24h": emptyBucket },
        }),
      },
    });

    const res = await app.request(
      `/api/forecast/accuracy?from=${encodeURIComponent("2026-01-01T00:00:00Z")}&to=${encodeURIComponent("2026-01-02T00:00:00Z")}`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.load["0-1h"].n).toBe(3);
  });
});

describe("logout", () => {
  test("clears the session so subsequent authed requests 401", async () => {
    const { app, cookie } = await bootedApp("a-strong-password");

    const logoutRes = await app.request("/api/logout", { method: "POST", headers: { cookie } });
    expect(logoutRes.status).toBe(200);

    const after = await app.request("/api/status", { headers: { cookie } });
    expect(after.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// DB-backed: PUT /api/settings/:key against the *real* SettingsService, so
// the zod schema validation it delegates to is genuinely exercised (the
// InMemorySettings fake used above is a dumb store with no validation).
// ---------------------------------------------------------------------------

const sql = getDb();
const dbUp = await isDbAvailable(sql);

describe.skipIf(!dbUp)("PUT /api/settings/:key (real SettingsService)", () => {
  afterEach(async () => {
    await sql`DELETE FROM settings WHERE key IN ('admin_password_hash', 'battery')`;
  });

  test("invalid body shape for a known key -> 400 validation_error", async () => {
    const settings = new SettingsService(sql);
    const password = "a-strong-password";
    const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
    await settings.set("admin_password_hash", hash);

    const app = createApp(makeFakeDeps({ settings }));
    const loginRes = await app.request("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    const cookie = extractCookie(loginRes);

    const res = await app.request("/api/settings/battery", {
      method: "PUT",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ capacityWh: "not-a-number" }),
    });
    expect(res.status).toBe(400);
    expect((await readJson(res)).error).toBe("validation_error");
  });
});
