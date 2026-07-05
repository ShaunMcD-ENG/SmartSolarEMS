import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { getDb } from "../db/client";
import { isDbAvailable } from "../db/test-helpers";
import {
  AuthService,
  clientKey,
  createSqlSessionStore,
  requireAuth,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  setSessionCookie,
  type AuthSettingsSource,
} from "./auth";
import { InMemorySessionStore } from "./test-helpers";

/** Minimal in-memory AuthSettingsSource, local to this test file. */
class FakeAuthSettings implements AuthSettingsSource {
  private hash: string | null = null;

  async get(): Promise<string | null> {
    return this.hash;
  }

  async set(_key: "admin_password_hash", value: string): Promise<void> {
    this.hash = value;
  }

  async isFirstBoot(): Promise<boolean> {
    return this.hash === null;
  }
}

function extractCookieValue(setCookieHeader: string | null, name: string): string | null {
  if (!setCookieHeader) return null;
  const match = setCookieHeader.match(new RegExp(`${name}=([^;]+)`));
  return match ? match[1]! : null;
}

/** bun-types declares Response.json() as Promise<unknown>; this centralises the `any` cast. */
function readJson(res: Response): Promise<any> {
  return res.json();
}

describe("AuthService", () => {
  test("isFirstBoot is true until setup() is called", async () => {
    const settings = new FakeAuthSettings();
    const sessions = new InMemorySessionStore();
    const auth = new AuthService(settings, sessions);

    expect(await auth.isFirstBoot()).toBe(true);
    await auth.setup("a-strong-password");
    expect(await auth.isFirstBoot()).toBe(false);
  });

  test("login rejects a wrong password and accepts the right one", async () => {
    const settings = new FakeAuthSettings();
    const sessions = new InMemorySessionStore();
    const auth = new AuthService(settings, sessions);
    await auth.setup("correct-horse-battery-staple");

    expect(await auth.login("wrong-password")).toBeNull();
    const session = await auth.login("correct-horse-battery-staple");
    expect(session).not.toBeNull();
    expect(session!.id.length).toBeGreaterThan(0);
    expect(session!.expiresAt.getTime()).toBeGreaterThan(Date.now() + SESSION_TTL_MS - 5000);
  });

  test("login returns null (not an error) when no admin password has ever been set", async () => {
    const settings = new FakeAuthSettings();
    const sessions = new InMemorySessionStore();
    const auth = new AuthService(settings, sessions);
    expect(await auth.login("anything")).toBeNull();
  });

  test("verify() is true for a live session, false after logout", async () => {
    const settings = new FakeAuthSettings();
    const sessions = new InMemorySessionStore();
    const auth = new AuthService(settings, sessions);
    await auth.setup("a-strong-password");
    const session = await auth.login("a-strong-password");

    expect(await auth.verify(session!.id)).toBe(true);
    expect(await auth.verify("not-a-real-session-id")).toBe(false);
    expect(await auth.verify(undefined)).toBe(false);

    await auth.logout(session!.id);
    expect(await auth.verify(session!.id)).toBe(false);
  });

  test("verify() caches lookups so an expired-in-store session can briefly still read as valid, then flips", async () => {
    let nowMs = 0;
    const now = () => new Date(nowMs);
    const settings = new FakeAuthSettings();
    const sessions = new InMemorySessionStore();
    const auth = new AuthService(settings, sessions, now);
    await auth.setup("a-strong-password");
    const session = await auth.login("a-strong-password");

    // Directly remove the session from the store (simulating some other
    // process expiring it) without going through auth.logout(), so the
    // AuthService's cache doesn't get invalidated.
    await sessions.remove(session!.id);

    // Still within the cache TTL: cached "valid" answer survives.
    expect(await auth.verify(session!.id)).toBe(true);

    // Advance the clock past the cache TTL: next verify() re-queries the
    // store and sees it's gone.
    nowMs += 10_000;
    expect(await auth.verify(session!.id)).toBe(false);
  });

  test("login rate limiting: allows up to the max, then blocks until cleared", async () => {
    const settings = new FakeAuthSettings();
    const sessions = new InMemorySessionStore();
    const auth = new AuthService(settings, sessions);

    for (let i = 0; i < 5; i++) {
      expect(auth.checkLoginRateLimit("1.2.3.4")).toBe(true);
      auth.recordLoginFailure("1.2.3.4");
    }
    expect(auth.checkLoginRateLimit("1.2.3.4")).toBe(false);

    // A different key is unaffected.
    expect(auth.checkLoginRateLimit("5.6.7.8")).toBe(true);

    auth.clearLoginRateLimit("1.2.3.4");
    expect(auth.checkLoginRateLimit("1.2.3.4")).toBe(true);
  });

  test("login rate limit window expires old attempts", async () => {
    let nowMs = 0;
    const now = () => new Date(nowMs);
    const settings = new FakeAuthSettings();
    const sessions = new InMemorySessionStore();
    const auth = new AuthService(settings, sessions, now);

    for (let i = 0; i < 5; i++) auth.recordLoginFailure("k");
    expect(auth.checkLoginRateLimit("k")).toBe(false);

    nowMs += 61_000; // past the 60s window
    expect(auth.checkLoginRateLimit("k")).toBe(true);
  });
});

