/**
 * Sigenergy (SigenStor) Modbus TCP register map, per docs/sigenergy-modbus.md.
 *
 * Only plant-level registers (slave address 247) are modelled here: the "running
 * information" read registers (§4 of the doc, function code 0x03, 30000-series
 * addresses) and the remote-EMS control registers (§6, function code 0x04 to read /
 * 0x06 (single)/0x10 (multiple) to write, 40000-series addresses). Per-inverter
 * (31000/31500-series) and smart-load (30098+) registers are out of scope for this
 * phase — see docs/sigenergy-modbus.md §5 if/when per-inverter detail is needed.
 *
 * **Critical wire-format quirk (docs/sigenergy-modbus.md §2):** despite Sigenergy's
 * own section titles contradicting themselves across protocol versions, the actual
 * wire behaviour (confirmed by worked hex examples, stable across V2.7 and V2.9) is:
 *   - 30000/31000/32000-range addresses -> function code 0x03 (`readHoldingRegisters`
 *     in modbus-serial's naming).
 *   - 40000/41000/42000/50000-range addresses -> function code 0x04
 *     (`readInputRegisters` in modbus-serial's naming).
 * Each `RegisterDef` below carries the correct `fc` for its address range so callers
 * never have to make this decision themselves.
 */

// ---------------------------------------------------------------------------
// Data types, word order, gain
// ---------------------------------------------------------------------------

export type RegisterType = "U16" | "S16" | "U32" | "S32" | "U64";
export type RegisterAccess = "RO" | "RW" | "WO";

/** Number of 16-bit registers (words) each type occupies on the wire. */
export const REGISTER_WORD_LENGTH: Record<RegisterType, number> = {
  U16: 1,
  S16: 1,
  U32: 2,
  S32: 2,
  U64: 4,
};

export interface RegisterDef {
  readonly name: string;
  readonly address: number;
  /** Word (register) count; always derived from `type` via REGISTER_WORD_LENGTH. */
  readonly length: number;
  readonly type: RegisterType;
  /** Divide raw register value by gain to get the value in `unit`. 1 = no scaling. */
  readonly gain: number;
  readonly unit: string;
  readonly access: RegisterAccess;
  /** Function code to use to *read* this register (0x03 or 0x04) — see module docstring. */
  readonly fc: 3 | 4;
  readonly comment?: string;
}

function reg(def: Omit<RegisterDef, "length">): RegisterDef {
  return { ...def, length: REGISTER_WORD_LENGTH[def.type] };
}

// ---------------------------------------------------------------------------
// Multi-word decode/encode helpers
//
// Word order is CONFIRMED big-endian / high-word-first ("ABCD") per
// docs/sigenergy-modbus.md §3, backed by official worked examples for U32; applied
// to U64 by extension (the doc flags U64 word order as unverified against real
// hardware, but big-endian/high-word-first is the only documented convention).
// These operate on the `data: number[]` arrays modbus-serial already returns (each
// element a 16-bit unsigned word) — no byte-level endianness handling needed here.
// ---------------------------------------------------------------------------

export function decodeU16(words: readonly number[]): number {
  return (words[0] ?? 0) & 0xffff;
}

export function decodeS16(words: readonly number[]): number {
  const raw = decodeU16(words);
  return raw > 0x7fff ? raw - 0x10000 : raw;
}

export function decodeU32(words: readonly number[]): number {
  const hi = (words[0] ?? 0) & 0xffff;
  const lo = (words[1] ?? 0) & 0xffff;
  return hi * 0x10000 + lo;
}

export function decodeS32(words: readonly number[]): number {
  const raw = decodeU32(words);
  return raw > 0x7fffffff ? raw - 0x100000000 : raw;
}

/** U64 as a bigint — JS `number` cannot safely hold the full 64-bit range. */
export function decodeU64(words: readonly number[]): bigint {
  let value = 0n;
  for (let i = 0; i < 4; i++) {
    value = (value << 16n) | BigInt((words[i] ?? 0) & 0xffff);
  }
  return value;
}

export function encodeU16(value: number): number[] {
  return [Math.trunc(value) & 0xffff];
}

