import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { notificationTransition } from "./notificationTransition.ts";

const thread = {
  title: "Test",
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "thread-1" },
  archivedAt: null,
  pendingRuntimeRequest: null,
  status: "running",
  activityRunStatus: null,
  pendingBackgroundTasks: [],
  latestRunId: "run-1",
  latestRunCompletedAt: DateTime.makeUnsafe("2026-11-10T00:00:00Z"),
} as unknown as OrchestrationV2ThreadShell;

describe("notificationTransition", () => {
  it("records completion only once and suppresses baseline, archived and stopped runs", () => {
    const completed = { ...thread, status: "completed" as const };
    expect(notificationTransition(thread, completed)?.kind).toBe("completion");
    expect(notificationTransition(completed, completed)).toBeNull();
    expect(
      notificationTransition(thread, {
        ...completed,
        lineage: { ...thread.lineage, sideChat: true },
      }),
    ).toBeNull();
    expect(notificationTransition(null, completed)).toBeNull();
    expect(
      notificationTransition(thread, { ...completed, archivedAt: thread.latestRunCompletedAt! })
        ?.kind,
    ).toBe("clear");
    expect(
      notificationTransition(thread, { ...completed, latestRunStopRequested: true })?.kind,
    ).toBe("clear");
  });
  it("distinguishes usage limits from failures and retains request identity", () => {
    expect(notificationTransition(thread, { ...thread, status: "failed" })?.kind).toBe("failure");
    expect(
      notificationTransition(thread, { ...thread, status: "failed", lastErrorClass: "usage_limit" })
        ?.kind,
    ).toBe("usage-limit");
    const waiting = {
      ...thread,
      pendingRuntimeRequest: { id: "request-1", kind: "user_input", blocking: true },
    } as unknown as OrchestrationV2ThreadShell;
    expect(notificationTransition(thread, waiting)?.kind).toBe("input");
    expect(notificationTransition(waiting, waiting)).toBeNull();
    expect(
      notificationTransition(waiting, {
        ...waiting,
        pendingRuntimeRequest: { ...waiting.pendingRuntimeRequest!, id: "request-2" },
      } as OrchestrationV2ThreadShell)?.kind,
    ).toBe("input");
  });
});
