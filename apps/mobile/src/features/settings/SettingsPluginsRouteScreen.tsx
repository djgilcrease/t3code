import { View } from "react-native";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { AppText as Text } from "../../components/ui/AppText";
import { PluginPanels } from "../plugins/PluginPanels";
import { SettingsScreen } from "./components/SettingsScreen";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

export function SettingsPluginsRouteScreen() {
  const { selectedTargets, selectedProjectKey } = useSettingsEnvironmentFilter();
  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Plugins" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScreenScrollView
          contentInsetAdjustmentBehavior="automatic"
          className="flex-1"
          contentContainerClassName="gap-4 px-5 py-4"
        >
          {selectedProjectKey !== null ? (
            <Text>Select an environment to manage its plugins.</Text>
          ) : (
            selectedTargets.map((target) => (
              <View key={target.environmentId} className="gap-3">
                <Text className="font-t3-medium text-foreground">{target.label}</Text>
                <PluginPanels environmentId={target.environmentId} location="settings" />
              </View>
            ))
          )}
        </ScreenScrollView>
      </SettingsScreen>
    </>
  );
}
