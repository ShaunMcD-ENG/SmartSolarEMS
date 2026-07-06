/**
 * Typed fetch wrapper for the SmartSolarEMS REST API (src/server/api.ts).
 * Every function here maps 1:1 to a route registered by registerApiRoutes().
 * Row/value shapes mirror the server's types exactly (snake_case for DB rows,
 * camelCase for settings values) rather than re-mapping field names.
 */

// ---------------------------------------------------------------------------
// Error normalisation
// ---------------------------------------------------------------------------

/** Thrown for any non-2xx response; carries the server's `{ error, detail? }` body. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: unknown;
  /** Present only for the overrides 409 demand-window-conflict response. */
  readonly demandWindow?: DemandWindow;

  constructor(status: number, code: string, detail?: unknown, demandWindow?: DemandWindow) {
    super(code);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.demandWindow = demandWindow;
  }
}

/** Extracts a human-readable message from an ApiRequestError (zod issues, or the error code). */
export function apiErrorMessage(err: unknown): string {
  if (err instanceof ApiRequestError) {
    if (Array.isArray(err.detail)) {
      const issues = err.detail as { message?: string; path?: (string | number)[] }[];
      const parts = issues
        .map((i) => (i.path && i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message))
        .filter(Boolean);
      if (parts.length > 0) return parts.join("; ");
    }
    if (typeof err.detail === "string") return `${err.code}: ${err.detail}`;
    return humanizeCode(err.code);
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

function humanizeCode(code: string): string {
  return code.replace(/_/g, " ");
}

let unauthorizedHandler: (() => void) | null = null;
/** Registered once by App.tsx; called whenever any request comes back 401. */
export function onUnauthorized(fn: () => void): void {
  unauthorizedHandler = fn;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });

  const text = await res.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    if (res.status === 401) unauthorizedHandler?.();
    const b = (body ?? {}) as { error?: string; detail?: unknown; demandWindow?: DemandWindow };
    throw new ApiRequestError(res.status, b.error ?? `http_${res.status}`, b.detail, b.demandWindow);
  }

  return body as T;
}

function get<T>(path: string): Promise<T> {
  return request<T>(path, { method: "GET" });
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: "POST", body: body !== undefined ? JSON.stringify(body) : undefined });
}

function put<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "PUT", body: JSON.stringify(body) });
}

function qs(params: Record<string, string | undefined>): string {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) search.set(k, v);
  }
  const s = search.toString();
  return s.length > 0 ? `?${s}` : "";
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface AuthStatus {
  firstBoot: boolean;
  authenticated: boolean;
}

export const authApi = {
  status: (): Promise<AuthStatus> => get("/api/auth/status"),
  setup: (password: string): Promise<{ ok: true }> => post("/api/setup", { password }),
  login: (password: string): Promise<{ ok: true }> => post("/api/login", { password }),
  logout: (): Promise<{ ok: true }> => post("/api/logout"),
};

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export interface PollerStatus {
  running: boolean;
  lastSuccess: string | null;
  lastError: string | null;
}

/** Present once src/index.ts wires up the executor (Phase 6); absent (null) until then. */
export interface ExecutorStatus {
  running: boolean;
  mode: "shadow" | "active";
  lastTick: string | null;
  lastAction: string | null;
  lastError: string | null;
  consecutiveModbusFailures: number;
  failSafeEngaged: boolean;
}

export interface SystemStatus {
  mode: "shadow" | "active";
  modbus: PollerStatus;
  amber: PollerStatus;
  executor?: ExecutorStatus | null;
  db: { ok: boolean };
  version: string;
  uptime: number;
}

export const statusApi = {
  get: (): Promise<SystemStatus> => get("/api/status"),
};

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

export interface TelemetryRow {
  time: string;
  pv_power_w: number | null;
  battery_power_w: number | null;
  battery_soc_pct: number | null;
  grid_power_w: number | null;
  load_power_w: number | null;
  ems_mode: number | null;
  extra: unknown;
}

export interface Telemetry5mRow {
  bucket: string;
  pv_power_w_avg: number | null;
  battery_power_w_avg: number | null;
  grid_power_w_avg: number | null;
  load_power_w_avg: number | null;
  battery_soc_pct_avg: number | null;
  battery_soc_pct_last: number | null;
  pv_energy_wh: number | null;
  battery_energy_wh: number | null;
  grid_energy_wh: number | null;
  load_energy_wh: number | null;
}

export const telemetryApi = {
  raw: (from: Date, to: Date): Promise<{ res: "raw"; rows: TelemetryRow[] }> =>
    get(`/api/telemetry${qs({ from: from.toISOString(), to: to.toISOString(), res: "raw" })}`),
  fiveMin: (from: Date, to: Date): Promise<{ res: "5m"; rows: Telemetry5mRow[] }> =>
    get(`/api/telemetry${qs({ from: from.toISOString(), to: to.toISOString(), res: "5m" })}`),
};

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

export type PriceChannel = "general" | "feedIn" | "controlledLoad";

export interface PriceRow {
  interval_start: string;
  channel: string;
  per_kwh: number;
  spot_per_kwh: number | null;
  renewables: number | null;
  spike_status: string | null;
  interval_type: string;
  estimate: boolean | null;
  updated_at: string;
}

