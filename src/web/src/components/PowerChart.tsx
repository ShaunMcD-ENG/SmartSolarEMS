import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Legend,
} from "recharts";
import type { Telemetry5mRow } from "../api";
import { COLORS } from "../theme";
import { EmptyBlock } from "./StateBlock";

interface Point {
  t: number;
  solar: number | null;
  load: number | null;
  battery: number | null;
  grid: number | null;
}

function toPoints(rows: Telemetry5mRow[]): Point[] {
  return rows.map((r) => ({
    t: new Date(r.bucket).getTime(),
    solar: r.pv_power_w_avg,
    load: r.load_power_w_avg,
    battery: r.battery_power_w_avg,
    grid: r.grid_power_w_avg,
  }));
}

function kwTick(v: number): string {
  return (v / 1000).toFixed(1);
}

function timeTick(v: number): string {
  return new Date(v).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function tooltipFormatter(value: number | string | readonly (number | string)[] | undefined): string {
  const n = typeof value === "number" ? value : Number(Array.isArray(value) ? value[0] : value);
  return `${(n / 1000).toFixed(2)} kW`;
}

export function PowerChart({ rows }: { rows: Telemetry5mRow[] }) {
  if (rows.length === 0) {
    return (
      <EmptyBlock>
        <p>No telemetry recorded yet in the last 24 hours.</p>
        <p className="muted">Power flows will appear here once the Sigenergy poller starts collecting data.</p>
      </EmptyBlock>
    );
  }

  const data = toPoints(rows);

  return (
    <div className="chart-box">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={COLORS.gridLine} strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="t"
            type="number"
            domain={["dataMin", "dataMax"]}
            tickFormatter={timeTick}
            stroke={COLORS.axisText}
            tick={{ fontSize: 11, fill: COLORS.axisText }}
            tickLine={false}
          />
          <YAxis
            tickFormatter={kwTick}
            stroke={COLORS.axisText}
            tick={{ fontSize: 11, fill: COLORS.axisText }}
            tickLine={false}
            width={40}
            label={{ value: "kW", position: "insideTopLeft", fill: COLORS.axisText, fontSize: 11 }}
          />
          <Tooltip
            formatter={tooltipFormatter}
            labelFormatter={(v) => new Date(v as number).toLocaleString()}
            contentStyle={{ background: "#1b2530", border: "1px solid #2a3746", fontSize: 12 }}
            labelStyle={{ color: "#aab6c2" }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          <Line type="monotone" dataKey="solar" name="Solar" stroke={COLORS.solar} dot={false} strokeWidth={2} connectNulls />
          <Line type="monotone" dataKey="load" name="Load" stroke={COLORS.load} dot={false} strokeWidth={2} connectNulls />
          <Line
            type="monotone"
            dataKey="battery"
            name="Battery"
            stroke={COLORS.battery}
            dot={false}
            strokeWidth={2}
            connectNulls
          />
          <Line type="monotone" dataKey="grid" name="Grid" stroke={COLORS.grid} dot={false} strokeWidth={2} connectNulls />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
