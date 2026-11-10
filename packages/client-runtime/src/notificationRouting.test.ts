import { expect, it } from "@effect/vitest";
import type { PluginCatalog } from "@t3tools/contracts";
import { resolvePluginNotificationRoute } from "./notificationRouting.ts";

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
