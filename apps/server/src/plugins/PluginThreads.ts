import {
  CheckpointRef,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ModelSelection,
  ProjectId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
  TurnItemId,
  isRuntimeModeAbove,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type Project,
  type PluginThreadExport,
  type PluginThreadImport,
  type PluginThreadProject,
  type PluginThreadSummary,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SecureRandom from "effect/crypto/SecureRandom";
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
import { TerminalManager } from "../terminal/Manager.ts";
import * as PluginRegistry from "./PluginRegistry.ts";

/** The message is shown to the user, so it never carries a cause. */
export class PluginThreadError extends Schema.TaggedError<PluginThreadError>()(
  "PluginThreadError",
  { message: Schema.String },
) {}

const PortableThread = Schema.Struct({
  version: Schema.Literal(1),
  source: Schema.Struct({
    environmentId: Schema.String,
    environmentLabel: Schema.String,
    threadId: Schema.String,
  }),
  title: Schema.String,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  omittedMessages: Schema.Int,
  messages: Schema.Array(
    Schema.Struct({
      role: Schema.Literals(["user", "assistant"]),
      text: Schema.String,
      createdAt: Schema.String,
    }),
  ),
});
type PortableThread = typeof PortableThread.Type;
const PortableThreadJson = Schema.fromJsonString(PortableThread);
const encodePortableThread = Schema.encodeEffect(PortableThreadJson);
const decodePortableThread = Schema.decodeUnknownEffect(PortableThreadJson);

// The first turn hands history to the provider within a token budget, so a longer copy
// only costs storage and a slower import. These bounds keep both small.
const MAX_MESSAGES = 2_000;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const STOP_TIMEOUT_MS = 60_000;

/** Keeps the first message and the newest ones that fit. */
export function boundPortableMessages(messages: PortableThread["messages"]): {
  readonly messages: PortableThread["messages"];
  readonly omitted: number;
} {
  const [first, ...rest] = messages;
  if (first === undefined) return { messages: [], omitted: 0 };
  let bytes = Buffer.byteLength(first.text);
  const kept: Array<PortableThread["messages"][number]> = [];
  for (let index = rest.length - 1; index >= 0 && kept.length < MAX_MESSAGES - 1; index--) {
    const message = rest[index]!;
    bytes += Buffer.byteLength(message.text);
    if (bytes > MAX_TEXT_BYTES) break;
    kept.unshift(message);
  }
  return { messages: [first, ...kept], omitted: rest.length - kept.length };
}

export class PluginThreads extends Context.Service<
  PluginThreads,
  {
    readonly describe: (threadId: string) => Effect.Effect<PluginThreadSummary, PluginThreadError>;
    /** Stops a running turn, holding its queue, before it snapshots the work. */
    readonly export: (input: {
      readonly threadId: string;
      readonly file: string;
    }) => Effect.Effect<PluginThreadExport, PluginThreadError>;
    readonly projects: (
      repository: string,
    ) => Effect.Effect<ReadonlyArray<PluginThreadProject>, PluginThreadError>;
    /** The first turn of the new thread starts a provider session that is handed the history. */
    readonly import: (input: {
      readonly file: string;
      readonly projectId: string;
      readonly branch: string;
    }) => Effect.Effect<PluginThreadImport, PluginThreadError>;
    readonly archive: (input: {
      readonly threadId: string;
      readonly movedTo: { readonly environmentLabel: string; readonly threadId: string };
    }) => Effect.Effect<void, PluginThreadError>;
  }
>()("t3/plugins/PluginThreads") {}

const refuse = (message: string) => new PluginThreadError({ message });
const failing =
  (message: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.tapError((cause) => Effect.logWarning(message, { cause })),
      Effect.mapError(() => refuse(message)),
    );

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const repositories = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const checkpoints = yield* CheckpointStore.CheckpointStore;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const workflow = yield* GitWorkflowService.GitWorkflowService;
  const removal = yield* WorktreeRemovalService.WorktreeRemovalService;
  const eventSink = yield* EventSink.EventSinkV2;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const settings = yield* ServerSettings.ServerSettingsService;
  const fs = yield* FileSystem.FileSystem;
  const random = yield* SecureRandom.SecureRandom;
  const uuid = Effect.suspend(() => random.uuidV4()).pipe(
    failing("This environment could not create an id."),
  );

  const load = Effect.fn("PluginThreads.load")(function* (threadId: string) {
    const records = yield* threads
      .getThreadRecords(ThreadId.make(threadId), ["runs"])
      .pipe(Effect.mapError(() => refuse("This thread does not exist on this environment.")));
    const project = yield* projects.getById(records.thread.projectId).pipe(
      failing("This thread's project could not be read."),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(refuse("This thread's project no longer exists.")),
          onSome: Effect.succeed,
        }),
      ),
    );
    if (records.thread.deletedAt !== null) return yield* refuse("This thread was deleted.");
    return {
      thread: records.thread,
      project,
      directory: records.thread.worktreePath ?? project.workspaceRoot,
      activeRun: records.runs.find(
        (run) =>
          run.status !== "queued" && !ThreadManagementService.isTerminalRunStatus(run.status),
      ),
    };
  });

  const describe: PluginThreads["Service"]["describe"] = Effect.fn("PluginThreads.describe")(
    function* (threadId) {
      const { thread, project, directory, activeRun } = yield* load(threadId);
      const descriptor = yield* environment.getDescriptor;
      const identity = yield* repositories.resolve(directory);
      const children = yield* threads
        .listAppOwnedChildThreadIds(thread.id)
        .pipe(failing("This thread's subagents could not be read."));
      return {
        environmentId: descriptor.environmentId,
        environmentLabel: descriptor.label,
        threadId: thread.id,
        title: thread.title,
        projectId: project.id,
        repository: identity?.canonicalKey ?? null,
        directory,
        branch: thread.branch,
        running: activeRun !== undefined,
        subagents: children.length,
        archived: thread.archivedAt !== null,
      };
    },
  );

  const exportThread: PluginThreads["Service"]["export"] = Effect.fn("PluginThreads.export")(
    function* (input) {
      const { thread, directory, activeRun } = yield* load(input.threadId);
      if (thread.archivedAt !== null) return yield* refuse("This thread is archived.");
      if (activeRun !== undefined) {
        yield* threads
          .dispatch({
            type: "thread.stop",
            commandId: CommandId.make(`plugin-export:${yield* uuid}`),
            threadId: thread.id,
          })
          .pipe(failing("The running turn could not be stopped."));
        // The held queue keeps later runs queued, so wait on the run that was stopped.
        const waited = yield* threads
          .waitForThread({
            projectId: thread.projectId,
            threadId: thread.id,
            runId: activeRun.id,
            timeoutMs: STOP_TIMEOUT_MS,
          })
          .pipe(failing("The running turn could not be stopped."));
        if (waited.timedOut)
          return yield* refuse("The running turn did not stop in time. Stop it and try again.");
      }
      const snapshot = yield* Effect.gen(function* () {
        if (!(yield* checkpoints.isGitRepository(directory)))
          return { snapshot: null, snapshotRef: null, head: null };
        const snapshotRef = `refs/t3/plugin-exports/${yield* uuid}`;
        yield* checkpoints.captureCheckpoint({
          cwd: directory,
          checkpointRef: CheckpointRef.make(snapshotRef),
        });
        const commit = yield* git.resolveCommit({ cwd: directory, revision: snapshotRef });
        const head = yield* git.resolveCommit({ cwd: directory, revision: `${snapshotRef}^` });
        return { snapshot: commit.commitSha, snapshotRef, head: head.commitSha };
      }).pipe(failing("The thread's working tree could not be captured."));
      const records = yield* threads
        .getThreadRecords(thread.id, ["messages"])
        .pipe(failing("The thread's conversation could not be read."));
      const descriptor = yield* environment.getDescriptor;
      const bounded = boundPortableMessages(
        records.messages.flatMap((message) =>
          message.role !== "system" &&
          message.notification === undefined &&
          message.workflowScript !== true &&
          message.text.trim() !== ""
            ? [
                {
                  role: message.role,
                  text: message.text,
                  createdAt: DateTime.formatIso(message.createdAt),
                },
              ]
            : [],
        ),
      );
      yield* encodePortableThread({
        version: 1,
        source: {
          environmentId: descriptor.environmentId,
          environmentLabel: descriptor.label,
          threadId: thread.id,
        },
        title: thread.title,
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        omittedMessages: bounded.omitted,
        messages: bounded.messages,
      }).pipe(
        Effect.flatMap((json) => fs.writeFileString(input.file, json)),
        failing("The thread's conversation could not be written."),
      );
      return { ...snapshot, messages: bounded.messages.length, omittedMessages: bounded.omitted };
    },
  );

  const listProjects: PluginThreads["Service"]["projects"] = Effect.fn("PluginThreads.projects")(
    function* (repository) {
      const matches: Array<PluginThreadProject> = [];
      let cursor: number | null = 0;
      while (cursor !== null) {
        const page: {
          readonly projects: ReadonlyArray<Project>;
          readonly nextCursor: number | null;
        } = yield* projects
          .listPage({ cursor, limit: 100 })
          .pipe(failing("This environment's projects could not be read."));
        for (const project of page.projects)
          if (project.repositoryIdentity?.canonicalKey === repository)
            matches.push({
              projectId: project.id,
              title: project.title,
              directory: project.workspaceRoot,
            });
        cursor = page.nextCursor;
      }
      return matches;
    },
  );

  const importThread: PluginThreads["Service"]["import"] = Effect.fn("PluginThreads.import")(
    function* (input) {
      const stat = yield* fs.stat(input.file).pipe(failing("The conversation could not be read."));
      if (Number(stat.size) > MAX_FILE_BYTES)
        return yield* refuse("The conversation is too large to import.");
      const portable = yield* fs.readFileString(input.file).pipe(
        Effect.flatMap(decodePortableThread),
        Effect.mapError(() =>
          refuse("The conversation was not written by a compatible T3 Code server."),
        ),
      );
      const project = yield* projects.getById(ProjectId.make(input.projectId)).pipe(
        failing("The destination project could not be read."),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(refuse("The destination project does not exist.")),
            onSome: Effect.succeed,
          }),
        ),
      );
      const current = yield* settings.getSettings.pipe(
        failing("This environment's settings could not be read."),
      );
      const defaults = resolveProjectSettings(current, project.id, project).settings;
      const ceiling = settings.managedPolicy?.limits?.maxRuntimeMode;
      const modelSelection =
        (yield* threads.isProviderInstanceEnabledForProject({
          projectId: project.id,
          instanceId: portable.modelSelection.instanceId,
        })) || defaults.defaultModelSelection === null
          ? portable.modelSelection
          : defaults.defaultModelSelection;
      const descriptor = yield* environment.getDescriptor;
      const threadId = ThreadId.make(yield* uuid);
      const worktree = yield* workflow
        .createWorktree({ cwd: project.workspaceRoot, refName: input.branch, path: null })
        .pipe(
          Effect.mapError((error) =>
            refuse(`The worktree could not be created. ${error.detail}`.slice(0, 2000)),
          ),
        );
      const now = yield* DateTime.now;
      const thread: OrchestrationV2AppThread = {
        createdBy: "system",
        creationSource: "server",
        id: threadId,
        projectId: project.id,
        title: portable.title,
        providerInstanceId: modelSelection.instanceId,
        modelSelection,
        runtimeMode:
          ceiling !== undefined && isRuntimeModeAbove(portable.runtimeMode, ceiling)
            ? ceiling
            : portable.runtimeMode,
        interactionMode: portable.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: worktree.worktree.refName,
        worktreePath: worktree.worktree.path,
        activeProviderThreadId: null,
        pullRequests: [],
        // Messages without a run are handed to the first turn's provider session.
        historyOrigin: "v1_import",
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      const notice = [
        `Moved from ${portable.source.environmentLabel}. The next message starts a new provider session that is given this conversation.`,
        ...(portable.omittedMessages > 0
          ? [
              `${portable.omittedMessages} earlier ${portable.omittedMessages === 1 ? "message was" : "messages were"} not copied. The original thread keeps them.`,
            ]
          : []),
      ].join(" ");
      yield* eventSink
        .write({
          events: [
            {
              id: EventId.make(`plugin-import:thread:${threadId}:created`),
              type: "thread.created",
              threadId,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: thread,
            },
            noticeEvent(threadId, now, notice),
            ...portable.messages.flatMap((message, index) =>
              messageEvents(threadId, index, message),
            ),
          ],
        })
        .pipe(
          failing("The thread could not be created."),
          Effect.tapError(() =>
            removal
              .remove({ cwd: project.workspaceRoot, path: worktree.worktree.path, force: true })
              .pipe(Effect.ignore({ log: true })),
          ),
        );
      return {
        environmentId: descriptor.environmentId,
        environmentLabel: descriptor.label,
        threadId,
        directory: worktree.worktree.path,
      };
    },
  );

  const archive: PluginThreads["Service"]["archive"] = Effect.fn("PluginThreads.archive")(
    function* (input) {
      const { thread } = yield* load(input.threadId);
      yield* threads
        .dispatch({
          type: "thread.moved",
          commandId: CommandId.make(`plugin-moved:${yield* uuid}`),
          threadId: thread.id,
          environmentLabel: input.movedTo.environmentLabel,
          movedThreadId: input.movedTo.threadId,
        })
        .pipe(failing("The original thread could not be updated."));
      if (thread.archivedAt !== null) return;
      yield* threads
        .dispatch({
          type: "thread.archive",
          commandId: CommandId.make(`plugin-archive:${yield* uuid}`),
          threadId: thread.id,
        })
        .pipe(failing("The original thread could not be archived."));
    },
  );

  return PluginThreads.of({
    describe,
    export: exportThread,
    projects: listProjects,
    import: importThread,
    archive,
  });
});

