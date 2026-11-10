import { expect, it } from "@effect/vitest";
import type { PluginCatalog } from "@t3tools/contracts";
import {
  clientNotificationRevisionId,
  resolveClientNoticeRoute,
  clientNoticeRoutingConflicted,
  resolvePluginNotificationRoute,
} from "./notificationRouting.ts";

it("uses one explicit active matching route and falls back on absence or conflicting ownership", () => {
  const route = {
    id: "client",
    events: ["completion" as const],
    projects: ["project"],
    providers: ["codex"],
    inApp: true,
    mode: "sound" as const,
  };
  const plugin = {
    id: "router",
    name: "Router",
    version: "1",
    status: "active" as const,
    commands: [],
    views: [],
    notificationRoutes: [route],
  };
  const catalog: PluginCatalog = { configurationError: false, plugins: [plugin] };
  const event = { kind: "completion" as const, projectId: "project", provider: "codex" };
  expect(resolvePluginNotificationRoute(catalog, event)).toEqual(route);
  expect(resolvePluginNotificationRoute(null, event)).toBeUndefined();
  expect(resolvePluginNotificationRoute(catalog, { ...event, provider: "claude" })).toBeUndefined();
  expect(resolvePluginNotificationRoute(catalog, { ...event, projectId: "other" })).toBeUndefined();
  expect(resolvePluginNotificationRoute(catalog, { ...event, kind: "approval" })).toBeUndefined();
  expect(
    resolvePluginNotificationRoute(
      { ...catalog, plugins: [{ ...plugin, status: "disabled" }] },
      event,
    ),
  ).toBeUndefined();
  expect(
    resolvePluginNotificationRoute(
      { ...catalog, plugins: [plugin, { ...plugin, id: "second" }] },
      event,
    ),
  ).toBeUndefined();
});

it("routes client notices only with known matching context and refuses ambiguous connected owners", () => {
  const route = {
    id: "notices",
    events: ["notice" as const],
    projects: ["project"],
    providers: ["account"],
    inApp: true,
    mode: "off" as const,
    forwardCommand: "forward",
  };
  const catalog: PluginCatalog = {
    configurationError: false,
    plugins: [
      {
        id: "router",
        name: "Router",
        version: "1",
        status: "active",
        commands: [
          {
            id: "forward",
            title: "Forward",
            description: "Forward",
            permission: "settings:write",
            agent: false,
          },
        ],
        views: [],
        notificationRoutes: [route],
      },
    ],
  };
  const catalogs = [{ environmentId: "one", catalog }];
  expect(resolveClientNoticeRoute(catalogs)).toBeUndefined();
  expect(
    resolveClientNoticeRoute(catalogs, { kind: "notice", projectId: "project" }),
  ).toBeUndefined();
  const event = {
    kind: "notice" as const,
    environmentId: "one",
    projectId: "project",
    provider: "account",
  };
  expect(resolveClientNoticeRoute(catalogs, event)?.command?.id).toBe("forward");
  expect(resolveClientNoticeRoute(catalogs, { ...event, environmentId: "two" })).toBeUndefined();
  const unfiltered = {
    ...catalog,
    plugins: catalog.plugins.map((plugin) => ({
      ...plugin,
      notificationRoutes: [{ ...route, projects: [], providers: [] }],
    })),
  };
  const connected = [
    { environmentId: "one", catalog: unfiltered },
    { environmentId: "two", catalog: unfiltered },
  ];
  expect(clientNoticeRoutingConflicted(connected)).toBe(true);
  expect(resolveClientNoticeRoute(connected)).toBeUndefined();
  expect(resolveClientNoticeRoute(connected, event)?.environmentId).toBe("one");
});

it("keeps long source identities distinct after the readable id prefix is bounded", () => {
  const prefix = "guide:" + "x".repeat(180);
  expect(clientNotificationRevisionId(prefix + ":run-1", "Review ready")).not.toBe(
    clientNotificationRevisionId(prefix + ":run-2", "Review ready"),
  );
});
