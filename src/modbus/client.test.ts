import { describe, expect, test } from "bun:test";
import type { ModbusTransport } from "./client";
import { SigenergyClient } from "./client";
import { CONTROL_REGISTERS, PLANT_REGISTERS, REMOTE_EMS_CONTROL_MODE, TELEMETRY_BLOCK_A } from "./registers";

interface Call {
  fn: string;
  args: unknown[];
}

interface FakeTransport extends ModbusTransport {
  registerWords: Map<number, number>;
  calls: Call[];
  listeners: Map<string, ((...args: unknown[]) => void)[]>;
  emit(event: string, ...args: unknown[]): void;
  setWords(address: number, words: number[]): void;
}

/** In-memory fake ModbusRTU transport — no real socket, no real timers by default. */
function makeFakeTransport(): FakeTransport {
  const registerWords = new Map<number, number>();
  const calls: Call[] = [];
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  let open = false;

  const readBlock = (address: number, length: number): number[] =>
    Array.from({ length }, (_, i) => registerWords.get(address + i) ?? 0);

  const fake: FakeTransport = {
    get isOpen() {
      return open;
    },
    registerWords,
    calls,
    listeners,
    setWords(address, words) {
      words.forEach((w, i) => registerWords.set(address + i, w));
    },
    emit(event, ...args) {
      // A real socket "close" event only fires once isOpen has already gone false —
      // mirror that here so the client's own reconnect logic sees a closed transport.
      if (event === "close") open = false;
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
    async connectTCP(ip, options) {
      calls.push({ fn: "connectTCP", args: [ip, options] });
      open = true;
    },
    close() {
      open = false;
    },
    setID(id) {
      calls.push({ fn: "setID", args: [id] });
    },
    setTimeout(durationMs) {
      calls.push({ fn: "setTimeout", args: [durationMs] });
    },
    async readHoldingRegisters(address, length) {
      calls.push({ fn: "readHoldingRegisters", args: [address, length] });
      return { data: readBlock(address, length) };
    },
    async readInputRegisters(address, length) {
      calls.push({ fn: "readInputRegisters", args: [address, length] });
      return { data: readBlock(address, length) };
    },
    async writeRegister(address, value) {
      calls.push({ fn: "writeRegister", args: [address, value] });
      registerWords.set(address, value);
      return { address, value };
    },
    async writeRegisters(address, values) {
      calls.push({ fn: "writeRegisters", args: [address, values] });
      values.forEach((v, i) => registerWords.set(address + i, v));
      return { address, length: values.length };
    },
    on(event, listener) {
      const arr = listeners.get(event) ?? [];
      arr.push(listener);
      listeners.set(event, arr);
      return fake;
    },
  };
  return fake;
}

const BASE_CONFIG = { host: "10.0.0.50", port: 502, plantUnitId: 247 };

describe("SigenergyClient connect/disconnect", () => {
  test("connect() opens the TCP connection with configured host/port and applies the timeout", async () => {
    const transport = makeFakeTransport();
    const client = new SigenergyClient({ ...BASE_CONFIG, timeoutMs: 1234 }, transport);

    await client.connect();

    expect(transport.calls[0]).toEqual({ fn: "connectTCP", args: ["10.0.0.50", { port: 502 }] });
    expect(transport.calls.some((c) => c.fn === "setTimeout" && c.args[0] === 1234)).toBe(true);
    expect(client.connected).toBe(true);
  });

  test("disconnect() closes the transport and prevents auto-reconnect", async () => {
    const transport = makeFakeTransport();
    const client = new SigenergyClient(BASE_CONFIG, transport);
    await client.connect();

    client.disconnect();
    expect(client.connected).toBe(false);

    transport.emit("close");
    await new Promise((r) => setTimeout(r, 20));
    // Only the original connectTCP call — no reconnect attempt after a manual disconnect.
    expect(transport.calls.filter((c) => c.fn === "connectTCP").length).toBe(1);
  });
});

describe("SigenergyClient auto-reconnect", () => {
  test("reconnects with backoff after an unexpected close", async () => {
    const transport = makeFakeTransport();
    const client = new SigenergyClient({ ...BASE_CONFIG, baseBackoffMs: 5, maxBackoffMs: 20 }, transport);
    await client.connect();
    expect(transport.calls.filter((c) => c.fn === "connectTCP").length).toBe(1);

    transport.emit("close");
    await new Promise((r) => setTimeout(r, 40));

    expect(transport.calls.filter((c) => c.fn === "connectTCP").length).toBeGreaterThanOrEqual(2);
  });
});

describe("SigenergyClient.readTelemetry", () => {
  test("batches plant registers into two reads and normalises signs/units", async () => {
    const transport = makeFakeTransport();
    // EMS work mode = 7 (remote EMS); grid +0.6kW import; SOC 68.5%; PV 3.2kW;
    // ESS +2.5kW charging; running state = 1 (running).
    transport.setWords(PLANT_REGISTERS.EMS_WORK_MODE.address, [7]);
    transport.setWords(PLANT_REGISTERS.GRID_ACTIVE_POWER.address, [0, 600]);
    transport.setWords(PLANT_REGISTERS.ESS_SOC.address, [685]);
    transport.setWords(PLANT_REGISTERS.PV_POWER.address, [0, 3200]);
    transport.setWords(PLANT_REGISTERS.ESS_POWER.address, [0, 2500]);
    transport.setWords(PLANT_REGISTERS.PLANT_RUNNING_STATE.address, [1]);
    transport.setWords(PLANT_REGISTERS.TOTAL_LOAD_POWER.address, [0, 1800]);

    const client = new SigenergyClient(BASE_CONFIG, transport);
    const telemetry = await client.readTelemetry();

    expect(telemetry).toEqual({
      pvPowerW: 3200,
      batteryPowerW: 2500,
      batterySocPct: 68.5,
      gridPowerW: 600,
      loadPowerW: 1800,
      emsMode: 7,
      runningState: 1,
    });

    const holdingReads = transport.calls.filter((c) => c.fn === "readHoldingRegisters");
    expect(holdingReads.length).toBe(2);
    expect(holdingReads[0]?.args).toEqual([TELEMETRY_BLOCK_A.start, TELEMETRY_BLOCK_A.length]);
    expect(holdingReads[1]?.args).toEqual([
      PLANT_REGISTERS.TOTAL_LOAD_POWER.address,
      PLANT_REGISTERS.TOTAL_LOAD_POWER.length,
    ]);
  });

  test("negative ESS power (discharging) and negative grid power (exporting) pass through unflipped", async () => {
    const transport = makeFakeTransport();
    transport.setWords(PLANT_REGISTERS.ESS_POWER.address, encodeSignedKw(-1.5));
    transport.setWords(PLANT_REGISTERS.GRID_ACTIVE_POWER.address, encodeSignedKw(-0.4));

    const client = new SigenergyClient(BASE_CONFIG, transport);
    const telemetry = await client.readTelemetry();

    expect(telemetry.batteryPowerW).toBe(-1500);
    expect(telemetry.gridPowerW).toBe(-400);
  });
});

/** Encodes a signed kW value (gain 1000) into the two big-endian words an S32 register uses. */
function encodeSignedKw(kw: number): number[] {
  const raw = Math.round(kw * 1000);
  const unsigned = raw < 0 ? raw + 0x100000000 : raw;
  return [Math.floor(unsigned / 0x10000) & 0xffff, unsigned & 0xffff];
}

describe("SigenergyClient request serialisation", () => {
  test("never issues two requests to the transport concurrently", async () => {
    const transport = makeFakeTransport();
    let concurrent = 0;
    let maxConcurrent = 0;
    const originalRead = transport.readInputRegisters.bind(transport);
    transport.readInputRegisters = async (address, length) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((r) => setTimeout(r, 10));
      const result = await originalRead(address, length);
      concurrent -= 1;
      return result;
    };

    const client = new SigenergyClient(BASE_CONFIG, transport);
    await Promise.all([client.readSocLimits(), client.readSocLimits(), client.readSocLimits()]);

    expect(maxConcurrent).toBe(1);
  });
});