describe("requireAuth middleware", () => {
  test("401s with no cookie, 200s with a valid session cookie", async () => {
    const settings = new FakeAuthSettings();
    const sessions = new InMemorySessionStore();
    const auth = new AuthService(settings, sessions);
    await auth.setup("a-strong-password");
    const session = await auth.login("a-strong-password");

    const app = new Hono();
    app.get("/protected", requireAuth(auth), (c) => c.json({ ok: true }));

    const unauthed = await app.request("/protected");
    expect(unauthed.status).toBe(401);
    expect(await readJson(unauthed)).toEqual({ error: "unauthorized" });

    const authed = await app.request("/protected", {
      headers: { cookie: `${SESSION_COOKIE_NAME}=${session!.id}` },
    });
    expect(authed.status).toBe(200);
  });
});

describe("session cookie helpers", () => {
  test("setSessionCookie sets HttpOnly/SameSite=Lax/Path=/ and is not Secure over plain http", async () => {
    const app = new Hono();
    app.get("/set", (c) => {
      setSessionCookie(c, "abc123", new Date(Date.now() + 1000));
      return c.body(null);
    });

    const res = await app.request("http://example.com/set");
    const setCookieHeader = res.headers.get("set-cookie");
    expect(setCookieHeader).toContain("HttpOnly");
    expect(setCookieHeader).toContain("SameSite=Lax");
    expect(setCookieHeader).toContain("Path=/");
    expect(setCookieHeader).not.toContain("Secure");
    expect(extractCookieValue(setCookieHeader, SESSION_COOKIE_NAME)).toBe("abc123");
  });

  test("setSessionCookie sets Secure when the request is https (via X-Forwarded-Proto)", async () => {
    const app = new Hono();
    app.get("/set", (c) => {
      setSessionCookie(c, "abc123", new Date(Date.now() + 1000));
      return c.body(null);
    });

    const res = await app.request("http://example.com/set", {
      headers: { "x-forwarded-proto": "https" },
    });
    expect(res.headers.get("set-cookie")).toContain("Secure");
  });
});

describe("clientKey", () => {
  test("uses the leftmost X-Forwarded-For entry, else falls back to a shared bucket", async () => {
    const app = new Hono();
    app.get("/", (c) => c.json({ key: clientKey(c) }));

    const withHeader = await app.request("/", { headers: { "x-forwarded-for": "9.9.9.9, 1.1.1.1" } });
    expect((await readJson(withHeader)).key).toBe("9.9.9.9");

    const withoutHeader = await app.request("/");
    expect((await readJson(withoutHeader)).key).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// DB-backed: the real `sessions` table, via the skipIf pattern used
// throughout src/db/*.test.ts (see src/db/test-helpers.ts).
// ---------------------------------------------------------------------------

const sql = getDb();
const dbUp = await isDbAvailable(sql);

describe.skipIf(!dbUp)("createSqlSessionStore (live DB)", () => {
  test("create/find/remove roundtrip against the real sessions table", async () => {
    const { runMigrations } = await import("../db/migrate");
    await runMigrations(sql);

    const store = createSqlSessionStore(sql);
    const id = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 60_000);

    try {
      await store.create({ id, expiresAt });
      const found = await store.find(id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(id);
      expect(found!.expiresAt.getTime()).toBe(expiresAt.getTime());

      await store.remove(id);
      expect(await store.find(id)).toBeNull();
    } finally {
      await sql`DELETE FROM sessions WHERE id = ${id}`;
    }
  });
});
