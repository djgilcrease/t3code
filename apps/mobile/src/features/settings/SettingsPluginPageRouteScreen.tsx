import { useAtomValue } from "@effect/atom-react";
import { pluginSettingsPages } from "@t3tools/client-runtime/plugins";
import { AsyncResult } from "effect/reactivity";
import { serverEnvironment } from "../../state/server";
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
}>) {
  const { environmentId, pluginId, viewId } = route.params;
  const result = useAtomValue(serverEnvironment.pluginCatalog({ environmentId, input: {} }));
  const catalog = AsyncResult.getOrElse(result, () => null);
  const page =
    catalog &&
    pluginSettingsPages(catalog).find(
      (page) => page.pluginId === pluginId && page.viewId === viewId,
    );
  return (
    <SettingsScreen title={page?.title ?? "Extension"}>
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