describe("SigenergyClient per-request timeout", () => {
  test("rejects a request that never resolves once the timeout elapses", async () => {
    const transport = makeFakeTransport();
    transport.readHoldingRegisters = () => new Promise(() => {}); // never resolves

    const client = new SigenergyClient({ ...BASE_CONFIG, timeoutMs: 20 }, transport);

    await expect(client.readTelemetry()).rejects.toThrow(/timed out/);
  });

  test("a timed-out request does not block subsequent requests", async () => {
    const transport = makeFakeTransport();
    let call = 0;
    transport.readHoldingRegisters = async (address, length) => {
      call += 1;
      if (call === 1) return new Promise(() => {}); // first call hangs forever
      return { data: Array.from({ length }, () => 0) };
    };

    const client = new SigenergyClient({ ...BASE_CONFIG, timeoutMs: 15 }, transport);
    await expect(client.readTelemetry()).rejects.toThrow(/timed out/);
    // Second call should proceed normally once the first has timed out.
    await expect(client.readTelemetry()).resolves.toBeDefined();
  });
});

describe("SigenergyClient control methods (write + read-back verify)", () => {
  test("enableRemoteEms writes 1 and verifies via read-back", async () => {
    const transport = makeFakeTransport();
    const client = new SigenergyClient(BASE_CONFIG, transport);

    const ok = await client.enableRemoteEms(true);

    expect(ok).toBe(true);
    expect(transport.calls).toContainEqual({
      fn: "writeRegister",
      args: [CONTROL_REGISTERS.REMOTE_EMS_ENABLE.address, 1],
    });
  });

  test("enableRemoteEms returns false when read-back does not match the written value", async () => {
    const transport = makeFakeTransport();
    // Simulate the device silently ignoring the write: read-back always reports 0.
    transport.readInputRegisters = async () => ({ data: [0] });
    const client = new SigenergyClient(BASE_CONFIG, transport);

    const ok = await client.enableRemoteEms(true);

    expect(ok).toBe(false);
  });

  test("setControlMode writes the enum value to register 40031", async () => {
    const transport = makeFakeTransport();
    const client = new SigenergyClient(BASE_CONFIG, transport);

    const ok = await client.setControlMode(REMOTE_EMS_CONTROL_MODE.MaxSelfConsumption);

    expect(ok).toBe(true);
    expect(transport.calls).toContainEqual({
      fn: "writeRegister",
      args: [CONTROL_REGISTERS.REMOTE_EMS_CONTROL_MODE.address, REMOTE_EMS_CONTROL_MODE.MaxSelfConsumption],
    });
  });

  test("setChargePowerW defaults to PV-first command charging and writes the charge limit in kW", async () => {
    const transport = makeFakeTransport();
    const client = new SigenergyClient(BASE_CONFIG, transport);

    const ok = await client.setChargePowerW(3000);

    expect(ok).toBe(true);
    expect(transport.calls).toContainEqual({
      fn: "writeRegister",
      args: [CONTROL_REGISTERS.REMOTE_EMS_CONTROL_MODE.address, REMOTE_EMS_CONTROL_MODE.CommandChargingPvFirst],
    });
    expect(transport.calls).toContainEqual({
      fn: "writeRegisters",
      args: [CONTROL_REGISTERS.ESS_MAX_CHARGE_LIMIT.address, [0, 3000]],
    });
  });

  test('setChargePowerW(watts, "pv_first") explicitly selects PV-first command charging', async () => {
    const transport = makeFakeTransport();
    const client = new SigenergyClient(BASE_CONFIG, transport);

    const ok = await client.setChargePowerW(1200, "pv_first");

    expect(ok).toBe(true);
    expect(transport.calls).toContainEqual({
      fn: "writeRegister",
      args: [CONTROL_REGISTERS.REMOTE_EMS_CONTROL_MODE.address, REMOTE_EMS_CONTROL_MODE.CommandChargingPvFirst],
    });
  });

  test('setChargePowerW(watts, "grid_first") switches to grid-first command charging and writes the charge limit', async () => {
    const transport = makeFakeTransport();
    const client = new SigenergyClient(BASE_CONFIG, transport);

    const ok = await client.setChargePowerW(4000, "grid_first");

    expect(ok).toBe(true);
    expect(transport.calls).toContainEqual({
      fn: "writeRegister",
      args: [CONTROL_REGISTERS.REMOTE_EMS_CONTROL_MODE.address, REMOTE_EMS_CONTROL_MODE.CommandChargingGridFirst],
    });
    expect(transport.calls).toContainEqual({
      fn: "writeRegisters",
      args: [CONTROL_REGISTERS.ESS_MAX_CHARGE_LIMIT.address, [0, 4000]],
    });
  });

  test("setDischargePowerW switches to ESS-first command discharging and writes the discharge limit", async () => {
    const transport = makeFakeTransport();
    const client = new SigenergyClient(BASE_CONFIG, transport);

    const ok = await client.setDischargePowerW(1500);

    expect(ok).toBe(true);
    expect(transport.calls).toContainEqual({
      fn: "writeRegister",
      args: [
        CONTROL_REGISTERS.REMOTE_EMS_CONTROL_MODE.address,
        REMOTE_EMS_CONTROL_MODE.CommandDischargingEssFirst,
      ],
    });
    expect(transport.calls).toContainEqual({
      fn: "writeRegisters",
      args: [CONTROL_REGISTERS.ESS_MAX_DISCHARGE_LIMIT.address, [0, 1500]],
    });
  });

  test("setChargePowerW rejects negative wattage", () => {
    const transport = makeFakeTransport();
    const client = new SigenergyClient(BASE_CONFIG, transport);
    expect(client.setChargePowerW(-100)).rejects.toThrow();
  });
});