export const pricesApi = {
  between: (from: Date, to: Date, channel: PriceChannel = "general"): Promise<{ rows: PriceRow[] }> =>
    get(`/api/prices${qs({ from: from.toISOString(), to: to.toISOString(), channel })}`),
};

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export type PlanSlotAction =
  | "charge_solar"
  | "charge_grid"
  | "discharge_load"
  | "discharge_grid"
  | "idle"
  | "self_consume";

export interface PlanSlotRow {
  slot_start: string;
  action: PlanSlotAction;
  battery_power_w: number | null;
  expected_soc_pct: number | null;
  buy_price: number | null;
  sell_price: number | null;
  expected_load_wh: number | null;
  expected_solar_wh: number | null;
  expected_grid_wh: number | null;
  reason: string | null;
  /** Structured pin/protection info (backend migration 005); optional for older stored plans. */
  pinned_override_id?: number | null;
  demand_window_protected?: boolean | null;
}

export interface PlanWithSlots {
  id: number;
  created_at: string;
  mode: string;
  current_soc_pct: number | null;
  objective_cost_cents: number | null;
  summary: unknown;
  slots: PlanSlotRow[];
}

export const planApi = {
  latest: (): Promise<{ plan: PlanWithSlots | null }> => get("/api/plan/latest"),
};

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

export interface DecisionRow {
  time: string;
  slot_start: string | null;
  mode: "shadow" | "active";
  action: string | null;
  battery_power_w: number | null;
  soc_pct: number | null;
  plan_id: number | null;
  reason: string | null;
  executed: boolean | null;
  error: string | null;
}

export const decisionsApi = {
  between: (from: Date, to: Date): Promise<{ rows: DecisionRow[] }> =>
    get(`/api/decisions${qs({ from: from.toISOString(), to: to.toISOString() })}`),
};

// ---------------------------------------------------------------------------
// Forecast accuracy
// ---------------------------------------------------------------------------

export type HorizonBucket = "0-1h" | "1-4h" | "4-12h" | "12-24h";

export interface HorizonBucketAccuracy {
  n: number;
  mape: number | null;
  biasWh: number | null;
}

export interface AccuracyResult {
  load: Record<HorizonBucket, HorizonBucketAccuracy>;
  solar: Record<HorizonBucket, HorizonBucketAccuracy>;
}

export const forecastApi = {
  accuracy: (from: Date, to: Date): Promise<AccuracyResult> =>
    get(`/api/forecast/accuracy${qs({ from: from.toISOString(), to: to.toISOString() })}`),
};

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface SigenergySettings {
  host: string;
  port: number;
  plantUnitId: number;
  inverterUnitId: number;
  pollIntervalMs: number;
}

export interface AmberSettings {
  apiToken: string;
  siteId: string;
  pollIntervalMs: number;
}

export interface BatterySettings {
  capacityWh: number;
  usableMinSocPct: number;
  maxChargeW: number;
  maxDischargeW: number;
  roundTripEfficiency: number;
}

export interface SocTarget {
  time: string;
  socPct: number;
}

export interface GoalsSettings {
  maxCyclesPerDay: number;
  socTargets: SocTarget[];
  minCommandWindowMin: number;
}

export interface DemandWindow {
  enabled: boolean;
  start: string;
  end: string;
  bufferMin: number;
}

export interface ModeSettings {
  shadow: boolean;
}

export interface PricingSettings {
  spikeSellThreshold?: number;
}

export interface SettingsBundle {
  sigenergy: SigenergySettings | null;
  battery: BatterySettings | null;
  goals: GoalsSettings | null;
  demandWindow: DemandWindow | null;
  mode: ModeSettings | null;
  pricing: PricingSettings | null;
  /** apiToken is masked ("•••abcd") by the server, never the real value. */
  amber: AmberSettings | null;
  adminPasswordSet: boolean;
}

export type SettingsKey = "sigenergy" | "amber" | "battery" | "goals" | "demandWindow" | "mode" | "pricing";

export const settingsApi = {
  getAll: (): Promise<SettingsBundle> => get("/api/settings"),
  put: <T>(key: SettingsKey, value: T): Promise<{ ok: true }> => put(`/api/settings/${key}`, value),
  putMode: (shadow: boolean, confirm?: string): Promise<{ ok: true }> =>
    put("/api/settings/mode", { shadow, ...(confirm ? { confirm } : {}) }),
};

// ---------------------------------------------------------------------------
// Overrides
// ---------------------------------------------------------------------------

export type OverrideAction = "charge" | "discharge" | "self_consume" | "idle";
export type OverrideStatus = "pending" | "active" | "completed" | "cancelled" | "expired";

export interface OverrideRow {
  id: number;
  created_at: string;
  start_time: string;
  end_time: string | null;
  action: OverrideAction;
  energy_wh: number | null;
  power_w: number | null;
  override_demand_window: boolean;
  status: OverrideStatus;
  note: string | null;
}

export interface OverrideCreateInput {
  start_time: string;
  end_time?: string | null;
  action: OverrideAction;
  energy_wh?: number | null;
  power_w?: number | null;
  note?: string | null;
  override_demand_window?: boolean;
}

export const overridesApi = {
  list: (statuses?: OverrideStatus[]): Promise<{ rows: OverrideRow[] }> =>
    get(`/api/overrides${qs({ status: statuses && statuses.length > 0 ? statuses.join(",") : undefined })}`),
  create: (input: OverrideCreateInput): Promise<OverrideRow> => post("/api/overrides", input),
  cancel: (id: number): Promise<{ ok: true }> => post(`/api/overrides/${id}/cancel`),
};
