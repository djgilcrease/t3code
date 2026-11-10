import {
  PluginNotificationRoutes,
  PluginCatalog,
  PluginLifecycleEvent,
  PluginLifecycleTimeout,
  PluginLifecycleResult,
  PluginLifecycleBlocked,
  PluginMcpServers,
  PluginHttpResponseTimeout,
  type PluginMcpContext,
  type PluginInvocationContext,
  type PluginMcpServer,
  PluginCommandDescriptor,
  PluginManifest,
  PluginViewDescriptor,
  PluginView,
  PluginRuntimeHealth,
  PluginSecretResult,
  PluginRelayResult,
  PluginLocalId,
  PluginError,
  PluginOperationError,
  PluginRequestError,
  EnvironmentAuthorizationError,
  authScopeRequiredResponse,
  AuthStandardClientScopes,
  type AuthEnvironmentScope,
  type PluginCommandInput,
  type PluginViewInput,
  type PluginContributions,
  type PluginContext,
  type PluginThreads,
  type PluginLaunch,
  type T3Plugin,
} from "@t3tools/contracts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as NotificationJournal from "./NotificationJournal.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { summarizePluginActivity } from "./pluginActivity.ts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as PluginModuleLoader from "./PluginModuleLoader.ts";
import { PluginConfiguration, type PluginConfigurationEntry } from "./pluginConfiguration.ts";

const decodeConfiguration = Schema.decodeUnknownEffect(Schema.fromJsonString(PluginConfiguration));
const decodeManifest = Schema.decodeUnknownEffect(PluginManifest);
const decodeCommand = Schema.decodeUnknownEffect(PluginCommandDescriptor);
const decodeViewDescriptor = Schema.decodeUnknownEffect(PluginViewDescriptor);
const decodeView = Schema.decodeUnknownEffect(PluginView);
const decodeHealth = Schema.decodeUnknownEffect(PluginRuntimeHealth);
const isSecretResult = Schema.is(PluginSecretResult);
const isRelayResult = Schema.is(PluginRelayResult);
const decodeJson = Schema.decodeUnknownEffect(Schema.Json);
const decodeSecretKey = Schema.decodeUnknownEffect(PluginLocalId);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));
const boundedResult = <A extends Schema.Json>(value: A) =>
  encodeJson(value).pipe(
    Effect.flatMap((text) =>
      new TextEncoder().encode(text).byteLength <= 256 * 1024
        ? Effect.succeed(value)
        : Effect.fail(new PluginError({ operation: "result-too-large", cause: null })),
    ),
  );
const Launch = Schema.Struct({
  provider: Schema.String,
  purpose: Schema.Literals(["agent", "text-generation", "managed-server"]),
  cwd: Schema.optionalKey(Schema.String),
  args: Schema.Array(Schema.String),
  environment: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Undefined])),
});
const decodeLifecycleTimeout = Schema.decodeEffect(PluginLifecycleTimeout);
const decodeLifecycleEvent = Schema.decodeEffect(PluginLifecycleEvent);
const decodeLifecycleResult = Schema.decodeEffect(PluginLifecycleResult);
const decodeHttpResponseTimeout = Schema.decodeUnknownEffect(PluginHttpResponseTimeout);
const decodeLaunch = Schema.decodeUnknownEffect(Launch);
type RequestError = PluginOperationError | PluginRequestError | EnvironmentAuthorizationError;
/** A failure's message is shown to the user, so implementations keep causes out of it. */
type ThreadFailure = { readonly message: string };
export type PluginThreadHost = {
  readonly [Method in keyof PluginThreads]: (
    ...input: Parameters<PluginThreads[Method]>
  ) => Effect.Effect<Effect.Success<ReturnType<PluginThreads[Method]>>, ThreadFailure>;
};

