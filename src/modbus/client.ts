import ModbusRTU from "modbus-serial";
import { createLogger } from "../lib/logger";
import {
  CONTROL_REGISTERS,
  decodeRegisterValue,
  encodeRegisterValue,
  normaliseBatteryPowerW,
  normaliseGridPowerW,
  PLANT_REGISTERS,
  REMOTE_EMS_CONTROL_MODE,
  SOC_LIMITS_BLOCK,
  sliceRegister,
  TELEMETRY_BLOCK_A,
  type RegisterDef,
  type RemoteEmsControlMode,
} from "./registers";

const log = createLogger("modbus-client");

export interface SigenergyClientConfig {
  host: string;
  port: number;
  /** Plant/slave address for aggregate reads and all remote-EMS control registers (usually 247). */
  plantUnitId: number;
  /** Reserved for future per-inverter register reads; unused by the methods below. */
  inverterUnitId?: number;
  /** Per-request timeout in ms. Default 5000. */
  timeoutMs?: number;
  /** Initial reconnect backoff in ms. Default 1000. */
  baseBackoffMs?: number;
  /** Reconnect backoff ceiling in ms. Default 30000. */
  maxBackoffMs?: number;
}

export interface Telemetry {
  pvPowerW: number;
  /** +charge / -discharge, per design/db-schema.md convention. */
  batteryPowerW: number;
  batterySocPct: number;
  /** +import / -export, per design/db-schema.md convention. */
  gridPowerW: number;
  loadPowerW: number;
  emsMode: number;
  runningState: number;
}

export interface SocLimits {
  backupSocPct: number;
  chargeCutoffSocPct: number;
  dischargeCutoffSocPct: number;
}

export interface RatedEnergy {
  ratedEnergyWh: number;
}

/**
 * Minimal surface of `modbus-serial`'s ModbusRTU this client depends on. Declared as
 * an interface (rather than importing the concrete class type) so tests can inject a
 * fake transport without subclassing ModbusRTU or opening a real socket. The real
 * `ModbusRTU` class satisfies this structurally.
 */
export interface ModbusTransport {
  isOpen: boolean;
  connectTCP(ip: string, options: { port: number }): Promise<void>;
  close(callback?: () => void): void;
  setID(id: number): void;
  setTimeout(durationMs: number): void;
  readHoldingRegisters(dataAddress: number, length: number): Promise<{ data: number[] }>;
  readInputRegisters(dataAddress: number, length: number): Promise<{ data: number[] }>;
  writeRegister(dataAddress: number, value: number): Promise<{ address: number; value: number }>;
  writeRegisters(dataAddress: number, values: number[]): Promise<{ address: number; length: number }>;
  on(event: "close" | "error", listener: (...args: unknown[]) => void): unknown;
}

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_BASE_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 30000;

/**
 * Sigenergy Modbus TCP client. Wraps a `ModbusTransport` (real `modbus-serial`
 * ModbusRTU by default) with: connect/disconnect, capped-exponential-backoff
 * auto-reconnect, a per-request timeout, and a serialised request queue (Modbus TCP
 * is strictly request/response — the underlying protocol is not concurrent-safe even
 * over a single TCP connection).
 *
 * Settings (host/port/unit ids) are supplied by the caller at construction time; this
 * class never reads the settings service itself (see design/planner.md Executor
 * section and the phase task list — wiring happens one layer up).
 */
export class SigenergyClient {
  private readonly transport: ModbusTransport;
  private readonly config: Required<Omit<SigenergyClientConfig, "inverterUnitId">> &
    Pick<SigenergyClientConfig, "inverterUnitId">;

  /** Serialises every transport call so requests never overlap on the wire. */
  private queue: Promise<void> = Promise.resolve();

  private manualDisconnect = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs: number;

  constructor(config: SigenergyClientConfig, transport?: ModbusTransport) {
    this.config = {
      host: config.host,
      port: config.port,
      plantUnitId: config.plantUnitId,
      inverterUnitId: config.inverterUnitId,
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      baseBackoffMs: config.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS,
      maxBackoffMs: config.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS,
    };
    this.reconnectDelayMs = this.config.baseBackoffMs;
    // Real modbus-serial ModbusRTU is a structural superset of ModbusTransport; cast
    // through unknown rather than relying on TS to verify the (looser) upstream types.
    this.transport = transport ?? (new ModbusRTU() as unknown as ModbusTransport);

    this.transport.on("close", () => {
      log.warn("modbus connection closed");
      if (!this.manualDisconnect) this.scheduleReconnect();
    });
    this.transport.on("error", (err: unknown) => {
      log.warn("modbus transport error", { error: String(err) });
    });
  }

  /** Opens the TCP connection; subsequent unexpected drops trigger auto-reconnect. */
  async connect(): Promise<void> {
    this.manualDisconnect = false;
    await this.doConnect();
  }

