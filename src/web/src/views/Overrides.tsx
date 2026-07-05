import { useState } from "react";
import { apiErrorMessage, overridesApi, type OverrideRow } from "../api";
import { useAsync } from "../hooks";
import { formatDateTime, formatKW, formatWh } from "../format";
import { OverrideForm } from "../components/OverrideForm";
import { ErrorBlock, LoadingBlock, EmptyBlock } from "../components/StateBlock";
import { useToast } from "../toast";

const CHIP_CLASS: Record<OverrideRow["status"], string> = {
  pending: "chip-pending",
  active: "chip-active",
  completed: "chip-completed",
  cancelled: "chip-cancelled",
  expired: "chip-expired",
};

export function Overrides() {
  const overrides = useAsync(() => overridesApi.list(), []);
  const toast = useToast();
  const [cancellingId, setCancellingId] = useState<number | null>(null);

  async function cancel(id: number) {
    setCancellingId(id);
    try {
      await overridesApi.cancel(id);
      toast.push("success", `Override #${id} cancelled.`);
      overrides.reload();
    } catch (err) {
      toast.push("error", apiErrorMessage(err));
    } finally {
      setCancellingId(null);
    }
  }

  return (
    <div>
      <div className="view-header">
        <h1>Overrides</h1>
      </div>

      <OverrideForm onCreated={overrides.reload} />

      <section className="card" style={{ marginTop: "1rem" }}>
        <div className="card-title-row">
          <h2>Current &amp; past overrides</h2>
        </div>
        {overrides.loading && !overrides.data ? (
          <LoadingBlock />
        ) : overrides.error && !overrides.data ? (
          <ErrorBlock message={overrides.error} />
        ) : overrides.data && overrides.data.rows.length === 0 ? (
          <EmptyBlock>
            <p>No overrides yet.</p>
            <p className="muted">Use the form above to schedule a manual charge, discharge, or self-consume window.</p>
          </EmptyBlock>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Start</th>
                  <th>End / target</th>
                  <th>Action</th>
                  <th>Power limit</th>
                  <th>Status</th>
                  <th>Demand window</th>
                  <th>Note</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {overrides.data?.rows.map((o) => (
                  <tr key={o.id}>
                    <td>{formatDateTime(o.start_time)}</td>
                    <td>{o.end_time ? formatDateTime(o.end_time) : `${formatWh(o.energy_wh)} target`}</td>
                    <td>{o.action}</td>
                    <td>{o.power_w ? formatKW(o.power_w) : "planner choice"}</td>
                    <td>
                      <span className={`chip ${CHIP_CLASS[o.status]}`}>{o.status}</span>
                    </td>
                    <td className="muted">{o.override_demand_window ? "allowed" : "protected"}</td>
                    <td className="muted">{o.note ?? "--"}</td>
                    <td>
                      {(o.status === "pending" || o.status === "active") && (
                        <button
                          className="btn btn-sm btn-danger"
                          disabled={cancellingId === o.id}
                          onClick={() => void cancel(o.id)}
                        >
                          {cancellingId === o.id ? "Cancelling…" : "Cancel"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