export function encodeS16(value: number): number[] {
  const v = Math.trunc(value);
  const raw = v < 0 ? v + 0x10000 : v;
  return [raw & 0xffff];
}

export function encodeU32(value: number): number[] {
  const v = Math.trunc(value);
  return [Math.floor(v / 0x10000) & 0xffff, v & 0xffff];
}

export function encodeS32(value: number): number[] {
  const v = Math.trunc(value);
  const raw = v < 0 ? v + 0x100000000 : v;
  return encodeU32(raw);
}

export function encodeU64(value: bigint): number[] {
  return [
    Number((value >> 48n) & 0xffffn),
    Number((value >> 32n) & 0xffffn),
    Number((value >> 16n) & 0xffffn),
    Number(value & 0xffffn),
  ];
}

/** Decodes a register's raw words per its documented type (no gain applied). */
export function decodeWords(words: readonly number[], type: RegisterType): number | bigint {
  switch (type) {
    case "U16":
      return decodeU16(words);
    case "S16":
      return decodeS16(words);
    case "U32":
      return decodeU32(words);
    case "S32":
      return decodeS32(words);
    case "U64":
      return decodeU64(words);
  }
}

/** Encodes a raw value (already gain-applied, i.e. in register units) into words. */
export function encodeWords(raw: number, type: RegisterType): number[] {
  switch (type) {
    case "U16":
      return encodeU16(raw);
    case "S16":
      return encodeS16(raw);
    case "U32":
      return encodeU32(raw);
    case "S32":
      return encodeS32(raw);
    case "U64":
      return encodeU64(BigInt(Math.trunc(raw)));
  }
}

/**
 * Scaling ("Gain" column, docs/sigenergy-modbus.md §3): actual value = raw ÷ gain.
 * E.g. gain 1000 unit kW: raw is in watts. Gain 10 unit %: raw is tenths of a percent.
 */
export function scaleFromRaw(raw: number, gain: number): number {
  return gain === 1 ? raw : raw / gain;
}

export function scaleToRaw(value: number, gain: number): number {
  return Math.round(gain === 1 ? value : value * gain);
}

/** Decodes a register's words into its documented value (gain applied), e.g. kW, %. */
export function decodeRegisterValue(words: readonly number[], def: RegisterDef): number {
  const raw = decodeWords(words, def.type);
  const n = typeof raw === "bigint" ? Number(raw) : raw;
  return scaleFromRaw(n, def.gain);
}

/** Encodes a value already in the register's documented unit (e.g. kW, %) into words. */
export function encodeRegisterValue(valueInUnit: number, def: RegisterDef): number[] {
  return encodeWords(scaleToRaw(valueInUnit, def.gain), def.type);
}

/** Extracts one register's words out of a contiguous block read starting at `blockStart`. */
export function sliceRegister(
  blockWords: readonly number[],
  blockStart: number,
  def: RegisterDef,
): number[] {
  const offset = def.address - blockStart;
  if (offset < 0 || offset + def.length > blockWords.length) {
    throw new Error(
      `sliceRegister: ${def.name} (${def.address}..${def.address + def.length - 1}) is outside ` +
        `the read block [${blockStart}..${blockStart + blockWords.length - 1}]`,
    );
  }
  return blockWords.slice(offset, offset + def.length);
}

// ---------------------------------------------------------------------------
// Sign-normalisation boundary (design/db-schema.md conventions)
//
// design/db-schema.md fixes our app-wide convention: battery +charge/-discharge,
// grid +import/-export. docs/sigenergy-modbus.md §4 documents the Sigenergy wire
// convention for the same two quantities:
//   - [ESS] Power (30037): "<0 = discharging; >0 = charging"      -> matches ours
//   - [Grid sensor] Active power (30005): ">0 = import; <0 = export" -> matches ours
// So no sign *flip* is required today, but every telemetry read is still routed
// through these functions (called from client.ts, the single normalisation boundary)
// so the equivalence is explicit, auditable, and the seam exists if a future
// protocol revision or per-inverter register ever uses the opposite convention.
// ---------------------------------------------------------------------------

