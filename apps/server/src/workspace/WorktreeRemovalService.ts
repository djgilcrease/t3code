import {
  CommandId,
  GitCommandError,
  type ThreadId,
  type VcsRemoveWorktreeInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Path from "effect/Path";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as PluginRegistry from "../plugins/PluginRegistry.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";

export class WorktreeRemovalService extends Context.Service<
  WorktreeRemovalService,
  {
    readonly remove: (input: VcsRemoveWorktreeInput) => Effect.Effect<void, GitCommandError>;
    readonly beforeRemove: (input: VcsRemoveWorktreeInput) => Effect.Effect<void, GitCommandError>;
    readonly afterRemove: (input: VcsRemoveWorktreeInput) => Effect.Effect<void>;
    readonly reportFailure: (input: {
      cwd: string;
      path: string;
      message: string;
      threadId?: ThreadId;
    }) => Effect.Effect<void, GitCommandError>;
  }
>()("t3/workspace/WorktreeRemovalService") {}

const make = Effect.gen(function* () {
  const workflow = yield* GitWorkflowService.GitWorkflowService;
  const plugins = yield* PluginRegistry.PluginRegistry;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const engine = yield* Orchestrator.OrchestratorV2;
  const random = yield* SecureRandom.SecureRandom;
  const path = yield* Path.Path;
  const reportFailure = Effect.fn("WorktreeRemovalService.reportFailure")(
    function* (input: { cwd: string; path: string; message: string; threadId?: ThreadId }) {
      const worktreePath = path.resolve(input.cwd, input.path);
      const candidates = input.threadId
        ? [input.threadId]
        : (yield* projections.getThreadWorktreePaths({
            includeArchived: true,
            includeDeleted: true,
            worktreePath,
          })).map((thread) => thread.threadId);
      const threads = yield* Effect.forEach(candidates, (id) =>
        projections
          .getThread(id)
          .pipe(
            Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }),
          ),
      );
      const owners = threads
        .filter((thread) => thread !== null)
        .filter((thread) => thread.worktreePath === worktreePath);
      const live = owners.filter((thread) => thread.deletedAt === null);
      const targets = live.length
        ? live
        : owners
            .sort(
              (a, b) => DateTime.toEpochMillis(b.updatedAt) - DateTime.toEpochMillis(a.updatedAt),
            )
            .slice(0, 1);
      for (const thread of targets) {
        yield* engine.dispatch({
          type: "thread.worktree-cleanup.fail",
          commandId: CommandId.make(`worktree-cleanup:${yield* random.uuidV4()}`),
          threadId: thread.id,
          worktreePath,
          message: `Worktree removal was blocked. The checkout was kept.\n\n${input.message.slice(0, 4000)}\n\nFix the cleanup command, then retry worktree removal.`,
        });
      }
    },
    Effect.mapError(
      (cause) =>
        new GitCommandError({
          operation: "worktree-cleanup-report",
          command: "thread-notice",
          cwd: "",
          detail: "Could not record the worktree cleanup failure in its owning thread.",
          cause,
        }),
    ),
  );
  return WorktreeRemovalService.of({
    reportFailure,
    remove: Effect.fn("WorktreeRemovalService.remove")(function (input) {
      return workflow
        .removeWorktree(input)
        .pipe(Effect.tapError((error) => reportFailure({ ...input, message: error.detail })));
    }),
    beforeRemove: Effect.fn("WorktreeRemovalService.beforeRemove")(function (input) {
      return plugins
        .lifecycle({
          type: "worktree.removing",
          repositoryDirectory: input.cwd,
          worktreePath: path.resolve(input.cwd, input.path),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new GitCommandError({
                operation: "worktree.removing",
                command: "plugin-lifecycle",
                cwd: input.cwd,
                detail:
                  cause._tag === "PluginLifecycleBlocked"
                    ? cause.message
                    : `Plugin ${cause.pluginId} could not complete its cleanup handler.`,
                cause,
              }),
          ),
        );
    }),
    afterRemove: Effect.fn("WorktreeRemovalService.afterRemove")(function (input) {
      return plugins
        .lifecycle({
          type: "worktree.removed",
          repositoryDirectory: input.cwd,
          worktreePath: path.resolve(input.cwd, input.path),
        })
        .pipe(Effect.ignore({ log: true }));
    }),
  });
});
export const layer = Layer.effect(WorktreeRemovalService, make);
