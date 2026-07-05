import { describe, expect, test } from "bun:test";
import { loadEnv } from "./env";

describe("loadEnv", () => {
  test("accepts a valid minimal environment and applies defaults", () => {
    const config = loadEnv({ DATABASE_URL: "postgres://localhost/test" });
    expect(config.DATABASE_URL).toBe("postgres://localhost/test");
    expect(config.PORT).toBe(8080);
    expect(config.TZ).toBe("Australia/Sydney");
    expect(config.SESSION_SECRET).toBeUndefined();
  });

  test("respects overridden PORT and TZ", () => {
    const config = loadEnv({
      DATABASE_URL: "postgres://localhost/test",
      PORT: "9090",
      TZ: "UTC",
    });
    expect(config.PORT).toBe(9090);
    expect(config.TZ).toBe("UTC");
  });

  test("throws when DATABASE_URL is missing", () => {
    expect(() => loadEnv({})).toThrow();
  });

  test("throws when PORT is not a valid number", () => {
    expect(() =>
      loadEnv({ DATABASE_URL: "postgres://localhost/test", PORT: "not-a-number" }),
    ).toThrow();
  });
});
