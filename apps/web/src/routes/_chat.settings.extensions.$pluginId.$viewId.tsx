import { createFileRoute } from "@tanstack/react-router";
import { PluginPanels } from "../components/plugins/PluginPanels";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { SettingsPageContainer, SettingsSection } from "../components/settings/settingsLayout";

function ExtensionSettings() {
  const { pluginId, viewId } = Route.useParams();
  const { connectedEnvironments } = useSettingsScope();
  return (
    <SettingsPageContainer>
      {connectedEnvironments.map((environment) => (
        <SettingsSection key={environment.environmentId} title={environment.label}>
          <PluginPanels
            environmentId={environment.environmentId}
            location="settings-page"
            pluginId={pluginId}
            viewId={viewId}
          />
        </SettingsSection>
      ))}
    </SettingsPageContainer>
  );
}
export const Route = createFileRoute("/_chat/settings/extensions/$pluginId/$viewId")({
  component: ExtensionSettings,
});
