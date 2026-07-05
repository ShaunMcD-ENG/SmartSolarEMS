import { useState, type FormEvent } from "react";
import {
  apiErrorMessage,
  settingsApi,
  type AmberSettings,
  type BatterySettings,
  type DemandWindow,
  type GoalsSettings,
  type ModeSettings,
  type SigenergySettings,
  type SocTarget,
} from "../api";
import { useToast } from "../toast";

function useCardBusy() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return { busy, setBusy, error, setError };
}

function CardShell({
  title,
  children,
  onSubmit,
  error,
  busy,
  footNote,
}: {
  title: string;
  children: React.ReactNode;
  onSubmit: (e: FormEvent) => void;
  error: string | null;
  busy: boolean;
  footNote?: React.ReactNode;
}) {
  return (
    <form className="card" onSubmit={onSubmit}>
      <h2>{title}</h2>
      {footNote}
      <div className="form-grid">{children}</div>
      {error && <div className="form-error">{error}</div>}
      <div className="form-actions">
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------

export function SigenergyCard({ initial }: { initial: SigenergySettings | null }) {
  const toast = useToast();
  const { busy, setBusy, error, setError } = useCardBusy();
  const base = initial ?? { host: "", port: 502, plantUnitId: 1, inverterUnitId: 1, pollIntervalMs: 10000 };
  const [host, setHost] = useState(base.host);
  const [port, setPort] = useState(String(base.port));
  const [plantUnitId, setPlantUnitId] = useState(String(base.plantUnitId));
  const [inverterUnitId, setInverterUnitId] = useState(String(base.inverterUnitId));
  const [pollIntervalS, setPollIntervalS] = useState(String(base.pollIntervalMs / 1000));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await settingsApi.put<SigenergySettings>("sigenergy", {
        host: host.trim(),
        port: Number(port),
        plantUnitId: Number(plantUnitId),
        inverterUnitId: Number(inverterUnitId),
        pollIntervalMs: Math.round(Number(pollIntervalS) * 1000),
      });
      toast.push("success", "Sigenergy settings saved.");
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <CardShell title="Sigenergy inverter" onSubmit={submit} error={error} busy={busy}>
      <label>
        Host / IP
        <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.50" />
      </label>
      <label>
        Port
        <input type="number" value={port} onChange={(e) => setPort(e.target.value)} min={1} />
      </label>
      <label>
        Plant unit id
        <input type="number" value={plantUnitId} onChange={(e) => setPlantUnitId(e.target.value)} />
      </label>
      <label>
        Inverter unit id
        <input type="number" value={inverterUnitId} onChange={(e) => setInverterUnitId(e.target.value)} />
      </label>
      <label>
        Poll interval (seconds)
        <input type="number" value={pollIntervalS} onChange={(e) => setPollIntervalS(e.target.value)} min={1} />
      </label>
    </CardShell>
  );
}

// ---------------------------------------------------------------------------

export function AmberCard({ initial }: { initial: (AmberSettings & { tokenSet: boolean }) | null }) {
  const toast = useToast();
  const { busy, setBusy, error, setError } = useCardBusy();
  const base = initial ?? { apiToken: "", siteId: "", pollIntervalMs: 300000, tokenSet: false };
  const [apiToken, setApiToken] = useState("");
  const [siteId, setSiteId] = useState(base.siteId);
  const [pollIntervalMin, setPollIntervalMin] = useState(String(base.pollIntervalMs / 60000));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (apiToken.trim().length === 0) {
      setError("Enter the API token to save (it is never pre-filled for security).");
      return;
    }
    setBusy(true);
    try {
      await settingsApi.put<AmberSettings>("amber", {
        apiToken: apiToken.trim(),
        siteId: siteId.trim(),
        pollIntervalMs: Math.round(Number(pollIntervalMin) * 60000),
      });
      toast.push("success", "Amber settings saved.");
      setApiToken("");
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <CardShell
      title="Amber Electric"
      onSubmit={submit}
      error={error}
      busy={busy}
      footNote={
        <p className="tile-sub">
          API token currently: {base.tokenSet ? <strong>{base.apiToken}</strong> : "not set"}
        </p>
      }
    >
      <label>
        API token
        <input
          type="password"
          value={apiToken}
          onChange={(e) => setApiToken(e.target.value)}
          placeholder={base.tokenSet ? "enter a new token to replace it" : "paste your Amber API token"}
          autoComplete="off"
        />
        <span className="field-hint">Leave blank to make no change; re-enter it any time you save this card.</span>
      </label>
      <label>
        Site id
        <input value={siteId} onChange={(e) => setSiteId(e.target.value)} placeholder="Amber site id" />
      </label>
      <label>
        Poll interval (minutes)
        <input type="number" value={pollIntervalMin} onChange={(e) => setPollIntervalMin(e.target.value)} min={1} />
      </label>
    </CardShell>
  );
}

// ---------------------------------------------------------------------------

export function BatteryCard({ initial }: { initial: BatterySettings | null }) {
  const toast = useToast();
  const { busy, setBusy, error, setError } = useCardBusy();
  const base = initial ?? {
    capacityWh: 10000,
    usableMinSocPct: 10,
    maxChargeW: 5000,
    maxDischargeW: 5000,
    roundTripEfficiency: 0.9,
  };
  const [capacityKwh, setCapacityKwh] = useState(String(base.capacityWh / 1000));
  const [minReserve, setMinReserve] = useState(String(base.usableMinSocPct));
  const [maxChargeKw, setMaxChargeKw] = useState(String(base.maxChargeW / 1000));
  const [maxDischargeKw, setMaxDischargeKw] = useState(String(base.maxDischargeW / 1000));
  const [efficiencyPct, setEfficiencyPct] = useState(String(Math.round(base.roundTripEfficiency * 100)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await settingsApi.put<BatterySettings>("battery", {
        capacityWh: Math.round(Number(capacityKwh) * 1000),
        usableMinSocPct: Number(minReserve),
        maxChargeW: Math.round(Number(maxChargeKw) * 1000),
        maxDischargeW: Math.round(Number(maxDischargeKw) * 1000),
        roundTripEfficiency: Number(efficiencyPct) / 100,
      });
      toast.push("success", "Battery settings saved.");
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <CardShell title="Battery" onSubmit={submit} error={error} busy={busy}>
      <label>
        Capacity (kWh)
        <input type="number" step="0.1" value={capacityKwh} onChange={(e) => setCapacityKwh(e.target.value)} />
      </label>
      <label>
        Minimum reserve SOC (%)
        <input
          type="number"
          min={0}
          max={100}
          value={minReserve}
          onChange={(e) => setMinReserve(e.target.value)}
        />
      </label>
      <label>
        Max charge power (kW)
        <input type="number" step="0.1" value={maxChargeKw} onChange={(e) => setMaxChargeKw(e.target.value)} />
      </label>
      <label>
        Max discharge power (kW)
        <input type="number" step="0.1" value={maxDischargeKw} onChange={(e) => setMaxDischargeKw(e.target.value)} />
      </label>
      <label>
        Round-trip efficiency (%)
        <input
          type="number"
          min={0}
          max={100}
          value={efficiencyPct}
          onChange={(e) => setEfficiencyPct(e.target.value)}
        />
      </label>
    </CardShell>
  );
}

// ---------------------------------------------------------------------------

export function GoalsCard({ initial }: { initial: GoalsSettings | null }) {
  const toast = useToast();
  const { busy, setBusy, error, setError } = useCardBusy();
  const base = initial ?? { maxCyclesPerDay: 1, socTargets: [], minCommandWindowMin: 5 };
  const [maxCycles, setMaxCycles] = useState(String(base.maxCyclesPerDay));
  const [minWindow, setMinWindow] = useState(String(base.minCommandWindowMin));
  const [targets, setTargets] = useState<SocTarget[]>(base.socTargets);

  function updateTarget(i: number, patch: Partial<SocTarget>) {
    setTargets((prev) => prev.map((t, idx) => (idx === i ? { ...t, ...patch } : t)));
  }

  function addTarget() {
    setTargets((prev) => [...prev, { time: "00:00", socPct: 50 }]);
  }

  function removeTarget(i: number) {
    setTargets((prev) => prev.filter((_, idx) => idx !== i));
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await settingsApi.put<GoalsSettings>("goals", {
        maxCyclesPerDay: Number(maxCycles),
        socTargets: targets,
        minCommandWindowMin: Number(minWindow),
      });
      toast.push("success", "Goals saved.");
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>Goals</h2>
      <div className="form-grid">
        <label>
          Max battery cycles / day
          <input type="number" min="0.1" step="0.1" value={maxCycles} onChange={(e) => setMaxCycles(e.target.value)} />
          <span className="field-hint">1 = fill/drain once; 2+ = also trade on price spikes.</span>
        </label>
        <label>
          Min command window (minutes)
          <input type="number" min="1" value={minWindow} onChange={(e) => setMinWindow(e.target.value)} />
        </label>
      </div>

      <h3 style={{ marginTop: "0.9rem" }}>SOC targets</h3>
      {targets.length === 0 && <p className="muted">No time-of-day SOC targets set.</p>}
      {targets.map((t, i) => (
        <div className="soc-target-row" key={i}>
          <input type="time" value={t.time} onChange={(e) => updateTarget(i, { time: e.target.value })} />
          <input
            type="number"
            min={0}
            max={100}
            value={t.socPct}
            onChange={(e) => updateTarget(i, { socPct: Number(e.target.value) })}
            style={{ width: "5rem" }}
          />
          <span className="muted">%</span>
          <button type="button" className="btn btn-sm btn-danger" onClick={() => removeTarget(i)}>
            Remove
          </button>
        </div>
      ))}
      <div className="form-actions">
        <button type="button" className="btn btn-sm" onClick={addTarget}>
          + Add target
        </button>
      </div>

      {error && <div className="form-error">{error}</div>}
      <div className="form-actions">
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------

export function DemandWindowCard({ initial }: { initial: DemandWindow | null }) {
  const toast = useToast();
  const { busy, setBusy, error, setError } = useCardBusy();
  const base = initial ?? { enabled: false, start: "15:00", end: "20:00", bufferMin: 10 };
  const [enabled, setEnabled] = useState(base.enabled);
  const [start, setStart] = useState(base.start);
  const [end, setEnd] = useState(base.end);
  const [bufferMin, setBufferMin] = useState(String(base.bufferMin));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await settingsApi.put<DemandWindow>("demandWindow", {
        enabled,
        start,
        end,
        bufferMin: Number(bufferMin),
      });
      toast.push("success", "Demand window saved.");
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <CardShell title="Demand window" onSubmit={submit} error={error} busy={busy}>
      <label className="checkbox-row">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
        Enabled
      </label>
      <label>
        Start
        <input type="time" value={start} onChange={(e) => setStart(e.target.value)} disabled={!enabled} />
      </label>
      <label>
        End
        <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} disabled={!enabled} />
      </label>
      <label>
        Buffer (minutes)
        <input
          type="number"
          min={0}
          value={bufferMin}
          onChange={(e) => setBufferMin(e.target.value)}
          disabled={!enabled}
        />
      </label>
    </CardShell>
  );
}

// ---------------------------------------------------------------------------

export function ModeCard({ initial }: { initial: ModeSettings | null }) {
  const toast = useToast();
  const [shadow, setShadow] = useState(initial?.shadow ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  async function applyShadow(next: boolean, confirm?: string) {
    setBusy(true);
    setError(null);
    try {
      await settingsApi.putMode(next, confirm);
      setShadow(next);
      toast.push("success", next ? "Shadow mode enabled — inverter control is now disabled." : "Active mode armed. The system will now write real commands to the inverter.");
      setConfirmOpen(false);
      setConfirmText("");
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function onToggle(next: boolean) {
    if (next === true) {
      void applyShadow(true);
    } else {
      setConfirmOpen(true);
    }
  }

  return (
    <div className="card">
      <h2>Mode</h2>
      <div className="danger-note">
        <strong>Active mode writes real commands to your inverter and battery.</strong> Keep shadow mode on until
        you've reviewed decisions and trust the planner's logic. There is no simulator — active mode controls real
        hardware.
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
        <span className={`pill ${shadow ? "pill-shadow" : "pill-active"}`}>
          {shadow ? "⚠ SHADOW MODE" : "● ACTIVE"}
        </span>
        <button className="btn" disabled={busy} onClick={() => onToggle(!shadow)}>
          {shadow ? "Switch to active mode" : "Switch to shadow mode"}
        </button>
      </div>
      {error && <div className="form-error" style={{ marginTop: "0.75rem" }}>{error}</div>}

      {confirmOpen && (
        <div className="modal-backdrop" role="dialog" aria-modal="true">
          <div className="modal">
            <h2>Arm active mode?</h2>
            <div className="modal-warning">
              This will let SmartSolarEMS write remote-EMS commands directly to your Sigenergy inverter. Confirm
              only if you have verified the register mapping and trust the current plan.
            </div>
            <label>
              Type <code>ACTIVATE</code> to confirm
              <input
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder="ACTIVATE"
                autoFocus
              />
            </label>
            <div className="form-actions">
              <button
                className="btn btn-danger"
                disabled={confirmText !== "ACTIVATE" || busy}
                onClick={() => void applyShadow(false, confirmText)}
              >
                {busy ? "Arming…" : "Confirm active mode"}
              </button>
              <button className="btn btn-ghost" onClick={() => setConfirmOpen(false)} disabled={busy}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
