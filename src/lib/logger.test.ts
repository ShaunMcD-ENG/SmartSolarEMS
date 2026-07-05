import { describe, expect, test, beforeEach, afterEach, mock } from "bun:test";
import { createLogger } from "./logger";

describe("createLogger", () => {
  let originalLog: typeof console.log;
  let originalWarn: typeof console.warn;
  let originalError: typeof console.error;
  let calls: unknown[][];

  beforeEach(() => {
    calls = [];
    originalLog = console.log;
    originalWarn = console.warn;
    originalError = console.error;
    console.log = mock((...args: unknown[]) => {
      calls.push(args);
    });
    console.warn = mock((...args: unknown[]) => {
      calls.push(args);
    });
    console.error = mock((...args: unknown[]) => {
      calls.push(args);
    });
  });

  afterEach(() => {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  });

  test("info logs include ISO timestamp and module tag", () => {
    const log = createLogger("modbus");
    log.info("polling started");

    expect(calls.length).toBe(1);
    const line = calls[0]?.[0] as string;
    expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[INFO\] \[modbus\] polling started$/);
  });

  test("error goes to console.error", () => {
    const log = createLogger("amber");
    console.error = mock((...args: unknown[]) => calls.push(["error", ...args]));
    log.error("request failed");
    expect(calls.some((c) => c[0] === "error")).toBe(true);
  });

  test("debug is suppressed by default (below info level)", () => {
    const log = createLogger("planner");
    log.debug("verbose detail");
    expect(calls.length).toBe(0);
  });

  test("meta object is passed through as a second argument", () => {
    const log = createLogger("executor");
    log.info("decision made", { action: "charge" });
    expect(calls.length).toBe(1);
    expect(calls[0]?.[1]).toEqual({ action: "charge" });
  });
});
