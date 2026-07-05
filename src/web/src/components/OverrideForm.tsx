import { useState, type FormEvent } from "react";
import { ApiRequestError, apiErrorMessage, overridesApi, type DemandWindow, type OverrideAction, type OverrideCreateInput } from "../api";
import { toDatetimeLocalValue } from "../format";
import { useToast } from "../toast";
import { DemandConflictModal } from "./DemandConflictModal";

type DurationMode = "end_time" | "energy";

function defaultStart(): string {
  const d = new Date(Date.now() + 5 * 60_000);
  d.setSeconds(0, 0);
  return toDatetimeLocalValue(d);
}

function defaultEnd(): string {
  const d = new Date(Date.now() + 65 * 60_000);
  d.setSeconds(0, 0);
  return toDatetimeLocalValue(d);
}

export function OverrideForm({ onCreated }: { onCreated: () => void }) {
  const toast = useToast();
  const [action, setAction] = useState<OverrideAction>("charge");
  const [durationMode, setDurationMode] = useState<DurationMode>("end_time");
  const [startTime, setStartTime] = useState(defaultStart());
  const [endTime, setEndTime] = useState(defaultEnd());
  const [energyKwh, setEnergyKwh] = useState("");
  const [powerKw, setPowerKw] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<{ demandWindow: DemandWindow; payload: OverrideCreateInput } | null>(null);

  function buildPayload(overrideDemandWindow: boolean): OverrideCreateInput | null {
    const start = new Date(startTime);
    if (Number.isNaN(start.getTime())) {
      setError("Start time is invalid.");
      return null;
    }
    let end_time: string | null = null;
    let energy_wh: number | null = null;
    if (durationMode === "end_time") {
      const end = new Date(endTime);
      if (Number.isNaN(end.getTime())) {
        setError("End time is invalid.");
        return null;
      }
      end_time = end.toISOString();
    } else {
      const kwh = Number.parseFloat(energyKwh);
      if (!Number.isFinite(kwh) || kwh <= 0) {
        setError("Enter an energy target in kWh greater than 0.");
        return null;
      }
      energy_wh = Math.round(kwh * 1000);
    }
    let power_w: number | null = null;
    if (powerKw.trim().length > 0) {
      const kw = Number.parseFloat(powerKw);
      if (!Number.isFinite(kw) || kw <= 0) {
        setError("Power must be a positive number of kW, or left blank.");
        return null;
      }
      power_w = Math.round(kw * 1000);
    }
    return {
      start_time: start.toISOString(),
      end_time,
      action,
      energy_wh,
      power_w,
      note: note.trim().length > 0 ? note.trim() : null,
      override_demand_window: overrideDemandWindow,
    };
  }

  async function submitPayload(payload: OverrideCreateInput) {
    setBusy(true);
    setError(null);
    try {
      await overridesApi.create(payload);
      toast.push("success", "Override created.");
      setConflict(null);
      setEnergyKwh("");
      setPowerKw("");
      setNote("");
      onCreated();
    } catch (err) {
      if (err instanceof ApiRequestError && err.status === 409 && err.code === "demand_window_conflict" && err.demandWindow) {
        setConflict({ demandWindow: err.demandWindow, payload });
      } else {
        setError(apiErrorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const payload = buildPayload(false);
    if (payload) void submitPayload(payload);
  }

  function confirmIntoDemandWindow() {
    if (!conflict) return;
    void submitPayload({ ...conflict.payload, override_demand_window: true });
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>Schedule an override</h2>
      <div className="form-grid">
        <label>
          Action
          <select value={action} onChange={(e) => setAction(e.target.value as OverrideAction)}>
            <option value="charge">Charge</option>
            <option value="discharge">Discharge</option>
            <option value="self_consume">Self-consume</option>
            <option value="idle">Idle</option>
          </select>
        </label>

        <label>
          Start time
          <input type="datetime-local" value={startTime} onChange={(e) => setStartTime(e.target.value)} required />
        </label>

        <label>
          Duration
          <select value={durationMode} onChange={(e) => setDurationMode(e.target.value as DurationMode)}>
            <option value="end_time">Until a specific end time</option>
            <option value="energy">Until an energy target is met</option>
          </select>
        </label>

        {durationMode === "end_time" ? (
          <label>
            End time
            <input type="datetime-local" value={endTime} onChange={(e) => setEndTime(e.target.value)} required />
          </label>
        ) : (
          <label>
            Energy target (kWh)
            <input
              type="number"
              min="0.1"
              step="0.1"
              value={energyKwh}
              onChange={(e) => setEnergyKwh(e.target.value)}
              placeholder="e.g. 9"
              required
            />
          </label>
        )}

        <label>
          Power limit (kW, optional)
          <input
            type="number"
            min="0.1"
            step="0.1"
            value={powerKw}
            onChange={(e) => setPowerKw(e.target.value)}
            placeholder="planner picks, within limits"
          />
        </label>

        <label>
          Note (optional)
          <input type="text" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>
      </div>

      {error && <div className="form-error">{error}</div>}

      <div className="form-actions">
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? "Creating…" : "Create override"}
        </button>
      </div>

      {conflict && (
        <DemandConflictModal
          demandWindow={conflict.demandWindow}
          busy={busy}
          onConfirm={confirmIntoDemandWindow}
          onCancel={() => setConflict(null)}
        />
      )}
    </form>
  );
}
