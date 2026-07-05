import { useState, type FormEvent } from "react";
import { apiErrorMessage, authApi } from "../api";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="brand">
          <span className="brand-mark">☀</span>
          <span className="brand-name">SmartSolarEMS</span>
        </div>
        {children}
      </div>
    </div>
  );
}

export function SetupScreen({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      await authApi.setup(password);
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <h1>Set up admin access</h1>
      <p className="muted">
        This is the first time SmartSolarEMS has been opened. Create an admin password to protect
        settings and overrides. There is no recovery flow — store it safely.
      </p>
      <form onSubmit={submit} className="auth-form">
        <label>
          Admin password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={8}
            required
            autoFocus
            autoComplete="new-password"
          />
        </label>
        <label>
          Confirm password
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            minLength={8}
            required
            autoComplete="new-password"
          />
        </label>
        {error && <div className="form-error">{error}</div>}
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "Creating…" : "Create admin account"}
        </button>
      </form>
    </Shell>
  );
}

export function LoginScreen({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await authApi.login(password);
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Shell>
      <h1>Sign in</h1>
      <form onSubmit={submit} className="auth-form">
        <label>
          Admin password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoFocus
            autoComplete="current-password"
          />
        </label>
        {error && <div className="form-error">{error}</div>}
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </Shell>
  );
}
