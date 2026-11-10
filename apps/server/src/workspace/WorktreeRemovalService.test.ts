import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  GitCommandError,
  ThreadId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  type OrchestrationV2InternalCommand,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as PluginRegistry from "../plugins/PluginRegistry.ts";
import * as WorktreeRemoval from "./WorktreeRemovalService.ts";

it.effect.each([
  {
    owners: [
      { id: "live", deleted: false },
      { id: "deleted", deleted: true },
    ],
    expected: ["live"],
  },
  {
    owners: [
      { id: "older", deleted: true },
      { id: "latest", deleted: true },
    ],
    expected: ["latest"],
  },
  {
    owners: [
      { id: "one", deleted: false },
      { id: "two", deleted: false },
    ],
    expected: ["one", "two"],
  },
])(
  "posts failed removal to its owners without reviving unrelated deleted threads: $expected",
  ({ owners, expected }) => {
    const failure = new GitCommandError({
      operation: "worktree.removing",
      command: "plugin-lifecycle",
      cwd: "/repo",
      detail: "Stop containers: exit 7.",
    });
    const dispatched: Array<
      Extract<OrchestrationV2InternalCommand, { type: "thread.worktree-cleanup.fail" }>
    > = [];
    const now = DateTime.makeUnsafe(0);
    const threads: OrchestrationV2AppThread[] = owners.map((owner, index) => {
      const id = ThreadId.make(owner.id);
      return {
        id,
        createdBy: "user",
        creationSource: "web",
        projectId: ProjectId.make("project:cleanup-owner"),
        title: owner.id,
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "feature",
        worktreePath: "/worktrees/feature",
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
        forkedFrom: null,
        createdAt: now,
        updatedAt: DateTime.makeUnsafe(index),
        archivedAt: null,
        settledOverride: "settled",
        settledAt: now,
        lastVisitedAt: null,
        deletedAt: owner.deleted ? now : null,
      };
    });
    const database = SqlitePersistence.layerMemory;
    const layer = WorktreeRemoval.layer.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.mock(GitWorkflow.GitWorkflowService)({
            removeWorktree: () => Effect.fail(failure),
          }),
          Layer.mock(PluginRegistry.PluginRegistry)({}),
          ProjectionStore.layer.pipe(Layer.provide(database)),
          Layer.mock(Orchestrator.OrchestratorV2)({
            dispatch: (command) =>
              Effect.sync(() => {
                if (command.type !== "thread.worktree-cleanup.fail")
                  throw Error("Unexpected command");
                dispatched.push(command);
                return { sequence: 1, storedEvents: [] };
              }),
          }),
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    );
    return Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      for (const thread of threads)
        yield* store.apply({
          id: EventId.make(`create:${thread.id}`),
          type: "thread.created",
          threadId: thread.id,
          occurredAt: now,
          payload: thread,
        });
      const service = yield* WorktreeRemoval.WorktreeRemovalService;
      expect(yield* Effect.flip(service.remove({ cwd: "/repo", path: "/worktrees/feature" }))).toBe(
        failure,
      );
      expect(dispatched.map((command) => command.threadId)).toEqual(expected);
      for (const command of dispatched)
        expect(command).toMatchObject({
          type: "thread.worktree-cleanup.fail",
          worktreePath: "/worktrees/feature",
          message: expect.stringContaining("Stop containers: exit 7."),
        });
    }).pipe(Effect.provide(layer));
  },
);
