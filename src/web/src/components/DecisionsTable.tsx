import type { DecisionRow } from "../api";
import { formatDateTime, formatKWAbs, formatPct } from "../format";
import { EmptyBlock } from "./StateBlock";

export function DecisionsTable({ rows }: { rows: DecisionRow[] }) {
  if (rows.length === 0) {
    return (
      <EmptyBlock>
        <p>No decisions logged yet.</p>
        <p className="muted">Once the executor runs (Phase 6), each 5-minute tick will appear here.</p>
      </EmptyBlock>
    );
  }

  const sorted = [...rows].sort((a, b) => new Date(b.time).getTime() - new Date(a.time).getTime());

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Action</th>
            <th>Power</th>
            <th>SOC</th>
            <th>Mode</th>
            <th>Executed</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((d) => (
            <tr key={d.time}>
              <td>{formatDateTime(d.time)}</td>
              <td>{d.action ?? "--"}</td>
              <td>{formatKWAbs(d.battery_power_w)}</td>
              <td>{formatPct(d.soc_pct)}</td>
              <td>
                <span className={`chip ${d.mode === "shadow" ? "chip-pending" : "chip-active"}`}>{d.mode}</span>
              </td>
              <td>
                {d.executed === null ? "--" : d.executed ? "yes" : "no"}
                {d.error && <span className="muted"> ({d.error})</span>}
              </td>
              <td className="muted">{d.reason ?? "--"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
