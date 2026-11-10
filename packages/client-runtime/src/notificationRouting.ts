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

function clientNoticeMatches(
  catalogs: readonly { readonly environmentId: string; readonly catalog: PluginCatalog | null }[],
  event: {
    readonly kind: PluginNotificationKind;
    readonly environmentId?: string;
    readonly projectId?: string;
    readonly provider?: string;
  } = { kind: "notice" },
) {
  const matches = catalogs.flatMap(({ environmentId, catalog }) =>
    event.environmentId !== undefined && event.environmentId !== environmentId
      ? []
      : (catalog?.plugins ?? []).flatMap((plugin) =>
          plugin.status !== "active"
            ? []
            : (plugin.notificationRoutes ?? [])
                .filter(
                  (route) =>
                    route.events.includes(event.kind) &&
                    (route.projects.length === 0 ||
                      route.projects.includes(event.projectId ?? "")) &&
                    (route.providers.length === 0 ||
                      route.providers.includes(event.provider ?? "")),
                )
                .map((route) => ({
                  environmentId,
                  pluginId: plugin.id,
                  route,
                  command: plugin.commands.find((command) => command.id === route.forwardCommand),
                })),
        ),
  );
  return matches;
}

export function resolveClientNoticeRoute(...input: Parameters<typeof clientNoticeMatches>) {
  const matches = clientNoticeMatches(...input);
  return matches.length === 1 ? matches[0] : undefined;
}
export function clientNoticeRoutingConflicted(catalogs: Parameters<typeof clientNoticeMatches>[0]) {
  return clientNoticeMatches(catalogs).length > 1;
}

export function clientNotificationRevisionId(id: string, content: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index++)
    hash = Math.imul(hash ^ content.charCodeAt(index), 0x01000193);
  return `${id.slice(0, 140)}:${(hash >>> 0).toString(16)}`;
}
