import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Sql } from "../db/client";
import { createLogger } from "../lib/logger";

const log = createLogger("auth");

/** Cookie name for the session id (design/db-schema.md `sessions` table). */
export const SESSION_COOKIE_NAME = "sses";
/** Session lifetime: 30 days. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** How long a positive/negative session lookup is cached in-memory before re-hitting the DB. */
const SESSION_CACHE_TTL_MS = 5000;
/** Login attempts per key allowed per rolling window before 429. */
const LOGIN_RATE_LIMIT_MAX = 5;
const LOGIN_RATE_LIMIT_WINDOW_MS = 60_000;

export interface SessionRecord {
  id: string;
  expiresAt: Date;
}

/** Minimal session persistence surface AuthService needs. */
export interface SessionStore {
  create(record: SessionRecord): Promise<void>;
  find(id: string): Promise<SessionRecord | null>;
  remove(id: string): Promise<void>;
}

/** Default SessionStore backed by the `sessions` table (design/db-schema.md). */
export function createSqlSessionStore(sql: Sql): SessionStore {
  return {
    async create(record) {
      await sql`INSERT INTO sessions (id, expires_at) VALUES (${record.id}, ${record.expiresAt})`;
    },
    async find(id) {
      const [row] = await sql<{ id: string; expires_at: Date }[]>`
        SELECT id, expires_at FROM sessions WHERE id = ${id}
      `;
      return row ? { id: row.id, expiresAt: row.expires_at } : null;
    },
    async remove(id) {
      await sql`DELETE FROM sessions WHERE id = ${id}`;
    },
  };
}

/**
 * Structural subset of SettingsService auth.ts needs (get/set the password
 * hash, and the first-boot check). Same narrow-interface pattern as
 * PollIntervalSource/AmberSettingsSource in src/modbus/poller.ts and
 * src/amber/poller.ts — the real SettingsService satisfies this structurally.
 */
export interface AuthSettingsSource {
  get(key: "admin_password_hash"): Promise<string | null>;
  set(key: "admin_password_hash", value: string): Promise<void>;
  isFirstBoot(): Promise<boolean>;
}

interface CacheEntry {
  /** epoch ms of session expiry. */
  expiresAt: number;
  /** epoch ms when this cache entry was populated. */
  cachedAt: number;
}

/**
 * First-boot setup, login/logout, and session verification. Session lookups
 * are cached in-memory for SESSION_CACHE_TTL_MS to avoid a DB round-trip on
 * every authenticated request; login attempts are rate-limited per key
 * (typically client IP) to blunt online password guessing.
 */
export class AuthService {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly loginAttempts = new Map<string, number[]>();

