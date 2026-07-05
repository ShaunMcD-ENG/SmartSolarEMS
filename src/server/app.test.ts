import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { createApp } from "./app";
import { makeFakeDeps } from "./test-helpers";

describe("createApp", () => {
  test("GET /api/health returns ok status with version and uptime", async () => {
    const app = createApp(makeFakeDeps());
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { status: string; version: string; uptime: number };
    expect(body.status).toBe("ok");
    expect(typeof body.version).toBe("string");
    expect(typeof body.uptime).toBe("number");
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  test("unknown route returns a consistent JSON 404", async () => {
    const app = createApp(makeFakeDeps());
    const res = await app.request("/api/does-not-exist");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("not_found");
  });

  test("static frontend fallback is skipped when webDistDir does not exist", async () => {
    const app = createApp(makeFakeDeps({ webDistDir: "/nonexistent/path/for/sure" }));
    const res = await app.request("/some/spa/route");
    expect(res.status).toBe(404);
  });

  describe("static frontend serving (webDistDir exists)", () => {
    const dir = mkdtempSync(join(tmpdir(), "smartsolarems-web-dist-"));
    writeFileSync(join(dir, "index.html"), "<!doctype html><title>SmartSolarEMS</title>");
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    test("serves a real file by path", async () => {
      const app = createApp(makeFakeDeps({ webDistDir: dir }));
      const res = await app.request("/index.html");
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("SmartSolarEMS");
    });

    test("falls back to index.html for unmatched SPA routes", async () => {
      const app = createApp(makeFakeDeps({ webDistDir: dir }));
      const res = await app.request("/dashboard/settings");
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("SmartSolarEMS");
    });

    test("never shadows /api/* routes", async () => {
      const app = createApp(makeFakeDeps({ webDistDir: dir }));
      const res = await app.request("/api/health");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { status: string };
      expect(body.status).toBe("ok");
    });
  });
});
