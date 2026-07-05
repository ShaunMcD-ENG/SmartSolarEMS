import { useState } from "react";
import type { DemandWindow } from "../api";

const REQUIRED_PHRASE = "Yes, continue into the demand window";

export function DemandConflictModal({
  demandWindow,
  busy,
  onConfirm,
  onCancel,
}: {
  demandWindow: DemandWindow;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [typed, setTyped] = useState("");
  const matches = typed.trim() === REQUIRED_PHRASE;

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <h2>This override conflicts with the demand window</h2>
        <p>
          The configured demand window is <strong>{demandWindow.start}–{demandWindow.end}</strong> (plus a{" "}
          {demandWindow.bufferMin} minute buffer either side). By default, self-consumption during this window
          protects you from grid import charges and beats scheduled overrides.
        </p>
        <div className="modal-warning">
          Continuing will let this override run into the demand window, which may cause grid import during the
          protected period.
        </div>
        <label>
          Type <code>{REQUIRED_PHRASE}</code> to confirm
          <input
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoFocus
            placeholder={REQUIRED_PHRASE}
          />
        </label>
        <div className="form-actions">
          <button className="btn btn-danger" disabled={!matches || busy} onClick={onConfirm}>
            {busy ? "Submitting…" : "Yes, continue into the demand window"}
          </button>
          <button className="btn btn-ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