  constructor(
    private readonly settings: AuthSettingsSource,
    private readonly sessions: SessionStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async isFirstBoot(): Promise<boolean> {
    return this.settings.isFirstBoot();
  }

  /**
   * Hashes and stores the admin password, then creates a session. Callers
   * (routes) must check isFirstBoot() themselves and reject with 403 rather
   * than calling this once an admin password already exists.
   */
  async setup(password: string): Promise<SessionRecord> {
    const hash = await Bun.password.hash(password, { algorithm: "argon2id" });
    await this.settings.set("admin_password_hash", hash);
    log.info("first-boot admin password configured");
    return this.createSession();
  }

  /** Returns a new session on success, null on missing/incorrect password. */
  async login(password: string): Promise<SessionRecord | null> {
    const hash = await this.settings.get("admin_password_hash");
    if (!hash) return null;
    const ok = await Bun.password.verify(password, hash);
    if (!ok) return null;
    return this.createSession();
  }

  async logout(sessionId: string): Promise<void> {
    this.cache.delete(sessionId);
    await this.sessions.remove(sessionId);
  }

  /** True if sessionId names a non-expired session. Cached for SESSION_CACHE_TTL_MS. */
  async verify(sessionId: string | undefined | null): Promise<boolean> {
    if (!sessionId) return false;
    const nowMs = this.now().getTime();

    const cached = this.cache.get(sessionId);
    if (cached && nowMs - cached.cachedAt < SESSION_CACHE_TTL_MS) {
      return cached.expiresAt > nowMs;
    }

    const record = await this.sessions.find(sessionId);
    if (!record || record.expiresAt.getTime() <= nowMs) {
      this.cache.delete(sessionId);
      return false;
    }
    this.cache.set(sessionId, { expiresAt: record.expiresAt.getTime(), cachedAt: nowMs });
    return true;
  }

  /**
   * Returns true if a login attempt from `key` (e.g. client IP) is currently
   * allowed, false if it should be rejected with 429. Does not itself record
   * the attempt — call recordLoginFailure() after a failed attempt.
   */
  checkLoginRateLimit(key: string): boolean {
    return this.recentAttempts(key).length < LOGIN_RATE_LIMIT_MAX;
  }

  recordLoginFailure(key: string): void {
    const attempts = this.recentAttempts(key);
    attempts.push(this.now().getTime());
    this.loginAttempts.set(key, attempts);
  }

  clearLoginRateLimit(key: string): void {
    this.loginAttempts.delete(key);
  }

  private recentAttempts(key: string): number[] {
    const nowMs = this.now().getTime();
    const attempts = (this.loginAttempts.get(key) ?? []).filter(
      (t) => nowMs - t < LOGIN_RATE_LIMIT_WINDOW_MS,
    );
    this.loginAttempts.set(key, attempts);
    return attempts;
  }

  private async createSession(): Promise<SessionRecord> {
    const id = crypto.randomUUID();
    const expiresAt = new Date(this.now().getTime() + SESSION_TTL_MS);
    await this.sessions.create({ id, expiresAt });
    this.cache.set(id, { expiresAt: expiresAt.getTime(), cachedAt: this.now().getTime() });
    return { id, expiresAt };
  }
}

/**
 * True if the request arrived over HTTPS (checks a reverse-proxy header
 * first, then the request URL's own scheme). unRAID LAN deployments are
 * typically plain http, so the `Secure` cookie attribute must NOT be forced
 * on unconditionally — that would lock users out on http.
 */
export function isHttps(c: Context): boolean {
  const forwardedProto = c.req.header("x-forwarded-proto");
  if (forwardedProto) return forwardedProto.split(",")[0]?.trim().toLowerCase() === "https";
  try {
    return new URL(c.req.url).protocol === "https:";
  } catch {
    return false;
  }
}

export function setSessionCookie(c: Context, sessionId: string, expiresAt: Date): void {
  setCookie(c, SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    sameSite: "Lax",
    path: "/",
    secure: isHttps(c),
    expires: expiresAt,
  });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE_NAME, { path: "/" });
}

/** Hono middleware: 401s unless the `sses` cookie names a valid, non-expired session. */
export function requireAuth(auth: AuthService): MiddlewareHandler {
  return async (c, next) => {
    const sessionId = getCookie(c, SESSION_COOKIE_NAME);
    const ok = await auth.verify(sessionId);
    if (!ok) {
      return c.json({ error: "unauthorized" }, 401);
    }
    await next();
  };
}

/**
 * Best-effort client identity for login rate limiting: the leftmost
 * X-Forwarded-For entry if a reverse proxy sets one, else a shared "unknown"
 * bucket. On a bare (no-proxy) unRAID LAN deployment this collapses to a
 * single global limiter across all clients — acceptable for a single-admin
 * appliance; a fronting reverse proxy that sets X-Forwarded-For gets proper
 * per-client limiting.
 */
export function clientKey(c: Context): string {
  const forwardedFor = c.req.header("x-forwarded-for");
  const first = forwardedFor?.split(",")[0]?.trim();
  return first && first.length > 0 ? first : "unknown";
}
