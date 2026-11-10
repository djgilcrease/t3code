import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PluginTone } from "@t3tools/contracts";

import { cn } from "../../lib/utils";
import { pluginStatusByEnvironmentAtom } from "../../state/plugins";

export const PLUGIN_TONE_DOT_CLASS: Record<PluginTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-destructive",
  muted: "bg-muted-foreground",
};

/** One shared atom feeds every thread row, so a row costs a subscription and no request. */
export function PluginStatusDots({ environmentId }: { environmentId: EnvironmentId }) {
  const statuses = useAtomValue(pluginStatusByEnvironmentAtom).get(environmentId);
  if (statuses === undefined) return null;
  return (
    <span className="inline-flex shrink-0 items-center gap-0.5" data-plugin-status>
      {statuses.map((status) => (
        <span
          key={status.key}
          className={cn("size-1.5 rounded-full", PLUGIN_TONE_DOT_CLASS[status.tone])}
        />
      ))}
    </span>
  );
}