export class PluginRegistry extends Context.Service<
  PluginRegistry,
  {
    readonly configuration: Effect.Effect<PluginConfiguration>;
    readonly reconcile: (next: PluginConfiguration) => Effect.Effect<boolean>;
    readonly beforeRemove: (id: string) => Effect.Effect<void, PluginOperationError>;
    readonly restart: (id: string) => Effect.Effect<boolean>;
    readonly setHttpOrigin: (origin: string) => Effect.Effect<void>;
    /** Thread services depend on this registry through Git, so they are handed over later. */
    readonly setNotificationDelivery: (
      deliver: (threadId: string) => Effect.Effect<void>,
    ) => Effect.Effect<void>;
    readonly setThreads: (host: PluginThreadHost) => Effect.Effect<void>;
    readonly setTerminalInputActivity: (
      source: Effect.Effect<ReadonlyMap<string, number>>,
    ) => Effect.Effect<void>;
    readonly changes: Stream.Stream<number>;
    readonly list: (scopes: readonly AuthEnvironmentScope[]) => Effect.Effect<PluginCatalog>;
    readonly readView: (
      input: PluginViewInput,
      scopes: readonly AuthEnvironmentScope[],
    ) => Effect.Effect<PluginView, RequestError>;
    readonly execute: (
      input: PluginCommandInput,
      scopes: readonly AuthEnvironmentScope[],
      audience?: "client" | "agent" | "agent-read",
      context?: Omit<PluginInvocationContext, "audience">,
    ) => Effect.Effect<Schema.Json, RequestError>;
    readonly mcpServers: (
      context: PluginMcpContext,
    ) => Effect.Effect<PluginMcpServers, PluginOperationError>;
    readonly prepareLaunch: (
      launch: PluginLaunch,
    ) => Effect.Effect<PluginLaunch, PluginOperationError>;
    readonly lifecycle: (
      event: PluginLifecycleEvent,
    ) => Effect.Effect<void, PluginOperationError | PluginLifecycleBlocked>;
    readonly handleHttp: (
      pluginId: string,
      request: Request,
    ) => Effect.Effect<Response, PluginOperationError>;
  }
>()("t3/plugins/PluginRegistry") {}

/** Catch extension defects as well as typed failures without exposing plugin error text. */
const guarded = <A, E, R>(
  id: string,
  operation: string,
  effect: Effect.Effect<A, E, R>,
  deadline = 30_000,
) =>
  effect.pipe(
    Effect.timeout(deadline),
    Effect.catchCause((cause) =>
      Cause.hasInterrupts(cause)
        ? Effect.failCause(cause).pipe(Effect.orDie)
        : Effect.fail(new PluginOperationError({ pluginId: id, operation, cause })),
    ),
  );

const authorize = (permission: AuthEnvironmentScope, scopes: readonly AuthEnvironmentScope[]) =>
  scopes.includes(permission)
    ? Effect.void
    : Effect.fail(
        new EnvironmentAuthorizationError({
          message: `The authenticated token is missing required scope: ${permission}.`,
          ...authScopeRequiredResponse(permission),
        }),
      );