  /** Closes the connection and cancels any pending reconnect attempt. */
  disconnect(): void {
    this.manualDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.transport.close();
  }

  get connected(): boolean {
    return this.transport.isOpen;
  }

  private async doConnect(): Promise<void> {
    if (this.transport.isOpen) return;
    try {
      await this.transport.connectTCP(this.config.host, { port: this.config.port });
      this.transport.setTimeout(this.config.timeoutMs);
      this.reconnectDelayMs = this.config.baseBackoffMs;
      log.info("connected", { host: this.config.host, port: this.config.port });
    } catch (err) {
      log.error("connect failed", { host: this.config.host, port: this.config.port, error: String(err) });
      this.scheduleReconnect();
      throw err;
    }
  }

  private scheduleReconnect(): void {
    if (this.manualDisconnect || this.reconnectTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.config.maxBackoffMs);
      this.doConnect().catch(() => {
        // doConnect() already logged and re-scheduled; swallow here so this timer
        // callback (not awaited by anyone) never surfaces an unhandled rejection.
      });
    }, delay);
  }

  /** Runs `fn` after the pending request completes (serialised) and under a timeout. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = (): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`modbus request timed out after ${this.config.timeoutMs}ms`));
        }, this.config.timeoutMs);
        fn().then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          (err) => {
            clearTimeout(timer);
            reject(err);
          },
        );
      });

    const result = this.queue.then(run, run);
    // Keep the chain alive regardless of this request's outcome; callers still see
    // the real rejection via `result`.
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async readWords(address: number, length: number, fc: 3 | 4): Promise<number[]> {
    return this.enqueue(async () => {
      if (!this.transport.isOpen) await this.doConnect();
      this.transport.setID(this.config.plantUnitId);
      const result =
        fc === 3
          ? await this.transport.readHoldingRegisters(address, length)
          : await this.transport.readInputRegisters(address, length);
      return result.data;
    });
  }

  private async readRegister(def: RegisterDef): Promise<number> {
    const words = await this.readWords(def.address, def.length, def.fc);
    return decodeRegisterValue(words, def);
  }

  private async writeRegister(def: RegisterDef, valueInUnit: number): Promise<void> {
    const words = encodeRegisterValue(valueInUnit, def);
    await this.enqueue(async () => {
      if (!this.transport.isOpen) await this.doConnect();
      this.transport.setID(this.config.plantUnitId);
      if (words.length === 1) {
        await this.transport.writeRegister(def.address, words[0]!);
      } else {
        await this.transport.writeRegisters(def.address, words);
      }
    });
  }

  /**
   * Writes `valueInUnit` to `def` then reads it back to confirm the device accepted
   * it, since docs/sigenergy-modbus.md §8 notes the protocol defines no
   * heartbeat/watchdog or write-acknowledgement beyond the transport-level Modbus
   * response (UNVERIFIED whether the device does any further validation) — treat
   * every control write as unconfirmed until read-back matches.
   */
  private async writeAndVerify(
    def: RegisterDef,
    valueInUnit: number,
    toleranceUnits = 0.5 / def.gain,
  ): Promise<boolean> {
    await this.writeRegister(def, valueInUnit);
    const actual = await this.readRegister(def);
    const ok = Math.abs(actual - valueInUnit) <= toleranceUnits;
    if (!ok) {
      log.warn("write read-back verification failed", {
        register: def.name,
        expected: valueInUnit,
        actual,
      });
    }
    return ok;
  }

  /**
   * Reads all plant telemetry in two batched round trips: PLANT_REGISTERS.EMS_WORK_MODE
   * through PLANT_REGISTERS.PLANT_RUNNING_STATE are contiguous (TELEMETRY_BLOCK_A,
   * addresses 30003-30051) and TOTAL_LOAD_POWER (30284, added in a later protocol
   * revision, table 5-1) is read separately.
   */
  async readTelemetry(): Promise<Telemetry> {
    const blockA = await this.readWords(TELEMETRY_BLOCK_A.start, TELEMETRY_BLOCK_A.length, 3);
    const blockB = await this.readWords(
      PLANT_REGISTERS.TOTAL_LOAD_POWER.address,
      PLANT_REGISTERS.TOTAL_LOAD_POWER.length,
      PLANT_REGISTERS.TOTAL_LOAD_POWER.fc,
    );

    const pick = (def: RegisterDef): number =>
      decodeRegisterValue(sliceRegister(blockA, TELEMETRY_BLOCK_A.start, def), def);

    const pvKw = pick(PLANT_REGISTERS.PV_POWER);
    const essKw = pick(PLANT_REGISTERS.ESS_POWER);
    const gridKw = pick(PLANT_REGISTERS.GRID_ACTIVE_POWER);
    const loadKw = decodeRegisterValue(
      sliceRegister(blockB, PLANT_REGISTERS.TOTAL_LOAD_POWER.address, PLANT_REGISTERS.TOTAL_LOAD_POWER),
      PLANT_REGISTERS.TOTAL_LOAD_POWER,
    );

    return {
      pvPowerW: Math.round(pvKw * 1000),
      batteryPowerW: normaliseBatteryPowerW(essKw),
      batterySocPct: pick(PLANT_REGISTERS.ESS_SOC),
      gridPowerW: normaliseGridPowerW(gridKw),
      loadPowerW: Math.round(loadKw * 1000),
      emsMode: pick(PLANT_REGISTERS.EMS_WORK_MODE),
      runningState: pick(PLANT_REGISTERS.PLANT_RUNNING_STATE),
    };
  }

  /** Reads backup/charge-cutoff/discharge-cutoff SOC in one 3-register block (40046-40048). */
  async readSocLimits(): Promise<SocLimits> {
    const words = await this.readWords(SOC_LIMITS_BLOCK.start, SOC_LIMITS_BLOCK.length, 4);
    const pick = (def: RegisterDef): number =>
      decodeRegisterValue(sliceRegister(words, SOC_LIMITS_BLOCK.start, def), def);
    return {
      backupSocPct: pick(CONTROL_REGISTERS.ESS_BACKUP_SOC),
      chargeCutoffSocPct: pick(CONTROL_REGISTERS.ESS_CHARGE_CUTOFF_SOC),
      dischargeCutoffSocPct: pick(CONTROL_REGISTERS.ESS_DISCHARGE_CUTOFF_SOC),
    };
  }

  /** Reads plant rated ESS energy capacity (30083), if the firmware exposes it. */
  async readRatedEnergy(): Promise<RatedEnergy> {
    const kWh = await this.readRegister(PLANT_REGISTERS.ESS_RATED_ENERGY_CAPACITY);
    return { ratedEnergyWh: Math.round(kWh * 1000) };
  }

  // -------------------------------------------------------------------------
  // Control methods (§6). Not called by any code yet — wired up by the executor
  // (design/planner.md Executor section) once shadow-mode validation is complete.
  // Every write is followed by a read-back verification per writeAndVerify() above.
  // -------------------------------------------------------------------------

  /** Enables/disables remote EMS control (register 40029). */
  async enableRemoteEms(on: boolean): Promise<boolean> {
    return this.writeAndVerify(CONTROL_REGISTERS.REMOTE_EMS_ENABLE, on ? 1 : 0);
  }

  /** Sets the remote EMS control mode (register 40031, see REMOTE_EMS_CONTROL_MODE). */
  async setControlMode(mode: RemoteEmsControlMode): Promise<boolean> {
    return this.writeAndVerify(CONTROL_REGISTERS.REMOTE_EMS_CONTROL_MODE, mode);
  }

  /**
   * Commands the ESS to charge at up to `watts` (>= 0).
   *
   * docs/sigenergy-modbus.md §6.4 documents a global fixed active-power setpoint
   * (register 40001, mode 0x00 "PCS remote control") but that mode explicitly
   * bypasses load/grid netting ("these registers only control PCS power —
   * independent of loads and grid sensors"), which is the wrong tool for a
   * home-battery dispatch client: we want the inverter to keep netting against
   * actual solar/load and only cap the ESS's own charge power. So this method uses
   * "Command charging (consume PV power first)" (mode 0x04) plus the ESS max
   * charging limit (register 40032), which §6.3 documents as taking effect
   * specifically in modes 0x03/0x04. PV-first is chosen as the default sub-mode to
   * match this project's solar-first goal (see progress.md); callers needing
   * grid-first charging should call setControlMode(CommandChargingGridFirst)
   * followed by writing the limit directly via a future dedicated method.
   */
  async setChargePowerW(watts: number): Promise<boolean> {
    if (watts < 0) {
      throw new Error("setChargePowerW: watts must be >= 0 (use setDischargePowerW to discharge)");
    }
    const modeOk = await this.setControlMode(REMOTE_EMS_CONTROL_MODE.CommandChargingPvFirst);
    if (!modeOk) return false;
    return this.writeAndVerify(CONTROL_REGISTERS.ESS_MAX_CHARGE_LIMIT, watts / 1000);
  }

  /**
   * Commands the ESS to discharge at up to `watts` (>= 0). Uses "Command
   * discharging (output from ESS first)" (mode 0x06) plus the ESS max discharging
   * limit (register 40034) — see the setChargePowerW() comment for why the global
   * fixed-power register (40001) is deliberately not used here.
   */
  async setDischargePowerW(watts: number): Promise<boolean> {
    if (watts < 0) {
      throw new Error("setDischargePowerW: watts must be >= 0 (use setChargePowerW to charge)");
    }
    const modeOk = await this.setControlMode(REMOTE_EMS_CONTROL_MODE.CommandDischargingEssFirst);
    if (!modeOk) return false;
    return this.writeAndVerify(CONTROL_REGISTERS.ESS_MAX_DISCHARGE_LIMIT, watts / 1000);
  }
}
