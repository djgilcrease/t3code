import {
  EnvironmentId,
  type PluginCommandInput,
  type PluginManagedEnvironment,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { connectionRoutes } from "../connection/routes.ts";
import type { ConnectionCatalogEntry, PluginConnectionOwner } from "../connection/catalog.ts";

export interface ManagedPluginEnvironment extends PluginManagedEnvironment {
  readonly owner: PluginConnectionOwner;
  readonly command: PluginCommandInput;
}

export function createManagedPluginConnections(ports: {
  readonly execute: (environmentId: EnvironmentId, command: PluginCommandInput) => Promise<unknown>;
  readonly connect: (input: {
    readonly pairingUrl: string;
    readonly expectedEnvironmentId: EnvironmentId;
    readonly managedBy: PluginConnectionOwner;
  }) => Promise<void>;
  readonly remove: (input: {
    readonly environmentId: EnvironmentId;
    readonly managedBy: PluginConnectionOwner;
  }) => Promise<void>;
  readonly allowLoopback: (owner: EnvironmentId) => boolean;
  readonly now?: () => number;
}) {
  const pending = new Map<string, Promise<void>>();
  const retries = new Map<string, { count: number; after: number }>();
  let closed = false;
  let latest: readonly ManagedPluginEnvironment[] = [];
  const now = ports.now ?? Date.now;
  const reconcile = (
    resources: readonly ManagedPluginEnvironment[],
    entries: ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>,
  ) => {
    latest = resources;
    const jobs: Promise<void>[] = [];
    for (const resource of resources) {
      const environmentId = EnvironmentId.make(resource.environmentId);
      if (environmentId === resource.owner.environmentId || closed) continue;
      const key = `${resource.owner.environmentId}:${resource.owner.pluginId}:${environmentId}`;
      const entry = entries.get(environmentId);
      const profile = entry && Option.getOrNull(entry.profile);
      const owned =
        profile?._tag === "BearerConnectionProfile" &&
        profile.managedBy?.environmentId === resource.owner.environmentId &&
        profile.managedBy.pluginId === resource.owner.pluginId;
      const remove = resource.state === "deleted" && owned;
      if (!remove && (resource.state !== "running" || (entry !== undefined && !owned))) continue;
      if (
        !remove &&
        entry &&
        connectionRoutes(entry).some((route) => {
          const candidate = Option.getOrNull(route.profile);
          return (
            candidate?._tag === "BearerConnectionProfile" &&
            candidate.httpBaseUrl.replace(/\/+$/, "") === resource.url.replace(/\/+$/, "")
          );
        })
      )
        continue;
      if (!remove) {
        let url: URL;
        try {
          url = new URL(resource.url);
        } catch {
          continue;
        }
        if (
          !["https:", "http:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash
        )
          continue;
        if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
          const controller = entries.get(resource.owner.environmentId);
          const localController =
            controller !== undefined &&
            connectionRoutes(controller).some((route) => {
              const profile = Option.getOrNull(route.profile);
              const address =
                route.target._tag === "PrimaryConnectionTarget"
                  ? route.target.httpBaseUrl
                  : profile?._tag === "BearerConnectionProfile"
                    ? profile.httpBaseUrl
                    : null;
              return (
                address !== null &&
                ["localhost", "127.0.0.1", "[::1]"].includes(new URL(address).hostname)
              );
            });
          if (!localController || !ports.allowLoopback(resource.owner.environmentId)) continue;
        }
      }
      const inFlight = pending.get(key);
      if (inFlight) {
        jobs.push(inFlight);
        continue;
      }
      if ((retries.get(key)?.after ?? 0) > now()) continue;
      const job = (async () => {
        try {
          if (remove) await ports.remove({ environmentId, managedBy: resource.owner });
          else {
            const reply = await ports.execute(resource.owner.environmentId, resource.command);
            if (
              closed ||
              !latest.some(
                (item) => item.environmentId === environmentId && item.state === "running",
              )
            )
              return;
            if (
              typeof reply !== "object" ||
              reply === null ||
              !("$t3" in reply) ||
              reply.$t3 !== "secret" ||
              !("value" in reply) ||
              typeof reply.value !== "string"
            )
              throw new Error("Invalid pairing result");
            if (new URL(reply.value).origin !== new URL(resource.url).origin)
              throw new Error("Pairing origin differs from advertised environment");
            await ports.connect({
              pairingUrl: reply.value,
              expectedEnvironmentId: environmentId,
              managedBy: resource.owner,
            });
          }
          retries.delete(key);
        } catch {
          const count = (retries.get(key)?.count ?? 0) + 1;
          retries.set(key, {
            count,
            after: now() + Math.min(3600000, 30000 * 2 ** Math.min(count - 1, 7)),
          });
        } finally {
          pending.delete(key);
        }
      })();
      pending.set(key, job);
      jobs.push(job);
    }
    return Promise.all(jobs).then(() => undefined);
  };
  return {
    reconcile,
    close: () => {
      closed = true;
    },
  };
}
