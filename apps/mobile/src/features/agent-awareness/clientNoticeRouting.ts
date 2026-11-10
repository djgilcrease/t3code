import { AppState, Platform } from "react-native";
import { uuidv4 } from "../../lib/uuid";
import * as Notifications from "expo-notifications";
import { EnvironmentId } from "@t3tools/contracts";
import { resolveClientNoticeRoute } from "@t3tools/client-runtime/notificationRouting";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { rootPathnameFromState } from "../../Stack";
import { rootNavigationRef } from "../../lib/rootNavigation";
import { appAtomRegistry } from "../../state/atom-registry";
import { pluginCatalogsAtom } from "../../state/plugins";
import { serverEnvironment } from "../../state/server";
import {
  installClientNoticeRouter,
  refreshClientNoticeRouting,
} from "../../components/ui/clientNoticeRouter";

export function installClientNoticeRouting() {
  const registry = appAtomRegistry;
  const seen = new Set<string>();
  const sessionId = uuidv4();
  let nativeAllowed = false;
  const refreshPermissions = () => {
    void Notifications.getPermissionsAsync()
      .then((value) => {
        if (nativeAllowed !== value.granted) {
          nativeAllowed = value.granted;
          refreshClientNoticeRouting();
        }
      })
      .catch(() => undefined);
  };
  refreshPermissions();
  const appState = AppState.addEventListener("change", (state) => {
    if (state === "active") refreshPermissions();
  });
  const unsubscribeCatalog = registry.subscribe(pluginCatalogsAtom, () =>
    refreshClientNoticeRouting(),
  );
  const stop = installClientNoticeRouter({
    inApp: () => {
      const route = resolveClientNoticeRoute(registry.get(pluginCatalogsAtom))?.route;
      if (!route) return true;
      return route.inApp || (route.mode !== "off" && !nativeAllowed);
    },
    deliver: (notice) => {
      if (seen.has(notice.id)) return;
      const routing = resolveClientNoticeRoute(registry.get(pluginCatalogsAtom));
      if (!routing) return;
      seen.add(notice.id);
      if (seen.size > 1000) seen.delete(seen.values().next().value!);
      const navigation = rootNavigationRef.isReady() ? rootNavigationRef.getRootState() : undefined;
      const path = navigation ? rootPathnameFromState(navigation) : "/";
      if (routing.command) {
        const environmentId = EnvironmentId.make(routing.environmentId);
        const input = {
          pluginId: routing.pluginId,
          commandId: routing.command.id,
          permission: routing.command.permission,
          input: {
            id: `${sessionId}:${notice.id}`,
            title: notice.title.slice(0, 200),
            kind: "notice",
            path,
            ...(routing.route.includeDescription && notice.description
              ? { description: notice.description.slice(0, 16384) }
              : {}),
          },
        };
        if (
          registry.get(serverEnvironment.executePluginCommand.permissionAtom(environmentId, input))
        )
          void runAtomCommand(
            registry,
            serverEnvironment.executePluginCommand,
            { environmentId, input },
            { reportFailure: false, reportDefect: false },
          );
      }
      const mode = routing.route.mode === "inherit" ? "off" : routing.route.mode;
      if (mode === "off") return;
      void Notifications.getPermissionsAsync()
        .then(async (permission) => {
          if (nativeAllowed !== permission.granted) {
            nativeAllowed = permission.granted;
            refreshClientNoticeRouting();
          }
          if (!permission.granted) return;
          const sound = mode === "sound" || mode === "notifications-and-sound";
          const channelId = sound ? "t3-plugin-notices" : "t3-plugin-notices-silent";
          if (Platform.OS === "android")
            await Notifications.setNotificationChannelAsync(channelId, {
              name: sound ? "Extension notices" : "Extension notices (silent)",
              importance: Notifications.AndroidImportance.HIGH,
              sound: sound ? "default" : null,
            });
          await Notifications.scheduleNotificationAsync({
            identifier: `${sessionId}:${notice.id}`,
            trigger: Platform.OS === "android" ? { channelId } : null,
            content: {
              title: notice.title,
              ...(routing.route.includeDescription && notice.description
                ? { body: notice.description }
                : {}),
              sound,
              data: { t3PluginNotice: true, mode, pluginNoticePath: path },
            },
          });
        })
        .catch(() => undefined);
    },
  });
  return () => {
    stop();
    unsubscribeCatalog();
    appState.remove();
  };
}
