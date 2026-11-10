import type { EnvironmentId, PluginCatalog, PluginTone, PluginView } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { type Atom as AtomType, Atom, AsyncResult } from "effect/reactivity";

import { pluginThreadDetailsViews } from "../plugins.ts";

export interface PluginEnvironmentStatus {
  readonly key: string;
  readonly tone: PluginTone;
  readonly label: string;
  readonly detail: string | null;
}
type StatusByEnvironment = ReadonlyMap<EnvironmentId, readonly PluginEnvironmentStatus[]>;

export function createPluginSummaryAtoms(input: {
  readonly connectedEnvironmentIdsAtom: AtomType.Atom<ReadonlyArray<EnvironmentId>>;
  readonly pluginCatalog: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: Record<string, never>;
  }) => AtomType.Atom<AsyncResult.AsyncResult<PluginCatalog, unknown>>;
  readonly pluginView: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly pluginId: string; readonly viewId: string };
  }) => AtomType.Atom<AsyncResult.AsyncResult<PluginView, unknown>>;
}) {
  /** One row per connected environment; a catalog that is still loading is null. */
  const pluginCatalogsAtom = Atom.make((get) =>
    get(input.connectedEnvironmentIdsAtom).map((environmentId) => ({
      environmentId,
      catalog: AsyncResult.getOrElse(
        get(input.pluginCatalog({ environmentId, input: {} })),
        () => null,
      ),
    })),
  );
  /**
   * Toned status items per environment, for thread rows. Read once per environment and kept
   * identical while nothing changed, so memoized rows do not re-render on a plugin refresh.
   */
  const pluginStatusByEnvironmentAtom = Atom.make((get): StatusByEnvironment => {
    const next = new Map<EnvironmentId, readonly PluginEnvironmentStatus[]>();
    for (const { environmentId, catalog } of get(pluginCatalogsAtom)) {
      if (catalog === null) continue;
      const statuses = pluginThreadDetailsViews(catalog).flatMap(({ plugin, viewId }) => {
        const view = AsyncResult.getOrElse(
          get(input.pluginView({ environmentId, input: { pluginId: plugin.id, viewId } })),
          () => null,
        );
        return (view?.blocks ?? []).flatMap((block) =>
          block.kind === "status" && block.tone !== undefined && block.label !== undefined
            ? [
                {
                  key: `${plugin.id}:${viewId}:${block.id}`,
                  tone: block.tone,
                  label: block.label,
                  detail: block.detail ?? null,
                },
              ]
            : [],
        );
      });
      if (statuses.length > 0) next.set(environmentId, statuses);
    }
    const previous = Option.getOrNull(get.self<StatusByEnvironment>());
    return previous !== null && JSON.stringify([...previous]) === JSON.stringify([...next])
      ? previous
      : next;
  });
  return { pluginCatalogsAtom, pluginStatusByEnvironmentAtom };
}
