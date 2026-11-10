import type { OrchestrationV2ThreadShell, PluginActivity } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

type ActivityThread = Pick<
  OrchestrationV2ThreadShell,
  | "archivedAt"
  | "settledAt"
  | "snoozedAt"
  | "status"
  | "pendingRuntimeRequest"
  | "pendingBackgroundTasks"
  | "updatedAt"
>;
export function summarizePluginActivity(threads: readonly ActivityThread[]): PluginActivity {
  const open = threads.filter(
    (thread) => !thread.archivedAt && !thread.settledAt && !thread.snoozedAt,
  );
  return {
    active: open.some(
      (thread) =>
        (thread.pendingBackgroundTasks?.length ?? 0) > 0 ||
        (thread.pendingRuntimeRequest?.blocking !== true &&
          ["preparing", "queued", "starting", "running"].includes(thread.status)),
    ),
    waiting: open.some(
      (thread) => thread.pendingRuntimeRequest !== null || thread.status === "waiting",
    ),
    closed: open.length === 0,
    lastActivity: threads.reduce(
      (latest, thread) => Math.max(latest, DateTime.toEpochMillis(thread.updatedAt)),
      0,
    ),
  };
}
