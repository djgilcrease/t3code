import type { OrchestrationV2ThreadShell, PluginNotificationKind } from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";

type Thread = Pick<
  OrchestrationV2ThreadShell,
  | "lineage"
  | "archivedAt"
  | "pendingRuntimeRequest"
  | "pendingGuestMessageCount"
  | "status"
  | "activityRunStatus"
  | "pendingBackgroundTasks"
  | "latestRunStopRequested"
  | "latestRunId"
  | "latestRunCompletedAt"
  | "lastErrorClass"
>;

function observation(thread: Thread): { kind: PluginNotificationKind; identity: string } | null {
  if (thread.archivedAt !== null) return null;
  const request = thread.pendingRuntimeRequest;
  if (request !== null && request.kind !== "auth_refresh") {
    return {
      kind: request.kind === "user_input" ? "input" : "approval",
      identity: request.id,
    };
  }
  if ((thread.pendingGuestMessageCount ?? 0) > 0) {
    return { kind: "guest-request", identity: `${thread.latestRunId}:guest` };
  }
  if (thread.activityRunStatus != null) return null;
  if (thread.status === "failed") {
    return {
      kind: thread.lastErrorClass === "usage_limit" ? "usage-limit" : "failure",
      identity: thread.latestRunId ?? "",
    };
  }
  if (
    thread.status === "completed" &&
    thread.latestRunStopRequested !== true &&
    !backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? []) &&
    thread.latestRunCompletedAt != null
  ) {
    return {
      kind: "completion",
      identity: `${thread.latestRunId}:${DateTime.formatIso(thread.latestRunCompletedAt)}`,
    };
  }
  return null;
}

export function notificationTransition(before: Thread | null, after: Thread | null) {
  if (before === null || after === null) return null;
  const next = observation(after);
  if (after.lineage.relationshipToParent === "subagent" || after.lineage.sideChat === true) {
    if (next?.kind !== "input" && next?.kind !== "approval") return null;
  }
  if (next === null) return null;
  const prior = observation(before);
  return prior?.kind === next.kind && prior.identity === next.identity ? null : next;
}
