export type View = "dashboard" | "overrides" | "settings" | "forecast";

const TABS: { id: View; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "overrides", label: "Overrides" },
  { id: "settings", label: "Settings" },
  { id: "forecast", label: "Forecast" },
];

export function Nav({
  view,
  onChange,
  onLogout,
}: {
  view: View;
  onChange: (v: View) => void;
  onLogout: () => void;
}) {
  return (
    <header className="app-nav">
      <div className="app-nav-brand">
        <span className="brand-mark">☀</span>
        <span className="brand-name">SmartSolarEMS</span>
      </div>
      <nav className="app-nav-tabs">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`nav-tab${view === t.id ? " active" : ""}`}
            onClick={() => onChange(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <button className="btn btn-ghost app-nav-logout" onClick={onLogout}>
        Log out
      </button>
    </header>
  );
}
