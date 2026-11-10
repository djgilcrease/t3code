import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

export const PLUGIN_API_VERSION = 1;
export const PluginId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/));
export const PluginLocalId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/));
const Label = Schema.String.check(Schema.isMaxLength(200));
const Text = Schema.String.check(Schema.isMaxLength(16_384));
export const PluginInput = Schema.Record(Schema.String, Schema.Json);
export type PluginInput = typeof PluginInput.Type;
export const PluginInvocationContext = Schema.Struct({
  audience: Schema.Literals(["client", "agent"]),
  environmentId: Schema.optionalKey(Label),
  projectId: Schema.optionalKey(Label),
  threadId: Schema.optionalKey(Label),
});
export type PluginInvocationContext = typeof PluginInvocationContext.Type;

export const PluginPermission = Schema.Literals([
  "orchestration:read",
  "orchestration:operate",
  "settings:write",
  "providers:manage",
  "environment:maintain",
  "diagnostics:read",
  "filesystem:read",
  "filesystem:write",
  "terminal:read",
  "terminal:operate",
  "source-control:write",
  "review:write",
  "access:read",
  "access:write",
  "relay:read",
  "relay:write",
  "preview:operate",
]);
export type PluginPermission = typeof PluginPermission.Type;
export const PluginManifest = Schema.Struct({
  apiVersion: Schema.Literal(PLUGIN_API_VERSION),
  id: PluginId,
  name: Label,
  version: Label,
  description: Schema.optionalKey(Text),
});
export type PluginManifest = typeof PluginManifest.Type;

export const PluginAction = Schema.Struct({
  id: PluginLocalId,
  label: Label,
  command: PluginLocalId,
  input: PluginInput,
});
export type PluginAction = typeof PluginAction.Type;
export const PluginTone = Schema.Literals(["success", "warning", "danger", "muted"]);
export type PluginTone = typeof PluginTone.Type;
export const PluginStatusAction = Schema.Struct({
  ...PluginAction.fields,
  /** Shown in a confirmation before the command runs. */
  confirm: Schema.optionalKey(Text),
  /** Ask for another connected environment running this plugin; its id is sent under `name`. */
  environment: Schema.optionalKey(Schema.Struct({ name: PluginLocalId, label: Label })),
});
export type PluginStatusAction = typeof PluginStatusAction.Type;
export const PluginField = Schema.Struct({
  name: PluginLocalId,
  label: Label,
  kind: Schema.Literals(["text", "password", "number", "boolean", "select", "multiline", "image"]),
  value: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number, Schema.Boolean])),
  options: Schema.optionalKey(
    Schema.Array(Schema.Struct({ label: Label, value: Label })).check(Schema.isMaxLength(100)),
  ),
  required: Schema.optionalKey(Schema.Boolean),
});
export const PluginManagedEnvironment = Schema.Struct({
  id: PluginLocalId,
  kind: Schema.Literal("environment"),
  environmentId: Label,
  label: Label,
  url: Text,
  state: Schema.Literals([
    "starting",
    "running",
    "stopping",
    "stopped",
    "deleting",
    "deleted",
    "error",
  ]),
  connect: PluginAction,
  threadId: Schema.optionalKey(Label),
  launchRequestId: Schema.optionalKey(Label),
});
export type PluginManagedEnvironment = typeof PluginManagedEnvironment.Type;

