import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, PluginId, type PluginCatalog } from "@t3tools/contracts";
import { installPluginOnMachines } from "./pluginInstallation.ts";

const a = EnvironmentId.make("a");
const b = EnvironmentId.make("b");
const empty: PluginCatalog = { configurationError: false, plugins: [] };
const installed: PluginCatalog = {
  configurationError: false,
  plugins: [
    {
      id: PluginId.make("demo"),
      name: "Demo",
      version: "1.0.0",
      status: "active",
      commands: [],
      views: [],
      source: {
        repository: "https://github.com/dj/plugin.git",
        tag: "v1.0.0",
        commit: "abc",
        latestTag: "v2.0.0",
        latestCommit: "def",
        checkedAt: 0,
        checkFailed: false,
      },
    },
  ],
};
describe("plugin installation destinations", () => {
  it("keeps successful destinations when another fails and retries only the chosen machine", async () => {
    const install = vi.fn(async (id: EnvironmentId) => {
      if (id === b) throw new Error("offline");
      return installed;
    });
    const ports = {
      catalog: async () => empty,
      install,
      allowed: () => true,
      connected: () => true,
    };
    const results = await installPluginOnMachines("HTTPS://GITHUB.COM/dj/plugin", [a, b], ports);
    expect(results.map((r) => r.state)).toEqual(["installed", "failed"]);
    install.mockClear();
    await installPluginOnMachines("https://github.com/dj/plugin", [b], ports);
    expect(install.mock.calls.map(([id]) => id)).toEqual([b]);
  });
  it("does not install on denied or offline machines, or on machines outside the snapshot", async () => {
    const install = vi.fn(async () => installed);
    const results = await installPluginOnMachines("https://github.com/dj/plugin", [a, b], {
      catalog: async () => empty,
      install,
      allowed: (id) => id !== a,
      connected: (id) => id !== b,
    });
    expect(results.map((r) => r.state)).toEqual(["denied", "offline"]);
    expect(install).not.toHaveBeenCalled();
    await installPluginOnMachines("https://github.com/dj/plugin", [a], {
      catalog: async () => empty,
      install,
      allowed: () => true,
      connected: () => true,
    });
    expect(install.mock.calls).toHaveLength(1);
  });
  it("preserves existing versions and disabled configuration without updating, and reports unsupported catalogs", async () => {
    const install = vi.fn(async () => installed);
    const results = await installPluginOnMachines("https://github.com/dj/plugin/", [a, b], {
      connected: () => true,
      allowed: () => true,
      install,
      catalog: async (id) => {
        if (id === b) throw new Error("unsupported");
        return {
          ...installed,
          plugins: installed.plugins.map((plugin) => ({ ...plugin, status: "disabled" as const })),
        };
      },
    });
    expect(results.map((r) => r.state)).toEqual(["preserved", "unsupported"]);
    expect(results[0]?.detail).toContain("v1.0.0");
    expect(results[0]?.detail).toContain("disabled");
    expect(install).not.toHaveBeenCalled();
  });
});
