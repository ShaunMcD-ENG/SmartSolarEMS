/** Horizontal SOC bar with a marker for the configured minimum reserve floor. */
export function BatteryBar({ socPct, reservePct }: { socPct: number | null; reservePct: number | null }) {
  const pct = socPct === null ? 0 : Math.max(0, Math.min(100, socPct));
  return (
    <div className="battery-bar" title={socPct === null ? "No data" : `${socPct.toFixed(1)}% state of charge`}>
      <div className="battery-bar-fill" style={{ width: `${pct}%` }} />
      {reservePct !== null && reservePct > 0 && reservePct < 100 && (
        <div
          className="battery-bar-reserve"
          style={{ left: `${reservePct}%` }}
          title={`Minimum reserve: ${reservePct}%`}
        />
      )}
    </div>
  );
}
