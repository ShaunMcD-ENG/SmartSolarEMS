import { useMemo } from "react";
import {
  decisionsApi,
  planApi,
  pricesApi,
  statusApi,
  telemetryApi,
  type SettingsBundle,
} from "../api";
import { usePoll, useAsync } from "../hooks";
import { settingsApi } from "../api";
import { formatKW, formatKWAbs, formatPct, formatRelative, formatCents } from "../format";
import { BatteryBar } from "../components/BatteryBar";
import { ModePill, HealthDot, ExecutorHealthDot } from "../components/StatusPill";
import { PowerChart } from "../components/PowerChart";
import { PricePlanChart } from "../components/PricePlanChart";
import { DecisionsTable } from "../components/DecisionsTable";
import { ErrorBlock, LoadingBlock } from "../components/StateBlock";

const LIVE_POLL_MS = 10_000;
const CHART_POLL_MS = 60_000;

function useNowWindow(beforeMs: number, afterMs: number) {
  // Recomputed each render (cheap) so charts stay anchored to "now" as time passes.
  const now = Date.now();
  return { from: new Date(now - beforeMs), to: new Date(now + afterMs) };
}

export function Dashboard() {
  const status = usePoll(() => statusApi.get(), LIVE_POLL_MS, []);

  const liveTelemetry = usePoll(
    () => {
      const to = new Date();
      const from = new Date(to.getTime() - 10 * 60_000);
      return telemetryApi.raw(from, to);
    },
    LIVE_POLL_MS,
    [],
  );

  const currentPrices = usePoll(
    () => {
      const to = new Date();
      const from = new Date(to.getTime() - 30 * 60_000);
      return Promise.all([pricesApi.between(from, to, "general"), pricesApi.between(from, to, "feedIn")]);
    },
    LIVE_POLL_MS,
    [],
  );

  const settings = useAsync(() => settingsApi.getAll(), []);

  const powerChart = usePoll(
    () => {
      const to = new Date();
      const from = new Date(to.getTime() - 24 * 60 * 60_000);
      return telemetryApi.fiveMin(from, to);
    },
    CHART_POLL_MS,
    [],
  );

  const pricePlan = usePoll(
    () => {
      const now = new Date();
      const from = new Date(now.getTime() - 12 * 60 * 60_000);
      const to = new Date(now.getTime() + 24 * 60 * 60_000);
      return Promise.all([
        pricesApi.between(from, to, "general"),
        pricesApi.between(from, to, "feedIn"),
        planApi.latest(),
      ]);
    },
    CHART_POLL_MS,
    [],
  );

  const decisions = usePoll(
    () => {
      const to = new Date();
      const from = new Date(to.getTime() - 24 * 60 * 60_000);
      return decisionsApi.between(from, to);
    },
    CHART_POLL_MS,
    [],
  );

  const latestRow = useMemo(() => {
    const rows = liveTelemetry.data?.rows ?? [];
    if (rows.length === 0) return null;
    return rows.reduce((latest, row) => (new Date(row.time) > new Date(latest.time) ? row : latest));
  }, [liveTelemetry.data]);

  const { buyNow, sellNow } = useMemo(() => {
    const [buyRows, sellRows] = currentPrices.data ?? [{ rows: [] }, { rows: [] }];
    const nowMs = Date.now();
    const nearest = (rows: { interval_start: string; per_kwh: number }[]) => {
      if (rows.length === 0) return null;
      return rows.reduce((best, r) => {
        const bestDiff = Math.abs(new Date(best.interval_start).getTime() - nowMs);
        const diff = Math.abs(new Date(r.interval_start).getTime() - nowMs);
        return diff < bestDiff ? r : best;
      }).per_kwh;
    };
    return { buyNow: nearest(buyRows.rows), sellNow: nearest(sellRows.rows) };
  }, [currentPrices.data]);

  const batterySettings: SettingsBundle["battery"] = settings.data?.battery ?? null;
  const reservePct = batterySettings?.usableMinSocPct ?? null;

  return (
    <div className="dashboard">
      <div className="view-header">
        <h1>Dashboard</h1>
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
          {status.data && <ModePill mode={status.data.mode} />}
          {status.data && (
            <>
              <HealthDot label="Sigenergy" status={status.data.modbus} />
              <HealthDot label="Amber" status={status.data.amber} />
              <ExecutorHealthDot status={status.data.executor} />
            </>
          )}
        </div>
      </div>
      {status.error && <ErrorBlock message={`Status unavailable: ${status.error}`} />}

      <LiveTiles
        loading={liveTelemetry.loading && !latestRow}
        error={liveTelemetry.error}
        pv={latestRow?.pv_power_w ?? null}
        load={latestRow?.load_power_w ?? null}
        battery={latestRow?.battery_power_w ?? null}
        soc={latestRow?.battery_soc_pct ?? null}
        grid={latestRow?.grid_power_w ?? null}
        reservePct={reservePct}
        buyNow={buyNow}
        sellNow={sellNow}
        lastSampleTime={latestRow?.time ?? null}
      />

      <section className="card">
        <div className="card-title-row">
          <h2>Power flows — last 24 hours</h2>
        </div>
        {powerChart.loading && !powerChart.data ? (
          <LoadingBlock />
        ) : powerChart.error && !powerChart.data ? (
          <ErrorBlock message={powerChart.error} />
        ) : (
          <PowerChart rows={powerChart.data?.rows ?? []} />
        )}
      </section>

      <section className="card">
        <div className="card-title-row">
          <h2>Prices &amp; plan</h2>
        </div>
        {pricePlan.loading && !pricePlan.data ? (
          <LoadingBlock />
        ) : pricePlan.error && !pricePlan.data ? (
          <ErrorBlock message={pricePlan.error} />
        ) : (
          <PricePlanChart
            buyRows={pricePlan.data?.[0].rows ?? []}
            sellRows={pricePlan.data?.[1].rows ?? []}
            slots={pricePlan.data?.[2].plan?.slots ?? []}
          />
        )}
      </section>

      <section className="card">
        <div className="card-title-row">
          <h2>Recent decisions</h2>
        </div>
        {decisions.loading && !decisions.data ? (
          <LoadingBlock />
        ) : decisions.error && !decisions.data ? (
          <ErrorBlock message={decisions.error} />
        ) : (
          <DecisionsTable rows={decisions.data?.rows ?? []} />
        )}
      </section>
    </div>
  );
}