function noticeEvent(threadId: ThreadId, at: DateTime.Utc, message: string) {
  return {
    id: EventId.make(`plugin-import:notice:${threadId}`),
    type: "turn-item.updated",
    threadId,
    occurredAt: at,
    payload: {
      id: TurnItemId.make(`plugin-import:notice:${threadId}`),
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: at,
      completedAt: at,
      updatedAt: at,
      type: "system_notice",
      message,
    },
  } satisfies OrchestrationV2DomainEvent;
}

function messageEvents(
  threadId: ThreadId,
  index: number,
  message: PortableThread["messages"][number],
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const suffix = String(index).padStart(6, "0");
  const messageId = MessageId.make(`${threadId}:${suffix}`);
  const at = DateTime.makeUnsafe(message.createdAt);
  const common = {
    id: TurnItemId.make(`plugin-import:turn-item:${threadId}:${suffix}`),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: index + 1,
    status: "completed" as const,
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
  };
  return [
    {
      id: EventId.make(`plugin-import:message:${threadId}:${suffix}`),
      type: "message.updated",
      threadId,
      occurredAt: at,
      payload: {
        createdBy: message.role === "user" ? "user" : "agent",
        creationSource: "server",
        id: messageId,
        threadId,
        runId: null,
        nodeId: null,
        role: message.role,
        text: message.text,
        attachments: [],
        streaming: false,
        createdAt: at,
        updatedAt: at,
      },
    },
    {
      id: EventId.make(`plugin-import:turn-item:${threadId}:${suffix}`),
      type: "turn-item.updated",
      threadId,
      occurredAt: at,
      payload:
        message.role === "user"
          ? {
              ...common,
              createdBy: "user",
              creationSource: "server",
              type: "user_message",
              messageId,
              inputIntent: "turn_start",
              text: message.text,
              attachments: [],
            }
          : {
              ...common,
              type: "assistant_message",
              messageId,
              text: message.text,
              streaming: false,
            },
    },
  ];
}

export const layer = Layer.effect(PluginThreads, make);

/** The registry sits below Git in the layer graph, so it is handed this service once both exist. */
export const layerBinding = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* PluginRegistry.PluginRegistry;
    yield* registry.setThreads(yield* PluginThreads);
    const terminals = yield* TerminalManager;
    yield* registry.setTerminalInputActivity(terminals.inputActivity);
  }),
);
