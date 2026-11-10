import { pluginSettingsPages } from "@t3tools/client-runtime/plugins";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom, AsyncResult } from "effect/reactivity";
import { BlocksIcon } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { serverEnvironment } from "../../state/server";
import { useOptionalSettingsScope } from "../settings/SettingsScopeContext";

const pagesAtom = Atom.family((targetsKey: string) =>
  Atom.make((get) => {
    const targets = JSON.parse(targetsKey) as readonly {
      environmentId: EnvironmentId;
      label: string;
    }[];
    return targets.flatMap((target) => {
      const result = get(
        serverEnvironment.pluginCatalog({ environmentId: target.environmentId, input: {} }),
      );
      const catalog = AsyncResult.getOrElse(result, () => null);
      return catalog ? pluginSettingsPages(catalog).map((page) => ({ ...target, ...page })) : [];
    });
  }),
);

export function usePluginSettingsPages() {
  const connectedEnvironments = useOptionalSettingsScope()?.connectedEnvironments ?? [];
  const pages = useAtomValue(
    pagesAtom(
      JSON.stringify(
        connectedEnvironments.map(({ environmentId, label }) => ({ environmentId, label })),
      ),
    ),
  );
  return pages;
}

export function PluginSettingsLinks({
  query,
  compact = false,
}: {
  query: string;
  compact?: boolean;
}) {
  const connectedEnvironments = useOptionalSettingsScope()?.connectedEnvironments ?? [];
  const pages = usePluginSettingsPages();
  const visible = pages.filter((page) =>
    page.title.toLowerCase().includes(query.trim().toLowerCase()),
  );
  if (visible.length === 0) return null;
  return (
    <section aria-label="Extensions" className="flex flex-col gap-1 px-2">
      <h3
        className={`px-2 text-xs text-sidebar-muted-foreground ${compact ? "max-md:sr-only" : ""}`}
      >
        Extensions
      </h3>
      {visible.map((page) => (
        <Link
          key={`${page.environmentId}:${page.pluginId}:${page.viewId}`}
          to="/settings/extensions/$pluginId/$viewId"
          params={{ pluginId: page.pluginId, viewId: page.viewId }}
          search={{ machine: page.environmentId }}
          className="flex items-center gap-2 rounded-md px-2 py-2 text-sm hover:bg-sidebar-row-hover"
          activeProps={{ "aria-current": "page", className: "bg-sidebar-row-hover" }}
          title={`${page.title} · ${page.label}`}
        >
          <BlocksIcon className="size-4 shrink-0" />
          <span className={`truncate ${compact ? "max-md:sr-only" : ""}`}>
            {page.title}
            {connectedEnvironments.length > 1 ? ` · ${page.label}` : ""}
          </span>
        </Link>
      ))}
    </section>
  );
}
