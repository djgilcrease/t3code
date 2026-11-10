import { expect, it } from "@effect/vitest";
import { EnvironmentId, type PluginCatalog, type PluginView } from "@t3tools/contracts";
import { Atom, AsyncResult, AtomRegistry } from "effect/reactivity";
import { createPluginSummaryAtoms } from "./plugins.ts";

it("routes controller status to a disconnected managed environment without tinting the controller", () => {
  const controller = EnvironmentId.make("controller");
  const sandbox = EnvironmentId.make("sandbox");
  const catalog: PluginCatalog = {
    configurationError: false,
    plugins: [
      {
        id: "sandboxes",
        name: "Sandboxes",
        version: "1",
        status: "active",
        commands: [],
        views: [
          {
            id: "managed",
            title: "Managed",
            location: "thread-details",
            permission: "orchestration:read",
          },
        ],
      },
    ],
  };
  const view: PluginView = {
    title: "Managed",
    blocks: [
      {
        id: "status",
        kind: "status",
        environmentId: sandbox,
        tone: "muted",
        label: "Stopped",
        actions: [],
      },
    ],
  };
  const atoms = createPluginSummaryAtoms({
    connectedEnvironmentIdsAtom: Atom.make([controller]),
    pluginCatalog: () => Atom.make(AsyncResult.success(catalog)),
    pluginView: () => Atom.make(AsyncResult.success(view)),
  });
  const registry = AtomRegistry.make();
  try {
    const status = registry.get(atoms.pluginStatusByEnvironmentAtom);
    expect(status.has(controller)).toBe(false);
    expect(status.get(sandbox)?.[0]?.label).toBe("Stopped");
    expect(status.get(sandbox)?.[0]?.tone).toBe("muted");
  } finally {
    registry.dispose();
  }
});