export const PluginBlock = Schema.Union([
  Schema.Struct({
    id: PluginLocalId,
    kind: Schema.Literal("graph"),
    label: Label,
    nodes: Schema.Array(
      Schema.Struct({
        id: Label,
        parents: Schema.Array(Label).check(Schema.isMaxLength(20)),
        label: Label,
        detail: Label,
        annotation: Label,
        badges: Schema.Array(Label).check(Schema.isMaxLength(20)),
        action: PluginAction,
      }),
    ).check(Schema.isMaxLength(100)),
  }),
  Schema.Struct({
    id: PluginLocalId,
    kind: Schema.Literal("collection"),
    queryField: Schema.optionalKey(PluginLocalId),
    label: Label,
    items: Schema.Array(
      Schema.Struct({ id: Label, label: Label, search: Text, input: PluginInput }),
    ).check(Schema.isMaxLength(500)),
  }),
  Schema.Struct({
    id: PluginLocalId,
    kind: Schema.Literal("image"),
    label: Label,
    source: Schema.String.check(
      Schema.isMaxLength(200_000),
      Schema.isPattern(/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/),
    ),
  }),
  PluginManagedEnvironment,
  Schema.Struct({ id: PluginLocalId, kind: Schema.Literal("code"), text: Text }),
  Schema.Struct({ id: PluginLocalId, kind: Schema.Literal("text"), text: Text }),
  Schema.Struct({ id: PluginLocalId, kind: Schema.Literal("link"), label: Label, url: Text }),
  Schema.Struct({
    id: PluginLocalId,
    kind: Schema.Literal("actions"),
    actions: Schema.Array(PluginAction).check(Schema.isMaxLength(20)),
  }),
  Schema.Struct({
    id: PluginLocalId,
    kind: Schema.Literal("form"),
    instance: Schema.optionalKey(Label),
    label: Label,
    command: PluginLocalId,
    fields: Schema.Array(PluginField).check(Schema.isMaxLength(40)),
    input: PluginInput,
  }),
  Schema.Struct({
    id: PluginLocalId,
    kind: Schema.Literal("status"),
    environmentId: Schema.optionalKey(Label),
    tone: Schema.optionalKey(PluginTone),
    label: Schema.optionalKey(Label),
    detail: Schema.optionalKey(Text),
    actions: Schema.Array(PluginStatusAction).check(Schema.isMaxLength(3)),
  }),
  Schema.Struct({
    id: PluginLocalId,
    kind: Schema.Literal("table"),
    columns: Schema.Array(Label).check(Schema.isMaxLength(20)),
    rows: Schema.Array(
      Schema.Struct({
        id: Label,
        cells: Schema.Array(Text).check(Schema.isMaxLength(20)),
        actions: Schema.Array(PluginAction).check(Schema.isMaxLength(20)),
      }),
    ).check(Schema.isMaxLength(500)),
  }),
]);
export type PluginBlock = typeof PluginBlock.Type;
const unique = <A>(values: readonly A[]) => new Set(values).size === values.length;
export const PluginView = Schema.Struct({
  title: Label,
  blocks: Schema.Array(PluginBlock).check(Schema.isMaxLength(100)),
}).check(
  Schema.makeFilter(
    (view) =>
      unique(view.blocks.map((block) => block.id)) &&
      view.blocks.every((block) => {
        if (block.kind === "graph") {
          const positions = new Map(block.nodes.map((node, i) => [node.id, i]));
          return (
            positions.size === block.nodes.length &&
            new Set(block.nodes.flatMap((node) => [node.id, ...node.parents])).size <= 200 &&
            block.nodes.every(
              (node, i) =>
                unique(node.parents) &&
                node.parents.every(
                  (parent) => parent !== node.id && (positions.get(parent) ?? Infinity) > i,
                ),
            )
          );
        }
        if (block.kind === "collection") return unique(block.items.map((item) => item.id));
        if (block.kind === "form")
          return (
            unique(block.fields.map((field) => field.name)) &&
            block.fields.every((field) =>
              unique(field.options?.map((option) => option.value) ?? []),
            )
          );
        if (block.kind === "actions" || block.kind === "status")
          return unique(block.actions.map((action) => action.id));
        if (block.kind === "table")
          return (
            unique(block.columns) &&
            unique(block.rows.map((row) => row.id)) &&
            block.rows.every(
              (row) =>
                row.cells.length === block.columns.length &&
                unique(row.actions.map((action) => action.id)),
            )
          );
        return true;
      }),
  ),
);
export type PluginView = typeof PluginView.Type;