/** Converts ESS Power (kW, Sigenergy sign) to our battery_power_w (W, +charge/-discharge). */
export function normaliseBatteryPowerW(essPowerKw: number): number {
  return Math.round(essPowerKw * 1000);
}

/** Converts grid sensor active power (kW, Sigenergy sign) to our grid_power_w (W, +import/-export). */
export function normaliseGridPowerW(gridActivePowerKw: number): number {
  return Math.round(gridActivePowerKw * 1000);
}

// ---------------------------------------------------------------------------
// §4 Plant-level read registers (function code 0x03, slave address 247)
// ---------------------------------------------------------------------------

export const PLANT_REGISTERS = {
  EMS_WORK_MODE: reg({
    name: "EMS work mode",
    address: 30003,
    type: "U16",
    gain: 1,
    unit: "enum",
    access: "RO",
    fc: 3,
    comment: "0 Max self consumption; 1 AI Mode; 2 TOU; 5 Full Feed-in to Grid; 7 Remote EMS mode; 9 Custom",
  }),
  GRID_ACTIVE_POWER: reg({
    name: "[Grid sensor] Active power",
    address: 30005,
    type: "S32",
    gain: 1000,
    unit: "kW",
    access: "RO",
    fc: 3,
    comment: ">0 = buy from grid (import); <0 = sell to grid (export)",
  }),
  ESS_SOC: reg({
    name: "[ESS] SOC",
    address: 30014,
    type: "U16",
    gain: 10,
    unit: "%",
    access: "RO",
    fc: 3,
  }),
  PLANT_ACTIVE_POWER: reg({
    name: "Plant active power",
    address: 30031,
    type: "S32",
    gain: 1000,
    unit: "kW",
    access: "RO",
    fc: 3,
    comment: "Overall plant AC active power",
  }),
  PV_POWER: reg({
    name: "Photovoltaic power",
    address: 30035,
    type: "S32",
    gain: 1000,
    unit: "kW",
    access: "RO",
    fc: 3,
    comment: "Total PV power",
  }),
  ESS_POWER: reg({
    name: "[ESS] Power",
    address: 30037,
    type: "S32",
    gain: 1000,
    unit: "kW",
    access: "RO",
    fc: 3,
    comment: "<0 = discharging; >0 = charging",
  }),
  ESS_AVAILABLE_MAX_CHARGE_POWER: reg({
    name: "[ESS] Available max charging power",
    address: 30047,
    type: "U32",
    gain: 1000,
    unit: "kW",
    access: "RO",
    fc: 3,
    comment: "Running inverters only",
  }),
  ESS_AVAILABLE_MAX_DISCHARGE_POWER: reg({
    name: "[ESS] Available max discharging power",
    address: 30049,
    type: "U32",
    gain: 1000,
    unit: "kW",
    access: "RO",
    fc: 3,
    comment: "Running inverters only",
  }),
  PLANT_RUNNING_STATE: reg({
    name: "Plant running state",
    address: 30051,
    type: "U16",
    gain: 1,
    unit: "enum",
    access: "RO",
    fc: 3,
    comment: "See PLANT_RUNNING_STATE enum below (Appendix 1)",
  }),
  ESS_RATED_ENERGY_CAPACITY: reg({
    name: "[ESS] Rated energy capacity",
    address: 30083,
    type: "U32",
    gain: 100,
    unit: "kWh",
    access: "RO",
    fc: 3,
  }),
  ESS_CHARGE_CUTOFF_SOC_RO: reg({
    name: "[ESS] Charge Cut-Off SOC (read-only mirror)",
    address: 30085,
    type: "U16",
    gain: 10,
    unit: "%",
    access: "RO",
    fc: 3,
    comment: "Read-only mirror of the settable value at 40047",
  }),
  ESS_DISCHARGE_CUTOFF_SOC_RO: reg({
    name: "[ESS] Discharge Cut-Off SOC (read-only mirror)",
    address: 30086,
    type: "U16",
    gain: 10,
    unit: "%",
    access: "RO",
    fc: 3,
    comment: "Read-only mirror of the settable value at 40048",
  }),
  TOTAL_LOAD_POWER: reg({
    name: "Total load power",
    address: 30284,
    type: "S32",
    gain: 1000,
    unit: "kW",
    access: "RO",
    fc: 3,
    comment: "Added V2.8; whole-plant instantaneous load/consumption power",
  }),
} as const;

