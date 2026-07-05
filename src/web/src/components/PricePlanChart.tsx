import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  Legend,
} from "recharts";
import type { PlanSlotRow, PriceRow } from "../api";
import { COLORS } from "../theme";
import { EmptyBlock } from "./StateBlock";

interface Point {
  t: number;
  buy: number | null;
  sell: number | null;
  soc: number | null;
}

type BandGroup = "charge" | "discharge" | "self_consume";

interface Band {
  group: BandGroup;
  start: number;
  end: number;
}

function actionGroup(action: PlanSlotRow["action"]): BandGroup | null {
  if (action === "charge_solar" || action === "charge_grid") return "charge";
  if (action === "discharge_load" || action === "discharge_grid") return "discharge";
  if (action === "self_consume") return "self_consume";
  return null; // idle -> no band
}

const BAND_STYLE: Record<BandGroup, { fill: string; label: string }> = {
  charge: { fill: COLORS.bandCharge, label: "Charge" },
  discharge: { fill: COLORS.bandDischarge, label: "Discharge" },
  self_consume: { fill: COLORS.bandSelfConsume, label: "Self-consume" },
};

function buildBands(slots: PlanSlotRow[]): Band[] {
  if (slots.length === 0) return [];
  const sorted = [...slots].sort((a, b) => new Date(a.slot_start).getTime() - new Date(b.slot_start).getTime());

  const diffs: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    diffs.push(new Date(sorted[i]!.slot_start).getTime() - new Date(sorted[i - 1]!.slot_start).getTime());
  }
  diffs.sort((a, b) => a - b);
  const slotMs = diffs.length > 0 ? diffs[Math.floor(diffs.length / 2)]! : 5 * 60_000;

  const bands: Band[] = [];
  let current: Band | null = null;
  for (const slot of sorted) {
    const group = actionGroup(slot.action);
    const start = new Date(slot.slot_start).getTime();
    const end = start + slotMs;
    if (group === null) {
      current = null;
      continue;
    }
    if (current && current.group === group && current.end === start) {
      current.end = end;
    } else {
      current = { group, start, end };
      bands.push(current);
    }
  }
  return bands;
}

function mergePoints(buy: PriceRow[], sell: PriceRow[], slots: PlanSlotRow[]): Point[] {
  const buyMap = new Map(buy.map((r) => [new Date(r.interval_start).getTime(), r]));
  const sellMap = new Map(sell.map((r) => [new Date(r.interval_start).getTime(), r]));
  const socMap = new Map(slots.map((s) => [new Date(s.slot_start).getTime(), s.expected_soc_pct]));

  const allTimes = new Set<number>([...buyMap.keys(), ...sellMap.keys()]);
  return [...allTimes]
    .sort((a, b) => a - b)
    .map((t) => ({
      t,
      buy: buyMap.get(t)?.per_kwh ?? null,
      sell: sellMap.get(t)?.per_kwh ?? null,
      soc: socMap.get(t) ?? null,
    }));
}

function timeTick(v: number): string {
  return new Date(v).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function priceTooltip(value: number | string | readonly (number | string)[] | undefined): string {
  const n = typeof value === "number" ? value : Number(Array.isArray(value) ? value[0] : value);
  return `${n.toFixed(1)}c/kWh`;
}

export function PricePlanChart({
  buyRows,
  sellRows,
  slots,
}: {
  buyRows: PriceRow[];
  sellRows: PriceRow[];
  slots: PlanSlotRow[];
}) {
  if (buyRows.length === 0 && sellRows.length === 0) {
    return (
      <EmptyBlock>
        <p>No price data yet.</p>
        <p className="muted">Prices appear once the Amber poller is configured and has fetched at least once.</p>
      </EmptyBlock>
    );
  }

  const data = mergePoints(buyRows, sellRows, slots);
  const bands = buildBands(slots);
  const hasSoc = slots.some((s) => s.expected_soc_pct !== null);
  const now = Date.now();

  return (
    <div>
      <div className="chart-box">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={COLORS.gridLine} strokeDasharray="3 3" vertical={false} />
            {bands.map((b, i) => (
              <ReferenceArea
                key={i}
                yAxisId="price"
                x1={b.start}
                x2={b.end}
                fill={BAND_STYLE[b.group].fill}
                stroke="none"
                ifOverflow="hidden"
              />
            ))}
            <ReferenceLine yAxisId="price" x={now} stroke={COLORS.axisText} strokeDasharray="4 4" />
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
              yAxisId="price"
              stroke={COLORS.axisText}
              tick={{ fontSize: 11, fill: COLORS.axisText }}
              tickLine={false}
              width={44}
              label={{ value: "c/kWh", position: "insideTopLeft", fill: COLORS.axisText, fontSize: 11 }}
            />
            {hasSoc && (
              <YAxis
                yAxisId="soc"
                orientation="right"
                domain={[0, 100]}
                stroke={COLORS.axisText}
                tick={{ fontSize: 11, fill: COLORS.axisText }}
                tickLine={false}
                width={36}
                label={{ value: "SOC %", angle: 90, position: "insideTopRight", fill: COLORS.axisText, fontSize: 11 }}
              />
            )}
            <Tooltip
              formatter={(v: number | string | readonly (number | string)[] | undefined, name: number | string | undefined) =>
                name === "Expected SOC" ? [`${Number(v).toFixed(1)}%`, name] : [priceTooltip(v), name]
              }
              labelFormatter={(v) => new Date(v as number).toLocaleString()}
              contentStyle={{ background: "#1b2530", border: "1px solid #2a3746", fontSize: 12 }}
              labelStyle={{ color: "#aab6c2" }}
            />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Line
              yAxisId="price"
              type="stepAfter"
              dataKey="buy"
              name="Buy price"
              stroke={COLORS.load}
              dot={false}
              strokeWidth={2}
              connectNulls
            />
            <Line
              yAxisId="price"
              type="stepAfter"
              dataKey="sell"
              name="Sell price"
              stroke={COLORS.solar}
              dot={false}
              strokeWidth={2}
              connectNulls
            />
            {hasSoc && (
              <Line
                yAxisId="soc"
                type="monotone"
                dataKey="soc"
                name="Expected SOC"
                stroke={COLORS.grid}
                strokeDasharray="5 3"
                dot={false}
                strokeWidth={2}
                connectNulls
              />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>
      {bands.length > 0 && (
        <div className="health-row" style={{ flexWrap: "wrap", gap: "0.9rem", marginTop: "0.4rem" }}>
          {(["charge", "discharge", "self_consume"] as BandGroup[]).map((g) => (
            <span key={g} className="tile-sub">
              <span className="tile-swatch" style={{ background: BAND_STYLE[g].fill }} />
              {BAND_STYLE[g].label}
            </span>
          ))}
        </div>
      )}
      <p className="chart-legend-note">
        Dashed line is the planner's expected state of charge (right axis) — shown alongside price to explain why a
        band was chosen.
      </p>
    </div>
  );
}
