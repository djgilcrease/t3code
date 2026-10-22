import {
  PluginCatalog,
  PluginCommandDescriptor,
  PluginManifest,
  PluginViewDescriptor,
  PluginView,
  PluginRuntimeHealth,
  PluginSecretResult,
  PluginLocalId,
  PluginError,
  PluginOperationError,
  PluginRequestError,
  EnvironmentAuthorizationError,
  authScopeRequiredResponse,
  type AuthEnvironmentScope,
  type PluginCommandInput,
  type PluginViewInput,
  type PluginContributions,
  type PluginContext,
  type PluginLaunch,
  type T3Plugin,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
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
const decodeLaunch = Schema.decodeUnknownEffect(Launch);
type RequestError = PluginOperationError | PluginRequestError | EnvironmentAuthorizationError;

export class PluginRegistry extends Context.Service<
  PluginRegistry,
  {
    readonly configuration: Effect.Effect<PluginConfiguration>;
    readonly reconcile: (next: PluginConfiguration) => Effect.Effect<boolean>;
    readonly restart: (id: string) => Effect.Effect<boolean>;
    readonly setHttpOrigin: (origin: string) => Effect.Effect<void>;
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
    ) => Effect.Effect<Schema.Json, RequestError>;
    readonly prepareLaunch: (
      launch: PluginLaunch,
    ) => Effect.Effect<PluginLaunch, PluginOperationError>;
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
      Effect.flatMap((value) =>
        new Set(value.plugins.map((p) => p.id)).size === value.plugins.length
          ? Effect.succeed(value)
          : Effect.fail(new PluginError({ operation: "duplicate-id", cause: null })),
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
      const context: PluginContext = {
        id: item.id,
        dataDirectory,
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
        (contributions.prepareLaunch !== undefined &&
          typeof contributions.prepareLaunch !== "function") ||
        (contributions.handleHttp !== undefined && typeof contributions.handleHttp !== "function")
      ) {
        return yield* new PluginError({ operation: "contributions", cause: null });
      }
      active.set(item.id, contributions);
      if (module.setRestartLimit) restartLimits.set(item.id, module.setRestartLimit);
      entries.set(item.id, { ...manifest, status: "active", commands, views });
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
          Stream.runForEach(() => changed),
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
  for (const item of configuration.plugins) yield* loadOne(item);
  const reconcile: PluginRegistry["Service"]["reconcile"] = Effect.fn("PluginRegistry.reconcile")(
    function* (next) {
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
  const getPlugin = (id: string) => {
    const plugin = active.get(id);
    return plugin && entries.get(id)?.status === "active"
      ? Effect.succeed(plugin)
      : Effect.fail(new PluginRequestError({ pluginId: id, reason: "unavailable" }));
  };
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
        Effect.suspend(view.read).pipe(Effect.flatMap(decodeView), Effect.flatMap(boundedResult)),
      );
    },
  );
  const execute: PluginRegistry["Service"]["execute"] = Effect.fn("PluginRegistry.execute")(
    function* (input, scopes, audience = "client") {
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
        Effect.suspend(() => command.run(input.input)).pipe(
          Effect.flatMap(decodeJson),
          Effect.flatMap(boundedResult),
          Effect.ensuring(changed),
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
    configuration: Effect.sync(() => configuration),
    reconcile,
    restart: Effect.fn("PluginRegistry.restart")(function* (id) {
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
    setHttpOrigin: (origin) =>
      Effect.sync(() => {
        httpOrigin = origin;
      }),
    changes: SubscriptionRef.changes(revision),
    list: (scopes) =>
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
    readView,
    execute,
    prepareLaunch: Effect.fn("PluginRegistry.prepareLaunch")(function* (launch) {
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
    handleHttp: (id, request) => {
      const handler = active.get(id)?.handleHttp;
      return handler
        ? guarded(
            id,
            "http",
            Effect.suspend(() => handler(request)),
          )
        : Effect.succeed(new Response(null, { status: 404 }));
    },
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
