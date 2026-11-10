import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  GitCommandError,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ExecutionEnvironmentDescriptor,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type Project,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as WorktreeRemovalService from "../workspace/WorktreeRemovalService.ts";
import * as PluginThreads from "./PluginThreads.ts";

const now = DateTime.makeUnsafe(0);
const threadId = ThreadId.make("source-thread");
const projectId = ProjectId.make("project:source");
const codex = ProviderInstanceId.make("codex");
const sourceThread: OrchestrationV2AppThread = {
  id: threadId,
  createdBy: "user",
  creationSource: "web",
  projectId,
  title: "Fix the parser",
  providerInstanceId: codex,
  modelSelection: { instanceId: codex, model: "source-model" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "feature",
  worktreePath: "/worktrees/feature",
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
};
const message = (
  index: number,
  role: OrchestrationV2ConversationMessage["role"],
  text: string,
  extra: Partial<OrchestrationV2ConversationMessage> = {},
): OrchestrationV2ConversationMessage => ({
  createdBy: role === "user" ? "user" : "agent",
  creationSource: "server",
  id: MessageId.make(`message-${index}`),
  threadId,
  runId: RunId.make("run-1"),
  nodeId: null,
  role,
  text,
  attachments: [],
  streaming: false,
  createdAt: DateTime.makeUnsafe(index),
  updatedAt: DateTime.makeUnsafe(index),
  ...extra,
});

function harness(
  options: {
    readonly running?: boolean;
    readonly stopTimesOut?: boolean;
    readonly archived?: boolean;
    readonly sourceModelEnabled?: boolean;
    readonly writeFails?: boolean;
    readonly checkoutFails?: boolean;
  } = {},
) {
  const commands: Array<OrchestrationV2ServerCommand> = [];
  const waitedRuns: Array<RunId | undefined> = [];
  const written: Array<OrchestrationV2DomainEvent> = [];
  const removedWorktrees: Array<string> = [];
  const thread = { ...sourceThread, archivedAt: options.archived ? now : null };
  const project = {
    id: projectId,
    title: "Parser",
    workspaceRoot: "/repo",
    repositoryIdentity: { canonicalKey: "github.com/example/parser" },
  } as Project;
  const runs = options.running
    ? [{ id: RunId.make("run-1"), status: "running", ordinal: 1 } as OrchestrationV2Run]
    : [];
  const layer = PluginThreads.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: ((id: ThreadId) =>
            id === threadId
              ? Effect.succeed({
                  thread,
                  runs,
                  messages: [
                    message(1, "user", "Please fix the parser."),
                    message(2, "system", "internal"),
                    message(3, "assistant", "Fixed it in parser.ts."),
                    message(4, "user", "task finished", {
                      notification: {
                        source: { kind: "system" },
                        outcome: "completed",
                        summary: "done",
                      },
                    }),
                  ],
                })
              : Effect.die(
                  "missing",
                )) as ThreadManagementService.ThreadManagementService["Service"]["getThreadRecords"],
          listAppOwnedChildThreadIds: () => Effect.succeed([ThreadId.make("child")]),
          isProviderInstanceEnabledForProject: () =>
            Effect.succeed(options.sourceModelEnabled ?? true),
          dispatch: (command) =>
            Effect.sync(() => {
              commands.push(command);
              return { sequence: 1, storedEvents: [] };
            }),
          waitForThread: (input) =>
            Effect.sync(() => {
              waitedRuns.push(input.runId);
              return {
                threadId: input.threadId,
                run: null,
                timedOut: options.stopTimesOut ?? false,
              };
            }),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeedSome(project),
          listPage: () =>
            Effect.succeed({
              projects: [
                project,
                { ...project, id: ProjectId.make("project:other"), repositoryIdentity: null },
              ],
              nextCursor: null,
            }),
        }),
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: () => Effect.succeed(project.repositoryIdentity ?? null),
        }),
        Layer.mock(CheckpointStore.CheckpointStore)({
          isGitRepository: () => Effect.succeed(true),
          captureCheckpoint: () => Effect.void,
        }),
        Layer.mock(GitVcsDriver.GitVcsDriver)({
          resolveCommit: ({ revision }) =>
            Effect.succeed({ commitSha: revision.endsWith("^") ? "head-sha" : "snapshot-sha" }),
        }),
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          createWorktree: (input) =>
            options.checkoutFails
              ? Effect.fail(
                  new GitCommandError({
                    operation: "createWorktree",
                    command: "git worktree add",
                    cwd: "/repo",
                    detail: "'feature' is already checked out.",
                  }),
                )
              : Effect.succeed({ worktree: { path: "/worktrees/moved", refName: input.refName } }),
        }),
        Layer.mock(WorktreeRemovalService.WorktreeRemovalService)({
          remove: (input) => Effect.sync(() => void removedWorktrees.push(input.path)),
        }),
        Layer.mock(EventSink.EventSinkV2)({
          write: (input) =>
            options.writeFails
              ? Effect.fail(new EventSink.EventSinkWriteError({ eventCount: input.events.length }))
              : Effect.sync(() => {
                  written.push(...input.events);
                  return [];
                }),
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getDescriptor: Effect.succeed({
            environmentId: EnvironmentId.make("environment-home"),
            label: "home",
          } as ExecutionEnvironmentDescriptor),
        }),
        ServerSettings.layerTest({
          defaultModelSelection: { instanceId: codex, model: "destination-default" },
        }),
        NodeServices.layer,
        NodeCrypto.layer,
      ),
    ),
  );
  return { layer, commands, waitedRuns, written, removedWorktrees };
}

const conversationFile = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return `${yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-threads-" })}/conversation.json`;
});

