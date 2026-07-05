import type { ExecutorStatus, PollerStatus } from "../api";
import { formatRelative } from "../format";

export function ModePill({ mode }: { mode: "shadow" | "active" }) {
  if (mode === "shadow") {
    return (
      <span className="pill pill-shadow" title="Decisions are logged only — the inverter is not being controlled.">
        ⚠ SHADOW MODE
      </span>
    );
  }
  return (
    <span className="pill pill-active" title="Active mode — the planner is writing commands to the inverter.">
      ● ACTIVE
    </span>
  );
}

function healthClass(s: PollerStatus): "good" | "warning" | "critical" {
  if (!s.running) return "critical";
  if (s.lastError) return "warning";
  return "good";
}

export function HealthDot({ label, status }: { label: string; status: PollerStatus }) {
  const cls = healthClass(status);
  const tooltip = [
    `${label}: ${status.running ? "running" : "stopped"}`,
    `last success: ${formatRelative(status.lastSuccess)}`,
    status.lastError ? `last error: ${status.lastError}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <span className="health-row" title={tooltip}>
      <span className={`status-dot ${cls}`} />
      {label}
    </span>
  );
}

export function ExecutorHealthDot({ status }: { status: ExecutorStatus | null | undefined }) {
  if (!status) {
    return (
      <span className="health-row" title="Executor not yet wired up.">
        <span className="status-dot warning" />
        Executor
      </span>
    );
  }
  const cls = status.failSafeEngaged
    ? "critical"
    : !status.running
      ? "critical"
      : status.lastError
        ? "warning"
        : "good";
  const tooltip = [
    `Executor: ${status.running ? "running" : "stopped"} (${status.mode})`,
    `last tick: ${formatRelative(status.lastTick)}`,
    status.lastAction ? `last action: ${status.lastAction}` : null,
    status.failSafeEngaged ? "FAIL-SAFE ENGAGED" : null,
    status.consecutiveModbusFailures > 0 ? `consecutive modbus failures: ${status.consecutiveModbusFailures}` : null,
    status.lastError ? `last error: ${status.lastError}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <span className="health-row" title={tooltip}>
      <span className={`status-dot ${cls}`} />
      Executor
    </span>
  );
}