/** Replaces only the calling panel; navigation state belongs to the client. */
export const PluginViewResult = Schema.Struct({
  $t3: Schema.Literal("view"),
  view: PluginView,
});
export type PluginViewResult = typeof PluginViewResult.Type;
export const PluginViewDescriptor = Schema.Struct({
  id: PluginLocalId,
  title: Label,
  location: Schema.Literals([
    "settings",
    "settings-page",
    "usage",
    "thread-details",
    "thread-panel",
    "project-settings",
    "managed-environments",
    "environment-launcher",
  ]),
  presentation: Schema.optionalKey(Schema.Literals(["popover", "dialog"])),
  permission: PluginPermission,
});
export type PluginViewDescriptor = typeof PluginViewDescriptor.Type;
export const PluginCommandDescriptor = Schema.Struct({
  id: PluginLocalId,
  title: Label,
  description: Text,
  permission: PluginPermission,
  /** Agent access is opt-in; secret-bearing commands should leave this false. */
  agent: Schema.Boolean,
});
export type PluginCommandDescriptor = typeof PluginCommandDescriptor.Type;

/** An explicit command may disclose a secret temporarily; never return this from a view. */
export const PluginSecretResult = Schema.Struct({
  $t3: Schema.Literal("secret"),
  label: Label,
  value: Text,
});
export type PluginSecretResult = typeof PluginSecretResult.Type;

export const PluginEnvironmentLaunchResult = Schema.Struct({
  $t3: Schema.Literal("environment-launch"),
  requestId: Label,
});
export type PluginEnvironmentLaunchResult = typeof PluginEnvironmentLaunchResult.Type;

/** Ends a `thread-details` action with a message, and optionally a thread to open. */
export const PluginNoticeResult = Schema.Struct({
  $t3: Schema.Literal("notice"),
  tone: PluginTone,
  text: Text,
  thread: Schema.optionalKey(Schema.Struct({ environmentId: Label, threadId: Label })),
});
export type PluginNoticeResult = typeof PluginNoticeResult.Type;

/**
 * Continues a `thread-details` action with another command of the same plugin, here or on
 * another connected environment. The client carries each step, so two environments that
 * cannot reach each other can still exchange data, one bounded command at a time.
 */
export const PluginRelayResult = Schema.Struct({
  $t3: Schema.Literal("relay"),
  /** Omitted: the environment that returned this result. */
  environmentId: Schema.optionalKey(Label),
  command: PluginLocalId,
  input: PluginInput,
  /** Progress shown while the next step runs. */
  status: Schema.optionalKey(Label),
});
export type PluginRelayResult = typeof PluginRelayResult.Type;

export class PluginError extends Schema.TaggedError<PluginError>()("PluginError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message() {
    return `Plugin operation failed (${this.operation}).`;
  }
}

export const PluginMcpServer = Schema.Union([
  Schema.Struct({
    transport: Schema.Literal("stdio"),
    command: Text,
    args: Schema.Array(Text).check(Schema.isMaxLength(100)),
    environment: Schema.Record(Label, Text),
  }),
  Schema.Struct({
    transport: Schema.Literals(["http", "sse"]),
    url: Text,
    headers: Schema.Record(Label, Text),
  }),
]);
export type PluginMcpServer = typeof PluginMcpServer.Type;
export const PluginMcpServers = Schema.Record(PluginLocalId, PluginMcpServer).check(
  Schema.makeFilter((servers) => Object.keys(servers).length <= 100),
);
export type PluginMcpServers = typeof PluginMcpServers.Type;

export const PluginMcpContext = Schema.Struct({
  provider: Label,
  instanceId: Label,
  projectDirectory: Schema.optionalKey(Text),
  cwd: Schema.optionalKey(Text),
});
export type PluginMcpContext = typeof PluginMcpContext.Type;

/** Only T3-owned launches pass through this hook. Terminal shells are unaffected. */
export interface PluginLaunch {
  readonly provider: string;
  readonly purpose: "agent" | "text-generation" | "managed-server";
  readonly cwd?: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
}
export const PluginProcessInput = Schema.Struct({
  command: Text,
  args: Schema.Array(Text).check(Schema.isMaxLength(100)),
  cwd: Text,
  environment: Schema.Record(Label, Text),
  timeoutMs: Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 1_500_000 })),
});
export type PluginProcessInput = typeof PluginProcessInput.Type;
export const PluginProcessResult = Schema.Struct({
  code: Schema.NullOr(Schema.Int),
  timedOut: Schema.Boolean,
  stdout: Text,
  stderr: Text,
  stdoutTruncated: Schema.Boolean,
  stderrTruncated: Schema.Boolean,
});
export type PluginProcessResult = typeof PluginProcessResult.Type;