it.effect("exports a running thread and recreates it with history a first turn hands over", () => {
  const { layer, commands, waitedRuns, written } = harness({
    running: true,
    sourceModelEnabled: false,
  });
  return Effect.gen(function* () {
    const service = yield* PluginThreads.PluginThreads;
    const file = yield* conversationFile;

    expect(yield* service.describe(threadId)).toMatchObject({
      environmentLabel: "home",
      repository: "github.com/example/parser",
      directory: "/worktrees/feature",
      running: true,
      subagents: 1,
    });
    expect(yield* service.projects("github.com/example/parser")).toEqual([
      { projectId, title: "Parser", directory: "/repo" },
    ]);

    // The stop holds the queue, so only the stopped run is a safe thing to wait on.
    expect(yield* service.export({ threadId, file })).toEqual({
      snapshot: "snapshot-sha",
      snapshotRef: expect.stringMatching(/^refs\/t3\/plugin-exports\//),
      head: "head-sha",
      messages: 2,
      omittedMessages: 0,
    });
    expect(commands.map((command) => command.type)).toEqual(["thread.stop"]);
    expect(waitedRuns).toEqual([RunId.make("run-1")]);

    const imported = yield* service.import({ file, projectId, branch: "feature" });
    expect(imported).toMatchObject({ environmentLabel: "home", directory: "/worktrees/moved" });
    const created = written.find((event) => event.type === "thread.created");
    expect(created?.payload).toMatchObject({
      title: "Fix the parser",
      branch: "feature",
      worktreePath: "/worktrees/moved",
      // Without these two, the first turn would resume nothing and hand over nothing.
      historyOrigin: "v1_import",
      activeProviderThreadId: null,
      // The source's provider is not enabled here, so the thread starts on this project's default.
      modelSelection: { instanceId: codex, model: "destination-default" },
    });
    const items = written.flatMap((event) =>
      event.type === "turn-item.updated" ? [event.payload] : [],
    );
    expect(items.every((item) => item.runId === null)).toBe(true);
    expect(
      items.flatMap((item) =>
        item.type === "user_message" || item.type === "assistant_message" ? [item.text] : [],
      ),
    ).toEqual(["Please fix the parser.", "Fixed it in parser.ts."]);
    expect(items.find((item) => item.type === "system_notice")).toMatchObject({
      message: expect.stringContaining("Moved from home"),
    });
  }).pipe(Effect.scoped, Effect.provide(layer));
});

it.effect("leaves the source alone when its running turn will not stop", () => {
  const { layer, commands } = harness({ running: true, stopTimesOut: true });
  return Effect.gen(function* () {
    const service = yield* PluginThreads.PluginThreads;
    const fs = yield* FileSystem.FileSystem;
    const file = yield* conversationFile;
    const error = yield* service.export({ threadId, file }).pipe(Effect.flip);
    expect(error.message).toContain("did not stop in time");
    expect(yield* fs.exists(file)).toBe(false);
    expect(commands.map((command) => command.type)).toEqual(["thread.stop"]);
  }).pipe(Effect.scoped, Effect.provide(layer));
});

it.effect("removes the new worktree when the thread cannot be created", () => {
  const exporting = harness();
  const importing = harness({ writeFails: true });
  return Effect.gen(function* () {
    const file = yield* conversationFile;
    yield* Effect.gen(function* () {
      yield* (yield* PluginThreads.PluginThreads).export({ threadId, file });
    }).pipe(Effect.provide(exporting.layer));
    const error = yield* Effect.gen(function* () {
      const service = yield* PluginThreads.PluginThreads;
      return yield* service.import({ file, projectId, branch: "feature" }).pipe(Effect.flip);
    }).pipe(Effect.provide(importing.layer));
    expect(error.message).toBe("The thread could not be created.");
    expect(importing.removedWorktrees).toEqual(["/worktrees/moved"]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));
});

it.effect.each([
  { archived: false, expected: ["thread.moved", "thread.archive"] },
  { archived: true, expected: ["thread.moved"] },
])("notes where a moved thread continues and archives it once: $expected", (row) => {
  const { layer, commands } = harness({ archived: row.archived });
  return Effect.gen(function* () {
    const service = yield* PluginThreads.PluginThreads;
    yield* service.archive({
      threadId,
      movedTo: { environmentLabel: "server", threadId: "new-thread" },
    });
    expect(commands.map((command) => command.type)).toEqual(row.expected);
    expect(commands[0]).toMatchObject({ environmentLabel: "server", movedThreadId: "new-thread" });
  }).pipe(Effect.provide(layer));
});

it("keeps the first message and the newest ones when a conversation is too long to copy", () => {
  const messages = Array.from({ length: 2_500 }, (_, index) => ({
    role: "user" as const,
    text: `message ${index}`,
    createdAt: "1970-01-01T00:00:00.000Z",
  }));
  const bounded = PluginThreads.boundPortableMessages(messages);
  expect(bounded.omitted).toBe(500);
  expect(bounded.messages).toHaveLength(2_000);
  expect(bounded.messages[0]?.text).toBe("message 0");
  expect(bounded.messages.at(-1)?.text).toBe("message 2499");
});

it.effect("a failed worktree checkout reports why without creating a thread", () => {
  const { layer, written } = harness({ checkoutFails: true });
  return Effect.gen(function* () {
    const file = yield* conversationFile;
    const service = yield* PluginThreads.PluginThreads;
    yield* service.export({ threadId, file });
    const error = yield* service.import({ file, projectId, branch: "feature" }).pipe(Effect.flip);
    expect(error.message).toContain("already checked out");
    expect(written).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(layer));
});
