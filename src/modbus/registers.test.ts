import { describe, expect, test } from "bun:test";
import {
  CONTROL_REGISTERS,
  decodeRegisterValue,
  decodeS16,
  decodeS32,
  decodeU16,
  decodeU32,
  decodeU64,
  encodeRegisterValue,
  encodeS16,
  encodeS32,
  encodeU16,
  encodeU32,
  encodeU64,
  normaliseBatteryPowerW,
  normaliseGridPowerW,
  PLANT_REGISTERS,
  REGISTER_WORD_LENGTH,
  scaleFromRaw,
  scaleToRaw,
  sliceRegister,
  TELEMETRY_BLOCK_A,
} from "./registers";

describe("word-level decode/encode round trips", () => {
  test("U16 round-trips a plain positive value", () => {
    const words = encodeU16(685);
    expect(words).toEqual([685]);
    expect(decodeU16(words)).toBe(685);
  });

  test("S16 round-trips a negative value using two's complement", () => {
    const words = encodeS16(-273);
    expect(decodeS16(words)).toBe(-273);
  });

  test("S16 round-trips zero and the positive/negative boundary values", () => {
    expect(decodeS16(encodeS16(0))).toBe(0);
    expect(decodeS16(encodeS16(32767))).toBe(32767);
    expect(decodeS16(encodeS16(-32768))).toBe(-32768);
  });

  test("U32 round-trips the worked example from docs/sigenergy-modbus.md (Rated active power)", () => {
    // Host Query: 01 03 77 4C 00 02 -> Slave Response: 01 03 04 00 00 61 A8
    // i.e. words [0x0000, 0x61A8] = 25000 decimal (gain 1000 kW -> 25.000 kW).
    const words = [0x0000, 0x61a8];
    expect(decodeU32(words)).toBe(25000);
    expect(encodeU32(25000)).toEqual(words);
  });

  test("S32 round-trips a large negative value across the word boundary", () => {
    const words = encodeS32(-1234567);
    expect(decodeS32(words)).toBe(-1234567);
  });

  test("S32 round-trips zero and the positive/negative boundary values", () => {
    expect(decodeS32(encodeS32(0))).toBe(0);
    expect(decodeS32(encodeS32(2147483647))).toBe(2147483647);
    expect(decodeS32(encodeS32(-2147483648))).toBe(-2147483648);
  });

  test("U64 decodes a large value from four high-word-first registers", () => {
    // 0x0001_0002_0003_0004
    const words = [0x0001, 0x0002, 0x0003, 0x0004];
    expect(decodeU64(words)).toBe(0x0001000200030004n);
  });

  test("U64 round-trips via encodeU64/decodeU64", () => {
    const value = 123456789012345n;
    expect(decodeU64(encodeU64(value))).toBe(value);
  });
});

describe("gain scaling", () => {
  test("scaleFromRaw divides by gain; scaleToRaw multiplies and rounds", () => {
    expect(scaleFromRaw(685, 10)).toBeCloseTo(68.5);
    expect(scaleToRaw(68.5, 10)).toBe(685);
  });

  test("gain 1 is a no-op passthrough", () => {
    expect(scaleFromRaw(42, 1)).toBe(42);
    expect(scaleToRaw(42, 1)).toBe(42);
  });

  test("decodeRegisterValue/encodeRegisterValue round-trip ESS_SOC (U16, gain 10, %)", () => {
    const words = encodeRegisterValue(68.5, PLANT_REGISTERS.ESS_SOC);
    expect(decodeRegisterValue(words, PLANT_REGISTERS.ESS_SOC)).toBeCloseTo(68.5);
  });

  test("decodeRegisterValue/encodeRegisterValue round-trip a negative S32 kW register", () => {
    // ESS Power: <0 = discharging. -2.5 kW discharging.
    const words = encodeRegisterValue(-2.5, PLANT_REGISTERS.ESS_POWER);
    expect(decodeRegisterValue(words, PLANT_REGISTERS.ESS_POWER)).toBeCloseTo(-2.5);
  });

  test("decodeRegisterValue/encodeRegisterValue round-trip a control register (U32 kW)", () => {
    const words = encodeRegisterValue(3.2, CONTROL_REGISTERS.ESS_MAX_CHARGE_LIMIT);
    expect(decodeRegisterValue(words, CONTROL_REGISTERS.ESS_MAX_CHARGE_LIMIT)).toBeCloseTo(3.2);
  });
});

describe("sign normalisation boundary", () => {
  test("normaliseBatteryPowerW converts kW to W preserving +charge/-discharge sign", () => {
    expect(normaliseBatteryPowerW(2.5)).toBe(2500);
    expect(normaliseBatteryPowerW(-1.75)).toBe(-1750);
  });

  test("normaliseGridPowerW converts kW to W preserving +import/-export sign", () => {
    expect(normaliseGridPowerW(0.6)).toBe(600);
    expect(normaliseGridPowerW(-3.1)).toBe(-3100);
  });
});

describe("sliceRegister", () => {
  test("extracts a register's words from a contiguous block read", () => {
    // TELEMETRY_BLOCK_A starts at 30003; ESS_SOC is at 30014 (offset 11).
    const block = new Array<number>(TELEMETRY_BLOCK_A.length).fill(0);
    block[11] = 685; // ESS_SOC raw = 68.5%
    const words = sliceRegister(block, TELEMETRY_BLOCK_A.start, PLANT_REGISTERS.ESS_SOC);
    expect(decodeRegisterValue(words, PLANT_REGISTERS.ESS_SOC)).toBeCloseTo(68.5);
  });

  test("throws if the register falls outside the given block", () => {
    const block = new Array<number>(4).fill(0);
    expect(() => sliceRegister(block, 40046, PLANT_REGISTERS.ESS_SOC)).toThrow();
  });
});

describe("register map coverage", () => {
  test("every plant register carries fc 3 (30000-series read via 0x03)", () => {
    for (const def of Object.values(PLANT_REGISTERS)) {
      expect(def.fc).toBe(3);
      expect(def.address).toBeGreaterThanOrEqual(30000);
    }
  });

  test("every control register carries fc 4 (40000-series read via 0x04)", () => {
    for (const def of Object.values(CONTROL_REGISTERS)) {
      expect(def.fc).toBe(4);
      expect(def.address).toBeGreaterThanOrEqual(40000);
    }
  });

  test("register length always matches its declared type's word count", () => {
    for (const def of [...Object.values(PLANT_REGISTERS), ...Object.values(CONTROL_REGISTERS)]) {
      expect(def.length).toBe(REGISTER_WORD_LENGTH[def.type]);
    }
  });
});