/**
 * Contiguous read block covering every PLANT_REGISTERS field used by readTelemetry()
 * except TOTAL_LOAD_POWER (added later in the register table, at address 30284, far
 * from the rest — see docs/sigenergy-modbus.md §4 Table 5-1 layout). Reading this as
 * one 49-register block instead of 7 separate requests keeps telemetry polling to two
 * round trips total.
 */
export const TELEMETRY_BLOCK_A = { start: 30003, length: 49 } as const;

// ---------------------------------------------------------------------------
// §7 Running state / EMS work mode enums (Appendix 1, brief)
// ---------------------------------------------------------------------------

export const EMS_WORK_MODE = {
  MaxSelfConsumption: 0,
  AiMode: 1,
  Tou: 2,
  FullFeedInToGrid: 5,
  RemoteEms: 7,
  Custom: 9,
} as const;

/** Shared by plant running state (30051) and per-inverter running state (30578). */
export const PLANT_RUNNING_STATE = {
  Standby: 0x00,
  Running: 0x01,
  Fault: 0x02,
  Shutdown: 0x03,
  EnvironmentalAbnormality: 0x07,
} as const;

// ---------------------------------------------------------------------------
// §6 Remote EMS control registers (writes) — function code 0x04 to read,
// 0x06 (single register) / 0x10 (multiple) to write, slave 247 or broadcast 0.
// ---------------------------------------------------------------------------