describe("SigenergyClient.readSocLimits / readRatedEnergy", () => {
  test("readSocLimits reads the 3-register SOC-limit block in one request", async () => {
    const transport = makeFakeTransport();
    transport.setWords(CONTROL_REGISTERS.ESS_BACKUP_SOC.address, [100]); // 10.0%
    transport.setWords(CONTROL_REGISTERS.ESS_CHARGE_CUTOFF_SOC.address, [1000]); // 100.0%
    transport.setWords(CONTROL_REGISTERS.ESS_DISCHARGE_CUTOFF_SOC.address, [50]); // 5.0%

    const client = new SigenergyClient(BASE_CONFIG, transport);
    const limits = await client.readSocLimits();

    expect(limits).toEqual({ backupSocPct: 10, chargeCutoffSocPct: 100, dischargeCutoffSocPct: 5 });
    expect(transport.calls.filter((c) => c.fn === "readInputRegisters").length).toBe(1);
  });

  test("readRatedEnergy converts kWh to Wh", async () => {
    const transport = makeFakeTransport();
    transport.setWords(PLANT_REGISTERS.ESS_RATED_ENERGY_CAPACITY.address, [0, 1000]); // gain 100 -> 10 kWh
    const client = new SigenergyClient(BASE_CONFIG, transport);

    const rated = await client.readRatedEnergy();

    expect(rated).toEqual({ ratedEnergyWh: 10000 });
  });
});
