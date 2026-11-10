import { useContext, useRef, useState } from "react";
import { RegistryContext } from "@effect/atom-react";
import type { EnvironmentId, PluginCatalog } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AtomRegistry, type Atom, type AsyncResult } from "effect/reactivity";
import type { createServerEnvironmentAtoms } from "./state/server.ts";
import { runAtomCommand } from "./state/runtime.ts";
import { installPluginOnMachines, type PluginInstallationResult } from "./pluginInstallation.ts";

export function usePluginInstallation(
  server: Pick<ReturnType<typeof createServerEnvironmentAtoms>, "managePlugins" | "pluginCatalog">,
  machines: readonly {
    environmentId: EnvironmentId;
    label: string;
    connection: { phase: string };
  }[],
) {
  const registry = useContext(RegistryContext);

  const [repository, setRepository] = useState("");
  const [results, setResults] = useState<readonly PluginInstallationResult[]>([]);
  const [busy, setBusy] = useState(false);
  const running = useRef(false);
  const submitted = useRef("");
  const run = async (ids: readonly EnvironmentId[], retry = false) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    if (!retry) {
      submitted.current = repository.trim();
      setResults([]);
    }
    try {
      await installPluginOnMachines(
        submitted.current,
        ids,
        {
          connected: (id) =>
            machines.some(
              (machine) => machine.environmentId === id && machine.connection.phase === "connected",
            ),
          allowed: (id) => registry.get(server.managePlugins.permissionAtom(id)),
          catalog: (environmentId) => {
            const query = server.pluginCatalog({ environmentId, input: {} });
            registry.refresh(query);
            return readCatalog(registry, query);
          },
          install: async (environmentId, source) => {
            const result = await runAtomCommand(
              registry,
              server.managePlugins,
              { environmentId, input: { operation: "install", repository: source } },
              { reportFailure: false },
            );
            registry.refresh(server.pluginCatalog({ environmentId, input: {} }));
            if (result._tag !== "Success") throw new Error("Install failed");
            return result.value;
          },
        },
        (result) =>
          setResults((current) => [
            ...current.filter((item) => item.environmentId !== result.environmentId),
            result,
          ]),
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return { repository, setRepository, results, busy, run };
}

function readCatalog<E>(
  registry: AtomRegistry.AtomRegistry,
  query: Atom.Atom<AsyncResult.AsyncResult<PluginCatalog, E>>,
) {
  return Effect.runPromise(
    AtomRegistry.getResult(registry, query, { suspendOnWaiting: true }).pipe(
      Effect.timeout("15 seconds"),
    ),
  );
}
