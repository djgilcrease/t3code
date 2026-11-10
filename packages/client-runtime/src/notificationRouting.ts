import type { PluginCatalog, PluginNotificationKind } from "@t3tools/contracts";

export function resolvePluginNotificationRoute(
  catalog: PluginCatalog | null,
  event: {
    readonly kind: PluginNotificationKind;
    readonly projectId: string;
    readonly provider: string;
  },
) {
  const matching = (catalog?.plugins ?? []).flatMap((plugin) =>
    plugin.status !== "active"
      ? []
      : (plugin.notificationRoutes ?? []).filter(
          (route) =>
            route.events.includes(event.kind) &&
            (route.projects.length === 0 || route.projects.includes(event.projectId)) &&
            (route.providers.length === 0 || route.providers.includes(event.provider)),
        ),
  );
  // Ambiguous ownership falls back to the device's builtin preferences.
  return matching.length === 1 ? matching[0] : undefined;
}
