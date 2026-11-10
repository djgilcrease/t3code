import { useAtomValue } from "@effect/atom-react";
import { createManagedPluginConnections } from "@t3tools/client-runtime/state/plugins";
import { useEffect, useRef } from "react";
import { readLocalApi } from "../../localApi";
import { environmentCatalog } from "../../connection/catalog";
import { connectPairing } from "../../connection/onboarding";
import { managedPluginEnvironmentsAtom } from "../../state/plugins";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

export function PluginManagedEnvironments() {
  const resources = useAtomValue(managedPluginEnvironmentsAtom);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const execute = useAtomCommand(serverEnvironment.executePluginCommand, { reportFailure: false });
  const connect = useAtomCommand(connectPairing, { reportFailure: false });
  const remove = useAtomCommand(environmentCatalog.removePluginManaged, { reportFailure: false });
  const ports = useRef({ execute, connect, remove });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keeps the long-lived discovery worker connected to current runtime command handlers.
  useEffect(() => {
    ports.current = { execute, connect, remove };
  }, [execute, connect, remove]);
  const actor = useRef<ReturnType<typeof createManagedPluginConnections> | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Owns automatic registrations in the external connection catalog for this client lifetime.
  useEffect(() => {
    actor.current = createManagedPluginConnections({
      execute: async (environmentId, input) => {
        const result = await ports.current.execute({ environmentId, input });
        if (result._tag !== "Success") throw new Error("Pairing request failed");
        return result.value;
      },
      connect: async (input) => {
        const result = await ports.current.connect(input);
        if (result._tag !== "Success") throw new Error("Pairing failed");
      },
      remove: async (input) => {
        const result = await ports.current.remove(input);
        if (result._tag !== "Success") throw new Error("Removal failed");
      },
      allowLoopback: () =>
        readLocalApi() !== null ||
        ["localhost", "127.0.0.1", "[::1]"].includes(globalThis.location?.hostname ?? ""),
    });
    return () => {
      actor.current?.close();
      actor.current = null;
    };
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Reconciles controller advertisements with persisted local connections after either source changes.
  useEffect(() => {
    if (catalog.isReady) void actor.current?.reconcile(resources, catalog.entries);
  }, [resources, catalog]);
  return null;
}
