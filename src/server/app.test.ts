import { describe, expect, test } from "bun:test";
import { createApp } from "./app";

describe("createApp", () => {
  test("GET /api/health returns ok status with version and uptime", async () => {
    const app = createApp();
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);

    const body = (await res.json()) as { status: string; version: string; uptime: number };
    expect(body.status).toBe("ok");
    expect(typeof body.version).toBe("string");
    expect(typeof body.uptime).toBe("number");
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });
});