function LiveTiles(props: {
  loading: boolean;
  error: string | null;
  pv: number | null;
  load: number | null;
  battery: number | null;
  soc: number | null;
  grid: number | null;
  reservePct: number | null;
  buyNow: number | null;
  sellNow: number | null;
  lastSampleTime: string | null;
}) {
  if (props.loading) {
    return (
      <div className="card">
        <LoadingBlock label="Loading live telemetry…" />
      </div>
    );
  }

  const noData = props.pv === null && props.load === null && props.battery === null && props.grid === null;

  return (
    <div className="tile-grid">
      <div className="tile">
        <span className="tile-label">Solar</span>
        <span className="tile-value" style={{ color: "var(--c-solar)" }}>
          {formatKW(props.pv)}
        </span>
        <span className="tile-sub">generation</span>
      </div>

      <div className="tile">
        <span className="tile-label">Load</span>
        <span className="tile-value" style={{ color: "var(--c-load)" }}>
          {formatKW(props.load)}
        </span>
        <span className="tile-sub">home consumption</span>
      </div>

      <div className="tile">
        <span className="tile-label">Battery</span>
        <span className="tile-value" style={{ color: "var(--c-battery)" }}>
          {formatKWAbs(props.battery)}
        </span>
        <span className="tile-sub">
          {props.battery === null
            ? "no data"
            : props.battery > 0
              ? "charging"
              : props.battery < 0
                ? "discharging"
                : "idle"}
        </span>
      </div>

      <div className="tile">
        <span className="tile-label">State of charge</span>
        <span className="tile-value">{formatPct(props.soc)}</span>
        <BatteryBar socPct={props.soc} reservePct={props.reservePct} />
        <span className="tile-sub">reserve floor {props.reservePct !== null ? `${props.reservePct}%` : "--"}</span>
      </div>

      <div className="tile">
        <span className="tile-label">Grid</span>
        <span className="tile-value" style={{ color: "var(--c-grid)" }}>
          {formatKWAbs(props.grid)}
        </span>
        <span className="tile-sub">
          {props.grid === null ? "no data" : props.grid > 0 ? "importing" : props.grid < 0 ? "exporting" : "balanced"}
        </span>
      </div>

      <div className="tile">
        <span className="tile-label">Buy / sell price</span>
        <span className="tile-value">{formatCents(props.buyNow)}</span>
        <span className="tile-sub">sell {formatCents(props.sellNow)}</span>
      </div>

      {noData && (
        <div className="tile" style={{ gridColumn: "1 / -1" }}>
          <span className="tile-sub">
            No telemetry yet — waiting for the Sigenergy poller to report its first reading.
          </span>
        </div>
      )}
      {!noData && (
        <div className="tile-sub" style={{ gridColumn: "1 / -1", marginTop: "-0.4rem" }}>
          Last sample {formatRelative(props.lastSampleTime)}
        </div>
      )}
      {props.error && <ErrorBlock message={props.error} />}
    </div>
  );
}
