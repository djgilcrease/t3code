import type { StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId } from "@t3tools/contracts";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { PluginPanels } from "../plugins/PluginPanels";
import { SettingsScreen } from "./components/SettingsScreen";

export function SettingsPluginPageRouteScreen({
  route,
}: StaticScreenProps<{
  environmentId: EnvironmentId;
  pluginId: string;
  viewId: string;
  title: string;
}>) {
  const { environmentId, pluginId, viewId, title } = route.params;
  return (
    <SettingsScreen title={title}>
      <ScreenScrollView className="flex-1" contentContainerClassName="gap-4 px-5 py-4">
        <PluginPanels
          environmentId={environmentId}
          pluginId={pluginId}
          viewId={viewId}
          location="settings-page"
        />
      </ScreenScrollView>
    </SettingsScreen>
  );
}
