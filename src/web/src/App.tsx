import { useEffect, useState } from "react";
import { authApi, onUnauthorized } from "./api";
import { ToastProvider } from "./toast";
import { LoginScreen, SetupScreen } from "./components/AuthScreens";
import { Nav, type View } from "./components/Nav";
import { Dashboard } from "./views/Dashboard";
import { Overrides } from "./views/Overrides";
import { Settings } from "./views/Settings";
import { Forecast } from "./views/Forecast";

type AuthPhase = "loading" | "setup" | "login" | "app";

function viewFromHash(): View {
  const hash = window.location.hash.replace(/^#\/?/, "");
  if (hash === "overrides" || hash === "settings" || hash === "forecast") return hash;
  return "dashboard";
}

export default function App() {
  const [phase, setPhase] = useState<AuthPhase>("loading");
  const [view, setView] = useState<View>(viewFromHash());
  const [authError, setAuthError] = useState<string | null>(null);

  const refreshAuth = () => {
    authApi
      .status()
      .then((s) => {
        if (s.firstBoot) setPhase("setup");
        else if (!s.authenticated) setPhase("login");
        else setPhase("app");
      })
      .catch((err) => {
        setAuthError(err instanceof Error ? err.message : String(err));
        setPhase("login");
      });
  };

  useEffect(() => {
    refreshAuth();
    onUnauthorized(() => setPhase("login"));
  }, []);

  useEffect(() => {
    const onHashChange = () => setView(viewFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  function navigate(v: View) {
    window.location.hash = `/${v}`;
    setView(v);
  }

  async function logout() {
    try {
      await authApi.logout();
    } finally {
      setPhase("login");
    }
  }

  return (
    <ToastProvider>
      {phase === "loading" && (
        <div className="full-page-center">
          <div className="spinner" aria-label="Loading" />
        </div>
      )}
      {phase === "setup" && <SetupScreen onDone={refreshAuth} />}
      {phase === "login" && (
        <>
          <LoginScreen onDone={refreshAuth} />
          {authError && (
            <div className="full-page-center muted" style={{ marginTop: "-2rem" }}>
              {authError}
            </div>
          )}
        </>
      )}
      {phase === "app" && (
        <div className="app-shell">
          <Nav view={view} onChange={navigate} onLogout={logout} />
          <main className="app-main">
            {view === "dashboard" && <Dashboard />}
            {view === "overrides" && <Overrides />}
            {view === "settings" && <Settings />}
            {view === "forecast" && <Forecast />}
          </main>
        </div>
      )}
    </ToastProvider>
  );
}
