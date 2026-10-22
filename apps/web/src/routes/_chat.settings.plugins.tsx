import { createFileRoute } from "@tanstack/react-router";
import { PluginPanels } from "../components/plugins/PluginPanels";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { SettingsPageContainer, SettingsSection } from "../components/settings/settingsLayout";

function PluginsSettings() {
  const { connectedEnvironments } = useSettingsScope();
  return (
    <SettingsPageContainer>
      {connectedEnvironments.map((environment) => (
        <SettingsSection key={environment.environmentId} title={environment.label}>
          <PluginPanels environmentId={environment.environmentId} location="settings" />
        </SettingsSection>
      ))}
    </SettingsPageContainer>
  );
}
export const Route = createFileRoute("/_chat/settings/plugins")({ component: PluginsSettings });