export const PluginActivity = Schema.Struct({
  active: Schema.Boolean,
  waiting: Schema.Boolean,
  closed: Schema.Boolean,
  lastActivity: Schema.Number,
  threads: Schema.optionalKey(
    Schema.Array(Schema.Struct({ threadId: Label, subagent: Schema.Boolean })).check(
      Schema.isMaxLength(10_000),
    ),
  ),
});
export type PluginActivity = typeof PluginActivity.Type;
export const PluginThreadSummary = Schema.Struct({
  environmentId: Label,
  environmentLabel: Label,
  threadId: Label,
  title: Text,
  projectId: Label,
  /** Identity shared by clones of one repository; null without a Git remote. */
  repository: Schema.NullOr(Text),
  /** Where the thread works: its worktree, or the project directory. */
  directory: Text,
  branch: Schema.NullOr(Text),
  running: Schema.Boolean,
  subagents: Schema.Int,
  archived: Schema.Boolean,
});
export type PluginThreadSummary = typeof PluginThreadSummary.Type;
export const PluginThreadExport = Schema.Struct({
  /**
   * A commit of the working tree as it stood: tracked changes and untracked files Git does
   * not ignore. Its parent is `head`. Both are null outside a Git repository.
   */
  snapshot: Schema.NullOr(Label),
  /** The ref holding `snapshot`; delete it when done. */
  snapshotRef: Schema.NullOr(Text),
  head: Schema.NullOr(Label),
  messages: Schema.Int,
  /** Older messages left out to bound the file; the first message is always kept. */
  omittedMessages: Schema.Int,
});
export type PluginThreadExport = typeof PluginThreadExport.Type;
export const PluginThreadProject = Schema.Struct({
  projectId: Label,
  title: Text,
  directory: Text,
});
export type PluginThreadProject = typeof PluginThreadProject.Type;
export const PluginThreadImport = Schema.Struct({
  environmentId: Label,
  environmentLabel: Label,
  threadId: Label,
  /** The new worktree. */
  directory: Text,
});
export type PluginThreadImport = typeof PluginThreadImport.Type;

/**
 * Copies a thread between environments. The conversation file is the host's own format;
 * carry it as bytes. Paths must lie inside `dataDirectory`. A failure's `cause` is an Error
 * whose message is safe to show the user.
 */
export interface PluginThreads {
  readonly describe: (threadId: string) => Effect.Effect<PluginThreadSummary, PluginError>;
  /** Stops a running turn, holding its queue, then snapshots the work and writes the conversation. */
  readonly export: (input: {
    readonly threadId: string;
    readonly file: string;
  }) => Effect.Effect<PluginThreadExport, PluginError>;
  /** Projects on this environment that are clones of the repository. */
  readonly projects: (
    repository: string,
  ) => Effect.Effect<readonly PluginThreadProject[], PluginError>;
  /**
   * Creates a thread from an exported conversation, in a new worktree of an existing local
   * branch. Its first turn starts a new provider session that is handed the history.
   */
  readonly import: (input: {
    readonly file: string;
    readonly projectId: string;
    readonly branch: string;
  }) => Effect.Effect<PluginThreadImport, PluginError>;
  /** Archives a thread after noting in it where the work continues. */
  readonly archive: (input: {
    readonly threadId: string;
    readonly movedTo: { readonly environmentLabel: string; readonly threadId: string };
  }) => Effect.Effect<void, PluginError>;
}

