import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { summarizePluginActivity } from "./pluginActivity.ts";
const idle = {
  id: ThreadId.make("thread"),
  lineage: {
    rootThreadId: ThreadId.make("thread"),
    parentThreadId: null,
    relationshipToParent: null,
  },
  archivedAt: null,
  settledAt: null,
  snoozedAt: null,
  status: "completed" as const,
  pendingRuntimeRequest: null,
  pendingBackgroundTasks: [],
  updatedAt: DateTime.makeUnsafe(1234),
};
it("reports committed activity without treating a finished thread as closed", () => {
  expect(summarizePluginActivity([idle])).toEqual({
    active: false,
    waiting: false,
    closed: false,
    lastActivity: 1234,
    threads: [{ threadId: "thread", subagent: false }],
  });
  expect(summarizePluginActivity([{ ...idle, status: "running" }]).active).toBe(true);
  expect(summarizePluginActivity([{ ...idle, status: "waiting" }]).waiting).toBe(true);
  expect(summarizePluginActivity([{ ...idle, settledAt: DateTime.makeUnsafe(1234) }]).closed).toBe(
    true,
  );
  expect(
    summarizePluginActivity([{ ...idle, archivedAt: DateTime.makeUnsafe(1234), status: "running" }])
      .active,
  ).toBe(false);
  expect(summarizePluginActivity([]).closed).toBe(true);
  expect(
    summarizePluginActivity(
      [idle],
      new Map([
        ["thread", 5000],
        ["deleted", 9000],
      ]),
    ).lastActivity,
  ).toBe(5000);
  expect(
    summarizePluginActivity([{ ...idle, archivedAt: DateTime.makeUnsafe(1234) }]).threads,
  ).toEqual([{ threadId: "thread", subagent: false }]);
});
