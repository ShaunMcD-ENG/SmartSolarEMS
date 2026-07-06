import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { makeFakeDeps } from "./test-helpers";

// Every app below is created with an EXPLICIT webDistDir (either a temp dir
// that exists or a path that never does) so these tests are deterministic
// regardless of whether the real src/web/dist build output happens to exist
// on disk (see progress.md hardening candidate 3).
const MISSING_DIST = "/nonexistent/path/for/sure";

describe("createApp", () => {
  const dist = mkdtempSync(join(tmpdir(), "smartsolarems-web-dist-"));
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>SmartSolarEMS</title>");
  afterAll(() => rmSync(dist, { recursive: true, force: true }));

  test("GET /api/health returns ok status with version and uptime", async () => {
    const app = createApp(makeFakeDeps({ webDistDir: MISSING_DIST }));
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { status: string; version: string; uptime: number };
    expect(body.status).toBe("ok");
    expect(typeof body.version).toBe("string");
    expect(typeof body.uptime).toBe("number");
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  describe("unknown /api/* routes are always a JSON 404", () => {
    test("when the web dist does not exist", async () => {
      const app = createApp(makeFakeDeps({ webDistDir: MISSING_DIST }));
      const res = await app.request("/api/does-not-exist");
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("not_found");
    });

    test("when the web dist exists (never falls back to the SPA)", async () => {
      const app = createApp(makeFakeDeps({ webDistDir: dist }));
      const res = await app.request("/api/does-not-exist");
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("not_found");
    });
  });

  test("non-API unknown routes return 404 when webDistDir does not exist", async () => {
    const app = createApp(makeFakeDeps({ webDistDir: MISSING_DIST }));
    const res = await app.request("/some/spa/route");
    expect(res.status).toBe(404);
  });

  describe("static frontend serving (webDistDir exists)", () => {
    test("serves a real file by path", async () => {
      const app = createApp(makeFakeDeps({ webDistDir: dist }));
      const res = await app.request("/index.html");
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("SmartSolarEMS");
    });

    test("falls back to index.html (200 html) for unmatched non-API SPA routes", async () => {
      const app = createApp(makeFakeDeps({ webDistDir: dist }));
      const res = await app.request("/dashboard/settings");
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("SmartSolarEMS");
    });

    test("never shadows /api/* routes", async () => {
      const app = createApp(makeFakeDeps({ webDistDir: dist }));
      const res = await app.request("/api/health");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("ok");
    });
  });
});