export const PluginPeer = Schema.Struct({
  id: PluginId,
  name: Label,
  version: Label,
  commands: Schema.Array(PluginCommandDescriptor),
});
export type PluginPeer = typeof PluginPeer.Type;
export const PluginPeerCall = Schema.Struct({
  pluginId: PluginId,
  commandId: PluginLocalId,
  input: PluginInput,
});
export type PluginPeerCall = typeof PluginPeerCall.Type;

/**
 * Other plugins on this environment. A plugin reaches only what an agent could: commands
 * declared with `agent: true`, and never a secret result. Check `list` before relying on an
 * optional plugin. A failure's `cause` is an Error naming why the call was refused.
 */
export interface PluginPeers {
  readonly list: () => Effect.Effect<readonly PluginPeer[], PluginError>;
  readonly run: (call: PluginPeerCall) => Effect.Effect<Schema.Json, PluginError>;
}

export const PluginNotificationKind = Schema.Literals([
  "completion",
  "input",
  "approval",
  "failure",
  "usage-limit",
  "guest-request",
  "activity",
  "clear",
  "notice",
  "review-ready",
  "review-failure",
]);
export type PluginNotificationKind = typeof PluginNotificationKind.Type;
export const PluginNotification = Schema.Struct({
  id: Label,
  sequence: Schema.Int,
  kind: PluginNotificationKind,
  threadId: Schema.String,
  sourceThreadId: Schema.optionalKey(Schema.String),
  targetEnvironmentId: Schema.optionalKey(Schema.String),
  projectId: Schema.String,
  provider: Label,
  title: Label,
  occurredAt: Schema.String,
  description: Schema.optionalKey(Text),
  path: Schema.optionalKey(Text),
});
export type PluginNotification = typeof PluginNotification.Type;
export const PluginNotificationRead = Schema.Struct({
  after: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type PluginNotificationRead = typeof PluginNotificationRead.Type;
export const PluginNotificationBatch = Schema.Struct({
  cursor: Schema.Int,
  events: Schema.Array(PluginNotification).check(Schema.isMaxLength(100)),
});
export type PluginNotificationBatch = typeof PluginNotificationBatch.Type;

export const PluginNotificationRoute = Schema.Struct({
  id: PluginLocalId,
  events: Schema.Array(PluginNotificationKind).check(Schema.isMaxLength(20)),
  projects: Schema.Array(Schema.String).check(Schema.isMaxLength(100)),
  providers: Schema.Array(Schema.String).check(Schema.isMaxLength(100)),
  inApp: Schema.Boolean,
  mode: Schema.Literals(["inherit", "off", "notifications", "sound", "notifications-and-sound"]),
  forwardCommand: Schema.optionalKey(PluginLocalId),
  includeDescription: Schema.optionalKey(Schema.Boolean),
});
export type PluginNotificationRoute = typeof PluginNotificationRoute.Type;
export const PluginNotificationRoutes = Schema.Array(PluginNotificationRoute).check(
  Schema.isMaxLength(100),
);
export type PluginNotificationRoutes = typeof PluginNotificationRoutes.Type;

export const PluginNotificationTargets = Schema.Struct({
  projects: Schema.Array(Schema.Struct({ id: Schema.String, label: Label })).check(
    Schema.isMaxLength(99),
  ),
  providers: Schema.Array(Schema.Struct({ id: Schema.String, label: Label })).check(
    Schema.isMaxLength(99),
  ),
  truncated: Schema.Boolean,
});
export type PluginNotificationTargets = typeof PluginNotificationTargets.Type;

export interface PluginContext {
  /** Null starts at the current tail; persist the returned cursor with the delivery outbox. */
  readonly notifications?: {
    readonly targets: Effect.Effect<PluginNotificationTargets, PluginError>;
    /** Refresh the owning environment's native/mobile presentation from committed state. */
    readonly refreshNative: (threadId: string) => Effect.Effect<void, PluginError>;
    readonly read: (
      input: PluginNotificationRead,
    ) => Effect.Effect<PluginNotificationBatch, PluginError>;
  };
  /** Committed thread activity, including background work; connection presence is excluded. */
  readonly activity?: Effect.Effect<PluginActivity, PluginError> | undefined;
  readonly id: string;
  readonly dataDirectory: string;
  readonly environmentId?: Effect.Effect<string, PluginError> | undefined;
  readonly threads?: PluginThreads;
  readonly plugins?: PluginPeers;
  readonly runProcess?: (
    input: PluginProcessInput,
  ) => Effect.Effect<PluginProcessResult, PluginError>;
  readonly capabilities?: readonly string[];
  /** Relative URL on the owning environment; never a baked-in localhost origin. */
  readonly httpBasePath: string;
  /** Resolved when the environment is listening; evaluate inside handlers, not activation. */
  readonly httpBaseUrl: Effect.Effect<string, PluginError>;
  readonly secrets: {
    readonly get: (key: string) => Effect.Effect<string | null, PluginError>;
    readonly set: (key: string, value: string) => Effect.Effect<void, PluginError>;
    readonly remove: (key: string) => Effect.Effect<void, PluginError>;
  };
}
export const PluginHttpResponseTimeout = Schema.Int.check(
  Schema.isBetween({ minimum: 1_000, maximum: 3_900_000 }),
);

export const PluginLifecycleEvent = Schema.Struct({
  type: Schema.Literals(["worktree.created", "worktree.removing", "worktree.removed"]),
  repositoryDirectory: Text,
  worktreePath: Text,
  refName: Schema.optionalKey(Text),
});
export type PluginLifecycleEvent = typeof PluginLifecycleEvent.Type;
export const PluginLifecycleResult = Schema.NullOr(Schema.Struct({ error: Text }));
export type PluginLifecycleResult = typeof PluginLifecycleResult.Type;
export class PluginLifecycleBlocked extends Schema.TaggedError<PluginLifecycleBlocked>()(
  "PluginLifecycleBlocked",
  { pluginId: PluginId, message: Text },
) {}

export const PluginLifecycleTimeout = Schema.Int.check(
  Schema.isBetween({ minimum: 1_000, maximum: 1_800_000 }),
);

export interface PluginContributions {
  /** Called before disable/removal. Refuse while externally owned resources need cleanup. */
  readonly beforeRemove?: () => Effect.Effect<void, PluginError>;
  /** Explicit client routing policy; no contribution leaves builtin preferences in control. */
  readonly notificationRoutes?: () => Effect.Effect<PluginNotificationRoutes, PluginError>;
  /** Emit after background state changes; clients refetch mounted views, without polling. */
  readonly changes?: Stream.Stream<void, PluginError>;
  readonly onLifecycle?: (
    event: PluginLifecycleEvent,
  ) => Effect.Effect<PluginLifecycleResult | void, PluginError>;
  readonly lifecycleTimeoutMs?: number;
  readonly commands?: readonly (PluginCommandDescriptor & {
    /** Decode and validate feature-specific input inside the handler. */
    readonly run: (
      input: PluginInput,
      context?: PluginInvocationContext,
    ) => Effect.Effect<Schema.Json, PluginError>;
  })[];
  readonly views?: readonly (PluginViewDescriptor & {
    readonly read: (input?: PluginInput) => Effect.Effect<PluginView, PluginError>;
  })[];
  readonly mcpServers?: (context: PluginMcpContext) => Effect.Effect<PluginMcpServers, PluginError>;
  readonly prepareLaunch?: (launch: PluginLaunch) => Effect.Effect<PluginLaunch, PluginError>;
  /**
   * Routes below httpBasePath. Own authentication explicitly (API key, PKCE/state,
   * webhook signatures); this endpoint deliberately has no T3 browser session.
   * Request and response streams stay streaming and carry cancellation.
   */
  readonly handleHttp?: (request: Request) => Effect.Effect<Response, PluginError>;
  /** Response headers may wait for a long RPC; body streams have no whole-response deadline. */
  readonly httpResponseTimeoutMs?: number;
}
export interface T3Plugin extends PluginManifest {
  /** Acquire resources with Effect scopes; the host closes them on shutdown/failure. */
  readonly activate: (
    context: PluginContext,
  ) => Effect.Effect<PluginContributions, PluginError, Scope.Scope>;
}
