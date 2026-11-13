import type { OrchestrationV2DomainEvent, OrchestrationV2TurnItem } from "@t3tools/contracts";
import { turnItemCanChangeUserWait } from "@t3tools/shared/agentAwareness";
import { turnItemUpdateCanEndBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";

function isTurnItemPayload(
  payload: unknown,
): payload is Pick<OrchestrationV2TurnItem, "type" | "status"> {
  return (
    typeof payload === "object" && payload !== null && "type" in payload && "status" in payload
  );
}

export function shouldRefreshNotificationPresentation(
  event: Pick<OrchestrationV2DomainEvent, "type"> & { readonly payload?: unknown },
): boolean {
  if (
    event.type === "thread.created" &&
    typeof event.payload === "object" &&
    event.payload !== null &&
    "historyOrigin" in event.payload &&
    event.payload.historyOrigin === "v1_import"
  ) {
    return false;
  }
  switch (event.type) {
    case "thread.created":
    case "thread.archived":
    case "thread.unarchived":
    case "thread.deleted":
    case "thread.metadata-updated":
    case "thread.pull-request-link-updated":
    case "thread.pull-request-synced":
    case "thread.settled":
    case "thread.model-selection-updated":
    case "thread.provider-switched":
    case "run.created":
    case "run.updated":
    case "runtime-request.updated":
    case "subagent.updated":
    case "provider-thread.updated":
      return true;
    // Unsettling must not re-alert a dismissed result.
    case "thread.unsettled":
    case "thread.guest-share-updated":
    case "thread.snoozed":
    case "thread.unsnoozed":
    case "thread.auto-settle-set":
    case "thread.pinned":
    case "thread.unpinned":
    case "thread.pin-reordered":
    case "thread.active-reordered":
    case "thread.tags-updated":
    case "thread.visited":
    case "thread.visit-recorded":
    case "thread.marked-unread":
    case "thread.runtime-mode-updated":
    case "thread.interaction-mode-updated":
    case "run.background-work-cancelled":
    case "run-attempt.created":
    case "run-attempt.updated":
    case "node.updated":
    case "provider-session.attached":
    case "provider-session.updated":
    case "provider-session.detached":
    case "provider-turn.updated":
    case "turn-item.updated":
      return (
        isTurnItemPayload(event.payload) &&
        (turnItemUpdateCanEndBackgroundWork(event.payload) ||
          turnItemCanChangeUserWait(event.payload))
      );
    case "message.updated":
    case "plan.updated":
    case "checkpoint-scope.created":
    case "checkpoint.captured":
    case "checkpoint.rollback-requested":
    case "context-handoff.updated":
    case "context-transfer.created":
    case "context-transfer.updated":
      return false;
  }
}