export const CONTROL_REGISTERS = {
  START_STOP: reg({
    name: "Start/Stop",
    address: 40000,
    type: "U16",
    gain: 1,
    unit: "enum",
    access: "WO",
    fc: 4,
    comment: "0: Stop; 1: Start. Only meaningful in control mode 0x00 (PCS remote control)",
  }),
  ACTIVE_POWER_FIXED_TARGET: reg({
    name: "Active power fixed adjustment target value",
    address: 40001,
    type: "S32",
    gain: 1000,
    unit: "kW",
    access: "RW",
    fc: 4,
    comment:
      "Global PCS active-power setpoint; effective only when 40029=1 and 40031=0x00 (PCS remote " +
      "control). Bypasses load/grid netting entirely, so it is not used for setChargePowerW/" +
      "setDischargePowerW below — see the comment on those methods in client.ts.",
  }),
  REMOTE_EMS_ENABLE: reg({
    name: "Remote EMS enable",
    address: 40029,
    type: "U16",
    gain: 1,
    unit: "enum",
    access: "RW",
    fc: 4,
    comment: "0: disabled; 1: enabled. When enabled, plant EMS work mode (30003) switches to 7",
  }),
  INDEPENDENT_PHASE_CONTROL_ENABLE: reg({
    name: "Independent phase power control enable",
    address: 40030,
    type: "U16",
    gain: 1,
    unit: "enum",
    access: "RW",
    fc: 4,
    comment: "0: disabled; 1: enabled. Not used by this client (no per-phase control implemented)",
  }),
  REMOTE_EMS_CONTROL_MODE: reg({
    name: "Remote EMS control mode",
    address: 40031,
    type: "U16",
    gain: 1,
    unit: "enum",
    access: "RW",
    fc: 4,
    comment: "See REMOTE_EMS_CONTROL_MODE enum below (Appendix 6)",
  }),
  ESS_MAX_CHARGE_LIMIT: reg({
    name: "[ESS] max charging limit",
    address: 40032,
    type: "U32",
    gain: 1000,
    unit: "kW",
    access: "RW",
    fc: 4,
    comment: "Range [0, rated ESS charging power]. Effective when control mode (40031) = 3 or 4",
  }),
  ESS_MAX_DISCHARGE_LIMIT: reg({
    name: "[ESS] max discharging limit",
    address: 40034,
    type: "U32",
    gain: 1000,
    unit: "kW",
    access: "RW",
    fc: 4,
    comment: "Range [0, rated ESS discharging power]. Effective when control mode (40031) = 5 or 6",
  }),
  PV_MAX_POWER_LIMIT: reg({
    name: "PV max power limit",
    address: 40036,
    type: "U32",
    gain: 1000,
    unit: "kW",
    access: "RW",
    fc: 4,
    comment: "Effective when control mode (40031) is one of {3,4,5,6}",
  }),
  GRID_MAX_EXPORT_LIMIT: reg({
    name: "[Grid Point] Max export limitation",
    address: 40038,
    type: "U32",
    gain: 1000,
    unit: "kW",
    access: "RW",
    fc: 4,
    comment: "Requires a grid sensor; takes effect globally regardless of EMS mode",
  }),
  GRID_MAX_IMPORT_LIMIT: reg({
    name: "[Grid Point] Max import limitation",
    address: 40040,
    type: "U32",
    gain: 1000,
    unit: "kW",
    access: "RW",
    fc: 4,
    comment: "Requires a grid sensor; takes effect globally regardless of EMS mode",
  }),
  PCS_MAX_EXPORT_LIMIT: reg({
    name: "PCS maximum export limitation",
    address: 40042,
    type: "U32",
    gain: 1000,
    unit: "kW",
    access: "RW",
    fc: 4,
    comment: "0xFFFFFFFF = register not active; takes effect globally",
  }),
  PCS_MAX_IMPORT_LIMIT: reg({
    name: "PCS maximum import limitation",
    address: 40044,
    type: "U32",
    gain: 1000,
    unit: "kW",
    access: "RW",
    fc: 4,
    comment: "0xFFFFFFFF = register not active; takes effect globally",
  }),
  ESS_BACKUP_SOC: reg({
    name: "[ESS] Backup SOC",
    address: 40046,
    type: "U16",
    gain: 10,
    unit: "%",
    access: "RW",
    fc: 4,
    comment: "Range [0, 100.0] — minimum reserve SOC",
  }),
  ESS_CHARGE_CUTOFF_SOC: reg({
    name: "[ESS] Charge Cut-Off SOC",
    address: 40047,
    type: "U16",
    gain: 10,
    unit: "%",
    access: "RW",
    fc: 4,
    comment: "Range [0, 100.0]",
  }),
  ESS_DISCHARGE_CUTOFF_SOC: reg({
    name: "[ESS] Discharge Cut-Off SOC",
    address: 40048,
    type: "U16",
    gain: 10,
    unit: "%",
    access: "RW",
    fc: 4,
    comment: "Range [0, 100.0]",
  }),
} as const;

/** SOC-limit registers are contiguous (40046-40048) — one 3-register read. */
export const SOC_LIMITS_BLOCK = { start: 40046, length: 3 } as const;

// ---------------------------------------------------------------------------
// §6.2 Remote EMS control mode enum (register 40031) — Appendix 6
// ---------------------------------------------------------------------------

export const REMOTE_EMS_CONTROL_MODE = {
  /** Enables the fixed/percentage power-dispatch registers (40001 etc.) */
  PcsRemoteControl: 0x00,
  Standby: 0x01,
  /** Hand control back to "normal" self-consumption behaviour while staying in remote-EMS mode. */
  MaxSelfConsumption: 0x02,
  /** Charge limit register 40032 takes effect in modes 0x03/0x04. */
  CommandChargingGridFirst: 0x03,
  CommandChargingPvFirst: 0x04,
  /** Discharge limit register 40034 takes effect in modes 0x05/0x06. */
  CommandDischargingPvFirst: 0x05,
  CommandDischargingEssFirst: 0x06,
  /** Reserved, added V2.9 (previously undefined). */
  Reserved: 0x07,
  /** Vehicle to Grid, added V2.9. */
  V2G: 0x08,
} as const;

export type RemoteEmsControlMode =
  (typeof REMOTE_EMS_CONTROL_MODE)[keyof typeof REMOTE_EMS_CONTROL_MODE];
