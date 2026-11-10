import type { EnvironmentId, PluginCatalog } from "@t3tools/contracts";

export interface PluginInstallationResult {
  readonly environmentId: EnvironmentId;
  readonly state: "installed" | "preserved" | "denied" | "offline" | "failed" | "unsupported";
  readonly detail: string;
}

function repositoryKey(value: string) {
  try {
    const url = new URL(value.trim());
    url.pathname = url.pathname.replace(/\/$/, "").replace(/\.git$/, "");
    return url.href;
  } catch {
    return value.trim();
  }
}

export async function installPluginOnMachines(
  repository: string,
  destinations: readonly EnvironmentId[],
  ports: {
    connected: (id: EnvironmentId) => boolean;
    allowed: (id: EnvironmentId) => boolean;
    catalog: (id: EnvironmentId) => Promise<PluginCatalog>;
    install: (id: EnvironmentId, repository: string) => Promise<PluginCatalog>;
  },
  report?: (result: PluginInstallationResult) => void,
): Promise<PluginInstallationResult[]> {
  return Promise.all(
    [...new Set(destinations)].map(async (environmentId) => {
      const finish = (state: PluginInstallationResult["state"], detail: string) => {
        const result = { environmentId, state, detail };
        report?.(result);
        return result;
      };
      if (!ports.connected(environmentId))
        return finish("offline", "Offline. Reconnect and retry.");
      if (!ports.allowed(environmentId))
        return finish("denied", "Permission to manage plugins is required.");
      let catalog: PluginCatalog;
      try {
        catalog = await ports.catalog(environmentId);
      } catch {
        return finish(
          "unsupported",
          "Plugin management unavailable. Check the connection and server version, then retry.",
        );
      }
      if (catalog.configurationError)
        return finish("failed", "Fix this machine's plugin configuration before retrying.");
      const existing = catalog.plugins.find(
        (plugin) =>
          plugin.source && repositoryKey(plugin.source.repository) === repositoryKey(repository),
      );
      if (existing)
        return finish(
          "preserved",
          `Already installed: ${existing.source?.tag ?? existing.version} (${existing.status}). Kept existing configuration.`,
        );
      try {
        const installed = await ports.install(environmentId, repository);
        const plugin = installed.plugins.find(
          (entry) =>
            entry.source && repositoryKey(entry.source.repository) === repositoryKey(repository),
        );
        if (!plugin)
          return finish(
            "failed",
            "The machine did not confirm a repository installation. Refresh and retry.",
          );
        return finish(
          "installed",
          `${plugin.name} ${plugin.source?.tag ?? plugin.version} (${plugin.status})`,
        );
      } catch {
        return finish(
          "failed",
          "Install failed. Check access, repository compatibility, and existing plugin identity on this machine, then retry.",
        );
      }
    }),
  );
}
