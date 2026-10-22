import {
  PluginOperationError,
  PluginRequestError,
  AuthEnvironmentMaintainScope,
  EnvironmentAuthorizationError,
  authScopeRequiredResponse,
  type PluginCatalog,
  type PluginManageInput,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as PluginPackages from "./PluginPackages.ts";
import * as PluginRegistry from "./PluginRegistry.ts";
import { PluginConfiguration, type PluginConfigurationEntry } from "./pluginConfiguration.ts";

const DAY = 24 * 60 * 60 * 1000;
const encodeConfiguration = Schema.encodeEffect(Schema.fromJsonString(PluginConfiguration));
const decodeConfiguration = Schema.decodeUnknownEffect(PluginConfiguration);
type ManagerError = PluginOperationError | PluginRequestError | EnvironmentAuthorizationError;

export class PluginManager extends Context.Service<
  PluginManager,
  {
    readonly manage: (
      input: PluginManageInput,
      scopes: readonly AuthEnvironmentScope[],
    ) => Effect.Effect<PluginCatalog, ManagerError>;
  }
>()("t3/plugins/PluginManager") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const packages = yield* PluginPackages.PluginPackages;
  const registry = yield* PluginRegistry.PluginRegistry;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  // One actor owns lifecycle writes, including background checks. This keeps
  // install/update/remove ordered without locks or lost configuration writes.
  const jobs = yield* Queue.unbounded<Effect.Effect<void>>();
  yield* Stream.fromQueue(jobs).pipe(
    Stream.runForEach((job) => job),
    Effect.forkScoped,
  );
  const serial = <A>(operation: Effect.Effect<A, ManagerError>) =>
    Effect.gen(function* () {
      const reply = yield* Deferred.make<A, ManagerError>();
      yield* Queue.offer(
        jobs,
        operation.pipe(
          Effect.exit,
          Effect.flatMap((exit) => Deferred.done(reply, exit)),
          Effect.asVoid,
        ),
      );
      return yield* Deferred.await(reply);
    });
  const persist = (next: PluginConfiguration) =>
    Effect.scoped(
      Effect.gen(function* () {
        const text = yield* encodeConfiguration(next);
        const temp = yield* Effect.acquireRelease(
          fs.makeTempFile({ directory: config.baseDir, prefix: "plugins-" }),
          (file) => fs.remove(file, { force: true }).pipe(Effect.ignore),
        );
        yield* fs.chmod(temp, 0o600);
        yield* fs.writeFileString(temp, text);
        yield* fs.rename(temp, path.join(config.baseDir, "plugins.json"));
      }),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new PluginOperationError({ pluginId: "manager", operation: "save-configuration", cause }),
      ),
    );

  const commit = Effect.fn("PluginManager.commit")(function* (next: PluginConfiguration) {
    yield* decodeConfiguration(next).pipe(
      Effect.mapError(
        (cause) =>
          new PluginOperationError({ pluginId: "manager", operation: "configuration", cause }),
      ),
    );
    const previous = yield* registry.configuration;
    const activated = yield* registry.reconcile(next);
    if (!activated) {
      yield* registry.reconcile(previous);
      return yield* new PluginOperationError({
        pluginId: "manager",
        operation: "activation",
        cause: null,
      });
    }
    yield* persist(next).pipe(Effect.onError(() => registry.reconcile(previous)));
  });

  const check = Effect.fn("PluginManager.check")(function* (onlyDue: boolean) {
    const current = yield* registry.configuration;
    const now = yield* Clock.currentTimeMillis;
    const plugins = yield* Effect.forEach(current.plugins, (entry) =>
      Effect.gen(function* () {
        if (!entry.source || (onlyDue && now - entry.source.checkedAt < DAY)) return entry;
        const latest = yield* packages.latest(entry.source.repository).pipe(Effect.result);
        return {
          ...entry,
          source: {
            ...entry.source,
            checkedAt: now,
            ...(latest._tag === "Success"
              ? {
                  latestTag: latest.success.tag,
                  latestCommit: latest.success.commit,
                  checkFailed: false,
                }
              : { checkFailed: true }),
          },
        };
      }),
    );
    if (plugins.some((entry, i) => entry !== current.plugins[i])) yield* commit({ plugins });
  });
  yield* Effect.gen(function* () {
    for (;;) {
      yield* serial(check(true)).pipe(
        Effect.catch(() => Effect.logWarning("Plugin update check failed.")),
      );
      const current = yield* registry.configuration;
      const now = yield* Clock.currentTimeMillis;
      const next = Math.min(
        now + DAY,
        ...current.plugins.flatMap((entry) => (entry.source ? [entry.source.checkedAt + DAY] : [])),
      );
      yield* Effect.sleep(Math.max(60_000, next - now));
    }
  }).pipe(Effect.forkScoped);

  const removeData = (entry: PluginConfigurationEntry) =>
    Effect.gen(function* () {
      const names = yield* fs.readDirectory(config.secretsDir);
      for (const name of names) {
        if (name.startsWith(`plugin.${entry.id}.`) && name.endsWith(".bin"))
          yield* secrets.remove(name.slice(0, -4));
      }
      yield* fs.remove(path.join(config.baseDir, "plugins", entry.id), {
        recursive: true,
        force: true,
      });
      if (entry.source) yield* packages.remove(entry.id);
    }).pipe(
      Effect.mapError(
        (cause) =>
          new PluginOperationError({ pluginId: entry.id, operation: "remove-data", cause }),
      ),
    );

  return PluginManager.of({
    manage: (input, scopes) =>
      serial(
        Effect.gen(function* () {
          if (!scopes.includes(AuthEnvironmentMaintainScope))
            return yield* new EnvironmentAuthorizationError({
              message: `The authenticated token is missing required scope: ${AuthEnvironmentMaintainScope}.`,
              ...authScopeRequiredResponse(AuthEnvironmentMaintainScope),
            });
          if ((yield* registry.list(scopes)).configurationError)
            return yield* new PluginOperationError({
              pluginId: "manager",
              operation: "read-configuration",
              cause: null,
            });
          const current = yield* registry.configuration;
          if (input.operation === "check") yield* check(false);
          else if (input.operation === "install") {
            const installed = yield* packages.prepare(input.repository);
            if (current.plugins.some((entry) => entry.id === installed.id))
              return yield* new PluginRequestError({
                pluginId: installed.id,
                reason: "already-installed",
              });
            yield* commit({ plugins: [...current.plugins, installed] });
          } else {
            const entry = current.plugins.find((entry) => entry.id === input.pluginId);
            if (!entry)
              return yield* new PluginRequestError({
                pluginId: input.pluginId,
                reason: "unavailable",
              });
            if (input.operation === "remove") {
              yield* commit({ plugins: current.plugins.filter((item) => item.id !== entry.id) });
              yield* removeData(entry);
            } else if (input.operation === "set-enabled") {
              yield* commit({
                plugins: current.plugins.map((item) =>
                  item.id === entry.id ? { ...item, enabled: input.enabled } : item,
                ),
              });
            } else if (input.operation === "set-restart-limit") {
              yield* commit({
                plugins: current.plugins.map((item) =>
                  item.id === entry.id ? { ...item, restartLimit: input.attempts } : item,
                ),
              });
            } else if (input.operation === "restart") {
              if (!(yield* registry.restart(entry.id)))
                return yield* new PluginOperationError({
                  pluginId: entry.id,
                  operation: "restart",
                  cause: null,
                });
            } else {
              if (!entry.source)
                return yield* new PluginRequestError({ pluginId: entry.id, reason: "not-managed" });
              const replacement = yield* packages.prepare(entry.source.repository);
              if (replacement.id !== entry.id)
                return yield* new PluginOperationError({
                  pluginId: entry.id,
                  operation: "identity-changed",
                  cause: null,
                });
              yield* commit({
                plugins: current.plugins.map((item) =>
                  item.id === entry.id
                    ? {
                        ...replacement,
                        enabled: entry.enabled,
                        ...(entry.restartLimit === undefined
                          ? {}
                          : { restartLimit: entry.restartLimit }),
                      }
                    : item,
                ),
              });
            }
          }
          return yield* registry.list(scopes);
        }),
      ),
  });
});
export const layer = Layer.effect(PluginManager, make);
