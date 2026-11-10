import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { pluginDestinationLabel } from "@t3tools/client-runtime/plugins";
import { usePluginInstallation } from "@t3tools/client-runtime/plugin-installation";
import { PluginPanels } from "../components/plugins/PluginPanels";
import { EnvironmentScopeMenu } from "../components/settings/SettingsScopeSentence";
import { SettingsPageContainer, SettingsSection } from "../components/settings/settingsLayout";
import { useEnvironments } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";

function PluginsSettings() {
  const { environments } = useEnvironments();
  const machines = environments.map((entry) => ({
    ...entry,
    label: pluginDestinationLabel(
      entry,
      environments
        .filter((other) => other.environmentId !== entry.environmentId)
        .map((other) => other.label),
    ),
  }));
  const [machine, setMachine] = useState<EnvironmentId | null>(null);
  const installation = usePluginInstallation(serverEnvironment, machines);
  const targets = machines.filter((environment) =>
    machine === null
      ? environment.connection.phase === "connected"
      : environment.environmentId === machine,
  );
  return (
    <SettingsPageContainer>
      <div className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
        <span>Installing plugins on</span>
        <EnvironmentScopeMenu
          value={machine ? { machine } : {}}
          groups={[]}
          environments={environments}
          singleEnvironment={false}
          onChange={(next) => setMachine(next.machine ? (next.machine as EnvironmentId) : null)}
        />
      </div>
      <SettingsSection title="Install plugin">
        <div className="space-y-4 p-4">
          <p className="text-sm text-muted-foreground">
            All installs on machines connected when you press Install. Newly connected machines need
            another All install. Reconnect failed machines and retry below. Existing installs are
            kept, including their versions and settings.
          </p>
          <p className="text-sm text-muted-foreground">
            Plugins run trusted code. Each machine verifies and installs its latest stable
            repository version using its own Git credentials. Versions may differ. Plugin data,
            secrets, settings, and local paths are never copied.
          </p>
          <form
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void installation.run(targets.map((target) => target.environmentId));
            }}
          >
            <label className="min-w-48 flex-1 space-y-1 text-sm">
              <span>Repository URL</span>
              <Input
                type="url"
                required
                placeholder="https://github.com/owner/plugin"
                value={installation.repository}
                disabled={installation.busy}
                onChange={(event) => installation.setRepository(event.target.value)}
              />
            </label>
            <Button
              type="submit"
              size="sm"
              disabled={
                installation.busy || !installation.repository.trim() || targets.length === 0
              }
            >
              {installation.busy
                ? "Installing…"
                : machine === null
                  ? "Install on All"
                  : "Install on this machine"}
            </Button>
          </form>
          <div aria-live="polite" className="space-y-2">
            {installation.results.map((result) => (
              <div key={result.environmentId} className="space-y-1 text-sm">
                <p>
                  {machines.find((entry) => entry.environmentId === result.environmentId)?.label ??
                    result.environmentId}
                  : {result.detail}
                </p>
                {result.state !== "installed" && result.state !== "preserved" && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={installation.busy}
                    onClick={() => void installation.run([result.environmentId], true)}
                  >
                    Retry this machine
                  </Button>
                )}
              </div>
            ))}
          </div>
        </div>
      </SettingsSection>
      {targets.length === 0 && (
        <p className="text-sm text-muted-foreground">No machines connected.</p>
      )}
      {targets.map((environment) => (
        <SettingsSection key={environment.environmentId} title={environment.label}>
          {environment.connection.phase === "connected" ? (
            <div className="p-4">
              <PluginPanels environmentId={environment.environmentId} location="settings" />
            </div>
          ) : (
            <p>Offline. Reconnect to manage plugins.</p>
          )}
        </SettingsSection>
      ))}
    </SettingsPageContainer>
  );
}
export const Route = createFileRoute("/_chat/settings/plugins")({ component: PluginsSettings });
