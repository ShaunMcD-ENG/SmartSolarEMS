import { useState } from "react";
import { forecastApi, type HorizonBucket } from "../api";
import { useAsync } from "../hooks";
import { ErrorBlock, LoadingBlock } from "../components/StateBlock";

const HORIZONS: HorizonBucket[] = ["0-1h", "1-4h", "4-12h", "12-24h"];
const RANGE_OPTIONS = [
  { label: "Last 7 days", days: 7 },
  { label: "Last 30 days", days: 30 },
  { label: "Last 90 days", days: 90 },
];

export function Forecast() {
  const [days, setDays] = useState(7);
  const accuracy = useAsync(() => {
    const to = new Date();
    const from = new Date(to.getTime() - days * 24 * 60 * 60_000);
    return forecastApi.accuracy(from, to);
  }, [days]);

  return (
    <div>
      <div className="view-header">
        <h1>Forecast accuracy</h1>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {RANGE_OPTIONS.map((o) => (
            <option key={o.days} value={o.days}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      <section className="card">
        <p className="muted">
          Mean absolute percentage error (MAPE) and bias for the load and solar forecasts, bucketed by how far ahead
          the prediction was made. Accuracy improves as more telemetry history accrues — early on, especially the
          12-24h horizon, expect wide errors until the model has seen a few full days/weeks of your actual usage and
          solar generation pattern.
        </p>

        {accuracy.loading && !accuracy.data ? (
          <LoadingBlock />
        ) : accuracy.error && !accuracy.data ? (
          <ErrorBlock message={accuracy.error} />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Kind</th>
                  <th>Horizon</th>
                  <th>Samples</th>
                  <th>MAPE</th>
                  <th>Bias</th>
                </tr>
              </thead>
              <tbody>
                {(["load", "solar"] as const).flatMap((kind) =>
                  HORIZONS.map((h) => {
                    const bucket = accuracy.data?.[kind]?.[h];
                    return (
                      <tr key={`${kind}-${h}`}>
                        <td style={{ textTransform: "capitalize" }}>{kind}</td>
                        <td>{h}</td>
                        <td>{bucket?.n ?? 0}</td>
                        <td>{bucket && bucket.mape !== null ? `${bucket.mape.toFixed(1)}%` : "--"}</td>
                        <td>{bucket && bucket.biasWh !== null ? `${(bucket.biasWh / 1000).toFixed(2)} kWh` : "--"}</td>
                      </tr>
                    );
                  }),
                )}
              </tbody>
            </table>
          </div>
        )}
        {accuracy.data &&
          Object.values(accuracy.data.load).every((b) => b.n === 0) &&
          Object.values(accuracy.data.solar).every((b) => b.n === 0) && (
            <p className="muted" style={{ marginTop: "0.75rem" }}>
              No forecasts have been scored yet in this range — check back once telemetry and forecasts have had
              time to accrue.
            </p>
          )}
      </section>
    </div>
  );
}