const make = Effect.gen(function* () {
  const identity = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironmentIdentity);
  const notifications = yield* Effect.serviceOption(NotificationJournal.NotificationJournal);
  const projects = yield* Effect.serviceOption(ProjectStore.ProjectStoreV2);
  const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const projection = yield* Effect.serviceOption(ProjectionStore.ProjectionStoreV2);
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const loader = yield* PluginModuleLoader.PluginModuleLoader;
  const revision = yield* SubscriptionRef.make(0);
  const changed = SubscriptionRef.update(revision, (value) => value + 1);
  const active = new Map<string, PluginContributions>();
  const restartLimits = new Map<string, (limit: number) => Effect.Effect<void>>();
  let httpOrigin: string | undefined;
  let notificationDelivery: ((threadId: string) => Effect.Effect<void>) | undefined;
  let threadHost: PluginThreadHost | undefined;
  let terminalInputActivity: Effect.Effect<ReadonlyMap<string, number>> = Effect.succeed(new Map());
  const entries = new Map<string, PluginCatalog["plugins"][number]>();
  const pluginScopes = new Map<string, Scope.Closeable>();
  const lifetime = yield* Scope.Scope;
  let configurationError = false;
  let configuration: PluginConfiguration = yield* fs
    .readFileString(path.join(config.baseDir, "plugins.json"))
    .pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed('{"plugins":[]}'),
      ),
      Effect.flatMap(decodeConfiguration),
      Effect.filterOrFail(
        (value) => new Set(value.plugins.map((p) => p.id)).size === value.plugins.length,
        () => new PluginError({ operation: "duplicate-id", cause: null }),
      ),
      Effect.catch(() => {
        configurationError = true;
        return Effect.logWarning("Plugin configuration could not be loaded.").pipe(
          Effect.as({ plugins: [] }),
        );
      }),
    );
  const loadOne = Effect.fn("PluginRegistry.load")(function* (item: PluginConfigurationEntry) {
    if (!item.enabled) {
      entries.set(item.id, {
        id: item.id,
        name: item.id,
        version: "",
        status: "disabled",
        commands: [],
        views: [],
      });
      return;
    }
    const child = yield* Scope.fork(lifetime);
    pluginScopes.set(item.id, child);
    let stage: NonNullable<PluginCatalog["plugins"][number]["failure"]> = "module";
    let crashLimitReached = false;
    const activation = Effect.gen(function* () {
      if (!path.isAbsolute(item.path))
        return yield* new PluginError({ operation: "absolute-module-path-required", cause: null });
      const module = yield* loader.load(item.path, { restartLimit: item.restartLimit ?? 5 }).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            crashLimitReached = error.operation === "crash-limit";
          }),
        ),
      );
      stage = "manifest";
      const candidate = Predicate.hasProperty(module, "default") ? module.default : null;
      const manifest = yield* decodeManifest(candidate);
      if (
        manifest.id !== item.id ||
        (item.source && manifest.version !== item.source.tag.replace(/^v/, "")) ||
        !Predicate.hasProperty(candidate, "activate") ||
        typeof candidate.activate !== "function"
      ) {
        return yield* new PluginError({ operation: "manifest", cause: null });
      }
      // The loader exposes a local proxy after validating the worker's manifest.
      const plugin = candidate as T3Plugin;
      stage = "storage";
      const dataDirectory = path.join(config.baseDir, "plugins", item.id);
      yield* fs.makeDirectory(dataDirectory, { recursive: true });
      const secretName = (key: string) =>
        decodeSecretKey(key).pipe(
          Effect.map((key) => `plugin.${item.id}.${key}`),
          Effect.mapError((cause) => new PluginError({ operation: "secret-key", cause })),
        );
      const threadFailure = (message: string) =>
        new PluginError({ operation: "thread", cause: new Error(message) });
      const threadCall = <A>(run: (host: PluginThreadHost) => Effect.Effect<A, ThreadFailure>) =>
        Effect.suspend(() =>
          threadHost === undefined
            ? Effect.fail(threadFailure("Thread access is not ready on this environment."))
            : run(threadHost).pipe(Effect.mapError((error) => threadFailure(error.message))),
        );
      const insideData = (file: string) =>
        path.resolve(file).startsWith(dataDirectory + path.sep)
          ? Effect.void
          : Effect.fail(threadFailure("The file must be inside the plugin's data directory."));
      const context: PluginContext = {
        id: item.id,
        dataDirectory,
        environmentId: Option.isSome(identity)
          ? identity.value.getEnvironmentId.pipe(
              Effect.mapError((cause) => new PluginError({ operation: "environment-id", cause })),
            )
          : undefined,
        ...(Option.isSome(notifications)
          ? {
              notifications: {
                targets: Effect.gen(function* () {
                  const projectRows = Option.isSome(projects) ? yield* projects.value.list() : [];
                  const configuration = Option.isSome(settings)
                    ? (yield* settings.value.getSettings).providerInstances
                    : {};
                  const providerRows = Object.entries(configuration ?? {}).map(([id, value]) => ({
                    id,
                    label: (value.displayName ?? `${value.driver} (${id})`).slice(0, 200),
                  }));
                  return {
                    projects: projectRows.slice(0, 99).map((project) => ({
                      id: project.projectId,
                      label: project.title.slice(0, 200),
                    })),
                    providers: providerRows.slice(0, 99),
                    truncated: projectRows.length > 99 || providerRows.length > 99,
                  };
                }).pipe(
                  Effect.mapError(
                    (cause) => new PluginError({ operation: "notification-targets", cause }),
                  ),
                ),
                read: notifications.value.read,
                refreshNative: (threadId: string) =>
                  Effect.suspend(() =>
                    notificationDelivery
                      ? notificationDelivery(threadId)
                      : Effect.fail(
                          new PluginError({
                            operation: "native-notifications-not-ready",
                            cause: null,
                          }),
                        ),
                  ),
              },
            }
          : {}),
        activity: Option.isSome(projection)
          ? projection.value.getShellSnapshot().pipe(
              Effect.flatMap(({ threads }) =>
                terminalInputActivity.pipe(
                  Effect.map((inputs) => summarizePluginActivity(threads, inputs)),
                ),
              ),
              Effect.mapError((cause) => new PluginError({ operation: "activity", cause })),
            )
          : undefined,
        plugins: {
          list: () =>
            Effect.sync(() =>
              [...entries.values()]
                .filter((entry) => entry.status === "active" && entry.id !== item.id)
                .map(({ id, name, version, commands }) => ({
                  id,
                  name,
                  version,
                  commands: commands.filter((command) => command.agent),
                })),
            ),
          run: (call) => {
            const refused = (reason: string) =>
              new PluginError({ operation: "plugin-command", cause: new Error(reason) });
            const command = entries
              .get(call.pluginId)
              ?.commands.find((candidate) => candidate.id === call.commandId);
            // A plugin calls as an agent would, so it reaches no secrets and no opted-out command.
            return call.pluginId === item.id || command === undefined
              ? Effect.fail(refused("unknown-contribution"))
              : execute(
                  { ...call, permission: command.permission },
                  AuthStandardClientScopes,
                  "agent",
                ).pipe(
                  Effect.mapError((error) =>
                    refused(error._tag === "PluginRequestError" ? error.reason : "failed"),
                  ),
                );
          },
        },
        threads: {
          describe: (threadId) => threadCall((host) => host.describe(threadId)),
          export: (input) =>
            insideData(input.file).pipe(Effect.andThen(threadCall((host) => host.export(input)))),
          projects: (repository) => threadCall((host) => host.projects(repository)),
          import: (input) =>
            insideData(input.file).pipe(Effect.andThen(threadCall((host) => host.import(input)))),
          archive: (input) => threadCall((host) => host.archive(input)),
        },
        capabilities: [
          "provider-mcp-servers",
          "http-response-timeout",
          "settings-pages",
          "portable-view-navigation",
          "worktree-lifecycle",
          "supervised-processes",
          "thread-details",
          "portable-collections",
          "portable-graphs",
          ...(Option.isSome(projection) ? ["environment-activity"] : []),
          "thread-portability",
          "plugin-commands",
          "command-invocation-context",
          "notification-routing",
          ...(Option.isSome(notifications)
            ? ["notification-journal", "native-notification-delivery", "notification-targets"]
            : []),
        ],
        httpBasePath: `/api/plugins/${item.id}`,
        httpBaseUrl: Effect.suspend(() =>
          httpOrigin === undefined
            ? Effect.fail(new PluginError({ operation: "http-not-listening", cause: null }))
            : Effect.succeed(`${httpOrigin}/api/plugins/${item.id}`),
        ),
        secrets: {
          get: (key) =>
            secretName(key).pipe(
              Effect.flatMap((key) => secrets.get(key)),
              Effect.map((value) =>
                Option.isSome(value) ? new TextDecoder().decode(value.value) : null,
              ),
              Effect.mapError((cause) => new PluginError({ operation: "secret-read", cause })),
            ),
          set: (key, value) =>
            secretName(key).pipe(
              Effect.flatMap((key) => secrets.set(key, new TextEncoder().encode(value))),
              Effect.mapError((cause) => new PluginError({ operation: "secret-write", cause })),
            ),
          remove: (key) =>
            secretName(key).pipe(
              Effect.flatMap((key) => secrets.remove(key)),
              Effect.mapError((cause) => new PluginError({ operation: "secret-remove", cause })),
            ),
        },
      };
      stage = "activation";
      const contributions = yield* Effect.suspend(() => plugin.activate(context)).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            crashLimitReached = error.operation === "crash-limit";
          }),
        ),
      );
      stage = "contributions";
      const commands = yield* Effect.forEach(contributions.commands ?? [], (command) =>
        decodeCommand(command),
      );
      const views = yield* Effect.forEach(contributions.views ?? [], (view) =>
        decodeViewDescriptor(view),
      );
      if (
        new Set(commands.map((c) => c.id)).size !== commands.length ||
        new Set(views.map((v) => v.id)).size !== views.length ||
        contributions.commands?.some((c) => typeof c.run !== "function") ||
        contributions.views?.some((v) => typeof v.read !== "function") ||
        (contributions.mcpServers !== undefined &&
          typeof contributions.mcpServers !== "function") ||
        (contributions.prepareLaunch !== undefined &&
          typeof contributions.prepareLaunch !== "function") ||
        (contributions.handleHttp !== undefined &&
          typeof contributions.handleHttp !== "function") ||
        (contributions.onLifecycle !== undefined && typeof contributions.onLifecycle !== "function")
      ) {
        return yield* new PluginError({ operation: "contributions", cause: null });
      }
      const httpResponseTimeoutMs = yield* decodeHttpResponseTimeout(
        contributions.httpResponseTimeoutMs ?? 30_000,
      );
      const lifecycleTimeoutMs = yield* decodeLifecycleTimeout(
        contributions.lifecycleTimeoutMs ?? 30_000,
      );
      active.set(item.id, { ...contributions, httpResponseTimeoutMs, lifecycleTimeoutMs });
      if (module.setRestartLimit) restartLimits.set(item.id, module.setRestartLimit);
      const refreshRoutes = Effect.gen(function* () {
        if (!contributions.notificationRoutes) return;
        const routes = yield* guarded(
          item.id,
          "notification-routes",
          Effect.suspend(contributions.notificationRoutes).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(PluginNotificationRoutes)),
          ),
        );
        const entry = entries.get(item.id);
        if (entry) entries.set(item.id, { ...entry, notificationRoutes: routes });
      });
      entries.set(item.id, { ...manifest, status: "active", commands, views });
      yield* refreshRoutes;
      if (module.health) {
        const healthStream = module.health;
        yield* healthStream.pipe(
          Stream.runForEach((value) =>
            decodeHealth(value).pipe(
              Effect.tap((health) =>
                Effect.sync(() => {
                  const entry = entries.get(item.id);
                  if (entry)
                    entries.set(item.id, {
                      ...entry,
                      status: health.status,
                      restartAttempts: health.attempts,
                      restartLimit: health.limit,
                    });
                }),
              ),
              Effect.andThen(changed),
            ),
          ),
          Effect.ignore,
          Effect.forkScoped,
        );
      }
      if (contributions.changes)
        yield* contributions.changes.pipe(
          Stream.runForEach(() =>
            refreshRoutes.pipe(
              Effect.catch(() =>
                Effect.sync(() => {
                  const entry = entries.get(item.id);
                  if (entry) entries.set(item.id, { ...entry, notificationRoutes: [] });
                }),
              ),
              Effect.andThen(changed),
            ),
          ),
          Effect.catchCause(() =>
            Effect.logWarning("Plugin change stream stopped.", { pluginId: item.id }),
          ),
          Effect.forkScoped,
        );
    }).pipe(Effect.provideService(Scope.Scope, child));
    yield* guarded(item.id, "activation", activation, (item.restartLimit ?? 5) * 34_000).pipe(
      Effect.catch(() =>
        Scope.close(child, Exit.void).pipe(
          Effect.andThen(
            Effect.sync(() => {
              active.delete(item.id);
              restartLimits.delete(item.id);
              entries.set(item.id, {
                id: item.id,
                name: item.id,
                version: "",
                status: crashLimitReached ? "stopped" : "failed",
                failure: stage,
                ...(crashLimitReached ? { restartAttempts: item.restartLimit ?? 5 } : {}),
                commands: [],
                views: [],
              });
            }),
          ),
          Effect.andThen(
            Effect.logWarning("Plugin activation failed.", { pluginId: item.id, stage }),
          ),
        ),
      ),
    );
  });
  const initialized = yield* Deferred.make<void>();
  // Plugin activation may wait on its watchdog. Keep the environment available
  // while loading, and gate plugin operations so launches cannot bypass hooks.
  yield* Effect.forEach(configuration.plugins, loadOne, { concurrency: 4 }).pipe(
    Effect.ensuring(Deferred.succeed(initialized, undefined)),
    Effect.forkScoped,
  );
  const reconcile: PluginRegistry["Service"]["reconcile"] = Effect.fn("PluginRegistry.reconcile")(
    function* (next) {
      yield* Deferred.await(initialized);
      let succeeded = true;
      for (const old of configuration.plugins) {
        const replacement = next.plugins.find((item) => item.id === old.id);
        if (replacement?.path === old.path && replacement.enabled === old.enabled) {
          if (replacement.restartLimit !== old.restartLimit) {
            const setLimit = restartLimits.get(old.id);
            if (setLimit) yield* setLimit(replacement.restartLimit ?? 5);
          }
          continue;
        }
        active.delete(old.id);
        restartLimits.delete(old.id);
        entries.delete(old.id);
        const scope = pluginScopes.get(old.id);
        pluginScopes.delete(old.id);
        if (scope) yield* Scope.close(scope, Exit.void);
      }
      for (const item of next.plugins) {
        if (!entries.has(item.id)) {
          yield* loadOne(item);
          if (item.enabled && entries.get(item.id)?.status !== "active") succeeded = false;
        }
      }
      configuration = next;
      configurationError = false;
      yield* changed;
      return succeeded;
    },
  );
  const getPlugin = Effect.fn("PluginRegistry.getPlugin")(function* (id: string) {
    yield* Deferred.await(initialized);
    const plugin = active.get(id);
    return yield* plugin && entries.get(id)?.status === "active"
      ? Effect.succeed(plugin)
      : Effect.fail(new PluginRequestError({ pluginId: id, reason: "unavailable" }));
  });
  const readView: PluginRegistry["Service"]["readView"] = Effect.fn("PluginRegistry.readView")(
    function* (input, scopes) {
      const plugin = yield* getPlugin(input.pluginId);
      const view = plugin.views?.find((v) => v.id === input.viewId);
      if (!view)
        return yield* new PluginRequestError({
          pluginId: input.pluginId,
          reason: "unknown-contribution",
        });
      yield* authorize(view.permission, scopes);
      return yield* guarded(
        input.pluginId,
        "view",
        Effect.suspend(() => view.read(input.context)).pipe(
          Effect.flatMap(decodeView),
          // Each machine-readable location accepts only its matching block kind.
          Effect.filterOrFail(
            (content) =>
              content.blocks.every(
                (block) =>
                  (block.kind === "status") === (view.location === "thread-details") &&
                  (block.kind === "environment") === (view.location === "managed-environments"),
              ),
            () => new PluginError({ operation: "view-location", cause: null }),
          ),
          Effect.flatMap(boundedResult),
        ),
      );
    },
  );
  const execute: PluginRegistry["Service"]["execute"] = Effect.fn("PluginRegistry.execute")(
    function* (input, scopes, audience = "client", context) {
      const plugin = yield* getPlugin(input.pluginId);
      const command = plugin.commands?.find((c) => c.id === input.commandId);
      if (!command)
        return yield* new PluginRequestError({
          pluginId: input.pluginId,
          reason: "unknown-contribution",
        });
      yield* authorize(command.permission, scopes);
      if (
        audience !== "client" &&
        (!command.agent || (audience === "agent-read" && !command.permission.endsWith(":read")))
      )
        return yield* new PluginRequestError({
          pluginId: input.pluginId,
          reason: "agent-access-disabled",
        });
      const result = yield* guarded(
        input.pluginId,
        "command",
        Effect.suspend(() =>
          command.run(input.input, {
            ...context,
            audience: audience === "client" ? "client" : "agent",
          }),
        ).pipe(Effect.flatMap(decodeJson), Effect.flatMap(boundedResult)),
      ).pipe(
        // A relayed step is not the end of its action; views refresh once the chain ends.
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) && isRelayResult(exit.value) ? Effect.void : changed,
        ),
      );
      if (
        isSecretResult(result) &&
        (audience !== "client" || command.permission.endsWith(":read"))
      ) {
        return yield* new PluginRequestError({
          pluginId: input.pluginId,
          reason: "secret-access-disabled",
        });
      }
      return result;
    },
  );
  return PluginRegistry.of({
    configuration: Deferred.await(initialized).pipe(
      Effect.andThen(Effect.sync(() => configuration)),
    ),
    reconcile,
    beforeRemove: Effect.fn("PluginRegistry.beforeRemove")(function* (id) {
      yield* Deferred.await(initialized);
      const plugin = active.get(id);
      if (plugin?.beforeRemove)
        yield* guarded(id, "before-remove", Effect.suspend(plugin.beforeRemove));
    }),
    restart: Effect.fn("PluginRegistry.restart")(function* (id) {
      yield* Deferred.await(initialized);
      const item = configuration.plugins.find((entry) => entry.id === id);
      if (!item || !item.enabled) return false;
      active.delete(id);
      restartLimits.delete(id);
      entries.delete(id);
      const scope = pluginScopes.get(id);
      pluginScopes.delete(id);
      if (scope) yield* Scope.close(scope, Exit.void);
      yield* loadOne(item);
      yield* changed;
      return entries.get(id)?.status === "active";
    }),
    setHttpOrigin: Effect.fn("PluginRegistry.setHttpOrigin")((origin) =>
      Effect.sync(() => {
        httpOrigin = origin;
      }),
    ),
    setTerminalInputActivity: Effect.fn("PluginRegistry.setTerminalInputActivity")((source) =>
      Effect.sync(() => {
        terminalInputActivity = source;
      }),
    ),
    setNotificationDelivery: Effect.fn("PluginRegistry.setNotificationDelivery")((deliver) =>
      Effect.sync(() => {
        notificationDelivery = deliver;
      }),
    ),
    setThreads: Effect.fn("PluginRegistry.setThreads")((host) =>
      Effect.sync(() => {
        threadHost = host;
      }),
    ),
    changes: SubscriptionRef.changes(revision),
    list: Effect.fn("PluginRegistry.list")((scopes) =>
      Deferred.await(initialized).pipe(
        Effect.andThen(
          Effect.sync(() => ({
            configurationError,
            plugins: configuration.plugins.flatMap((item) => {
              const entry = entries.get(item.id);
              return entry
                ? [
                    {
                      ...entry,
                      restartLimit: item.restartLimit ?? 5,
                      ...(item.source ? { source: item.source } : {}),
                      commands: entry.commands.filter((c) => scopes.includes(c.permission)),
                      views: entry.views.filter((v) => scopes.includes(v.permission)),
                    },
                  ]
                : [];
            }),
          })),
        ),
      ),
    ),
    readView,
    execute,
    mcpServers: Effect.fn("PluginRegistry.mcpServers")(function* (context) {
      yield* Deferred.await(initialized);
      const servers: Record<string, PluginMcpServer> = {};
      for (const { id } of configuration.plugins) {
        const plugin = active.get(id);
        if (!plugin?.mcpServers) continue;
        if (entries.get(id)?.status !== "active")
          return yield* new PluginOperationError({
            pluginId: id,
            operation: "mcp-plugin-unavailable",
            cause: null,
          });
        const additional = yield* guarded(
          id,
          "mcp",
          Effect.suspend(() => plugin.mcpServers!(context)).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(PluginMcpServers)),
            Effect.flatMap(boundedResult),
          ),
        );
        for (const [name, config] of Object.entries(additional)) {
          if (!name.startsWith(`${id}-`) || Object.hasOwn(servers, name))
            return yield* new PluginOperationError({
              pluginId: id,
              operation: "mcp-server-name",
              cause: null,
            });
          servers[name] = config;
        }
      }
      return servers;
    }),
    prepareLaunch: Effect.fn("PluginRegistry.prepareLaunch")(function* (launch) {
      yield* Deferred.await(initialized);
      let current = launch;
      for (const { id } of configuration.plugins) {
        const plugin = active.get(id);
        if (!plugin) continue;
        if (plugin.prepareLaunch && entries.get(id)?.status !== "active")
          return yield* new PluginOperationError({
            pluginId: id,
            operation: "launch-plugin-unavailable",
            cause: null,
          });
        if (!plugin.prepareLaunch) continue;
        const hook = plugin.prepareLaunch;
        current = yield* guarded(
          id,
          "launch",
          Effect.suspend(() => hook(current)).pipe(Effect.flatMap(decodeLaunch)),
        );
      }
      return current;
    }),
    lifecycle: Effect.fn("PluginRegistry.lifecycle")(function* (event) {
      yield* Deferred.await(initialized);
      const decoded = yield* decodeLifecycleEvent(event).pipe(
        Effect.mapError(
          (cause) =>
            new PluginOperationError({ pluginId: "lifecycle", operation: "decode", cause }),
        ),
      );
      for (const item of configuration.plugins) {
        if (item.enabled && !active.has(item.id))
          return yield* new PluginOperationError({
            pluginId: item.id,
            operation: "lifecycle-plugin-unavailable",
            cause: null,
          });
      }
      for (const [id, contributions] of active) {
        if (!contributions.onLifecycle) continue;
        const result = yield* guarded(
          id,
          "lifecycle",
          Effect.suspend(() => contributions.onLifecycle!(decoded)).pipe(
            Effect.flatMap((value) => decodeLifecycleResult(value ?? null)),
          ),
          contributions.lifecycleTimeoutMs,
        );
        if (result)
          return yield* new PluginLifecycleBlocked({ pluginId: id, message: result.error });
      }
    }),
    handleHttp: Effect.fn("PluginRegistry.handleHttp")(function* (id, request) {
      yield* Deferred.await(initialized);
      const contributions = active.get(id);
      const handler = contributions?.handleHttp;
      return yield* handler
        ? guarded(
            id,
            "http",
            Effect.suspend(() => handler(request)),
            contributions?.httpResponseTimeoutMs ?? 30_000,
          )
        : Effect.succeed(new Response(null, { status: 404 }));
    }),
  });
});

export const layer = Layer.effect(PluginRegistry, make);

/** Capture at service construction so returned callbacks keep the environment's host. */
export const launchPreparer = Effect.serviceOption(PluginRegistry).pipe(
  Effect.map(
    (host) => (launch: PluginLaunch) =>
      Option.isSome(host) ? host.value.prepareLaunch(launch) : Effect.succeed(launch),
  ),
);
/** Embedders without a plugin host keep their existing launch behavior. */
export const prepareLaunch = (launch: PluginLaunch) =>
  launchPreparer.pipe(Effect.flatMap((prepare) => prepare(launch)));
