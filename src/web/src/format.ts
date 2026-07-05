/** Formatting helpers shared across views. Times are always rendered in the browser's local timezone. */

/** Watts -> "1.23 kW" (2 decimals), the standard power display unit across the app. */
export function formatKW(watts: number | null | undefined): string {
  if (watts === null || watts === undefined || Number.isNaN(watts)) return "--";
  return `${(watts / 1000).toFixed(2)} kW`;
}

/** Watts -> signed kW, for flows where sign carries meaning (battery/grid) but is shown separately via a label. */
export function formatKWAbs(watts: number | null | undefined): string {
  if (watts === null || watts === undefined || Number.isNaN(watts)) return "--";
  return `${(Math.abs(watts) / 1000).toFixed(2)} kW`;
}

export function formatWh(wh: number | null | undefined): string {
  if (wh === null || wh === undefined || Number.isNaN(wh)) return "--";
  return `${(wh / 1000).toFixed(2)} kWh`;
}

export function formatPct(pct: number | null | undefined, digits = 1): string {
  if (pct === null || pct === undefined || Number.isNaN(pct)) return "--";
  return `${pct.toFixed(digits)}%`;
}

export function formatCents(centsPerKwh: number | null | undefined): string {
  if (centsPerKwh === null || centsPerKwh === undefined || Number.isNaN(centsPerKwh)) return "--";
  return `${centsPerKwh.toFixed(1)}c/kWh`;
}

export function formatTime(iso: string | Date | null | undefined): string {
  if (!iso) return "--";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "--";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function formatDateTime(iso: string | Date | null | undefined): string {
  if (!iso) return "--";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "--";
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatRelative(iso: string | Date | null | undefined): string {
  if (!iso) return "never";
  const d = typeof iso === "string" ? new Date(iso) : iso;
  if (Number.isNaN(d.getTime())) return "never";
  const diffMs = Date.now() - d.getTime();
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 5) return "just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 48) return `${diffHr}h ago`;
  return `${Math.round(diffHr / 24)}d ago`;
}

/** For <input type="datetime-local">: local-time value with no timezone suffix. */
export function toDatetimeLocalValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
