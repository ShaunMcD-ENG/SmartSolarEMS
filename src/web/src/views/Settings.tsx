import { settingsApi } from "../api";
import { useAsync } from "../hooks";
import { ErrorBlock, LoadingBlock } from "../components/StateBlock";
import {
  AmberCard,
  BatteryCard,
  DemandWindowCard,
  GoalsCard,
  ModeCard,
  SigenergyCard,
} from "../components/SettingsCards";

export function Settings() {
  const settings = useAsync(() => settingsApi.getAll(), []);

  return (
    <div>
      <div className="view-header">
        <h1>Settings</h1>
      </div>

      {settings.loading && !settings.data ? (
        <LoadingBlock label="Loading settings…" />
      ) : settings.error && !settings.data ? (
        <ErrorBlock message={settings.error} />
      ) : (
        <div className="settings-grid">
          <SigenergyCard initial={settings.data?.sigenergy ?? null} />
          <AmberCard
            initial={
              settings.data?.amber
                ? { ...settings.data.amber, tokenSet: settings.data.amber.apiToken.length > 0 }
                : null
            }
          />
          <BatteryCard initial={settings.data?.battery ?? null} />
          <GoalsCard initial={settings.data?.goals ?? null} />
          <DemandWindowCard initial={settings.data?.demandWindow ?? null} />
          <ModeCard initial={settings.data?.mode ?? null} />
        </div>
      )}
    </div>
  );
}
