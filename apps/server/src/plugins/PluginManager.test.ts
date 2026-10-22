import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AuthStandardClientScopes, PluginError, PluginOperationError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as PluginManager from "./PluginManager.ts";
import * as PluginModuleLoader from "./PluginModuleLoader.ts";
import * as PluginPackages from "./PluginPackages.ts";
import * as PluginRegistry from "./PluginRegistry.ts";
import type { PluginConfigurationEntry } from "./pluginConfiguration.ts";

const repository = "https://github.com/team/example.git";
const sha = (version: number) => String(version).repeat(40);
const source = (version: number, checkedAt: number) => ({
  repository,
  tag: `v${version}.0.0`,
  commit: sha(version),
  checkedAt,
  latestTag: `v${version}.0.0`,
  latestCommit: sha(version),
  checkFailed: false,
});
type State = {
  version: number;
  failVersion: number | null;
  checkFails: boolean;
  checks: number;
  loads: number;
  closed: number;
  removed: string[];
  persistFails: boolean;
};

function fixture<A, E, R>(
  use: (
    temp: string,
    state: State,
  ) => Effect.Effect<
    A,
    E,
    | R
    | PluginManager.PluginManager
    | PluginRegistry.PluginRegistry
    | ServerSecretStore.ServerSecretStore
  >,
  options: { manual?: boolean; malformed?: boolean } = {},
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-manager-" });
      const state: State = {
        version: 1,
        failVersion: null,
        checkFails: false,
        checks: 0,
        loads: 0,
        closed: 0,
        removed: [],
        persistFails: false,
      };
      const manual: PluginConfigurationEntry = {
        id: "example",
        path: `${temp}/manual/v1.mjs`,
        enabled: true,
      };
      yield* fs.makeDirectory(`${temp}/manual`, { recursive: true });
      yield* fs.writeFileString(manual.path, "manual source");
      yield* fs.writeFileString(
        `${temp}/plugins.json`,
        options.malformed
          ? "broken config"
          : JSON.stringify({ plugins: options.manual ? [manual] : [] }),
      );
      const packages = Layer.succeed(PluginPackages.PluginPackages, {
        latest: () =>
          Effect.sync(() => {
            state.checks++;
          }).pipe(
            Effect.andThen(
              Effect.suspend(() =>
                state.checkFails
                  ? Effect.fail(
                      new PluginOperationError({
                        pluginId: "example",
                        operation: "git",
                        cause: null,
                      }),
                    )
                  : Effect.succeed({
                      repository,
                      tag: `v${state.version}.0.0`,
                      commit: sha(state.version),
                    }),
              ),
            ),
          ),
        prepare: (repo) =>
          Effect.gen(function* () {
            const id = repo.includes("second") ? "second" : "example";
            const entry = `${temp}/plugin-packages/${id}/v${state.version}.mjs`;
            yield* fs.makeDirectory(`${temp}/plugin-packages/${id}`, { recursive: true });
            yield* fs.writeFileString(entry, "packaged source");
            return {
              id,
              path: entry,
              enabled: true,
              source: source(state.version, yield* Clock.currentTimeMillis),
            };
          }).pipe(Effect.orDie),
        remove: (id) =>
          Effect.sync(() => {
            state.removed.push(id);
          }).pipe(
            Effect.andThen(
              fs.remove(`${temp}/plugin-packages/${id}`, { recursive: true, force: true }),
            ),
            Effect.orDie,
          ),
      });
      const loader = Layer.succeed(PluginModuleLoader.PluginModuleLoader, {
        load: (entry) =>
          Effect.sync(() => {
            state.loads++;
            const version = Number(/v(\d+)\.mjs$/.exec(entry)?.[1]);
            const id = entry.includes("/second/") ? "second" : "example";
            return {
              default: {
                apiVersion: 1,
                id,
                name: id,
                version: `${version}.0.0`,
                activate: () =>
                  Effect.gen(function* () {
                    yield* Effect.addFinalizer(() =>
                      Effect.sync(() => {
                        state.closed++;
                      }),
                    );
                    if (version === state.failVersion)
                      return yield* new PluginError({ operation: "activation", cause: null });
                    return {};
                  }),
              },
            };
          }),
      });
      const config = ServerConfig.layerTest(temp, temp);
      const secrets = ServerSecretStore.layer.pipe(Layer.provide(config));
      const registry = PluginRegistry.layer.pipe(
        Layer.provide(loader),
        Layer.provide(config),
        Layer.provide(secrets),
      );
      const manager = PluginManager.layer.pipe(
        Layer.provide(packages),
        Layer.provideMerge(registry),
        Layer.provideMerge(secrets),
        Layer.provide(config),
        Layer.provide(
          Layer.succeed(FileSystem.FileSystem, {
            ...fs,
            rename: (from, to) =>
              state.persistFails && to === `${temp}/plugins.json`
                ? Effect.fail(
                    PlatformError.systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "rename",
                    }),
                  )
                : fs.rename(from, to),
          }),
        ),
      );
      return yield* use(temp, state).pipe(Effect.provide(manager));
    }),
  ).pipe(Effect.provide(NodeServices.layer));
}

it.effect(
  "installs without a restart, persists configuration, and serializes concurrent installs",
  () =>
    fixture((temp, state) =>
      Effect.gen(function* () {
        const manager = yield* PluginManager.PluginManager;
        const fs = yield* FileSystem.FileSystem;
        const catalogs = yield* Effect.all(
          [
            manager.manage({ operation: "install", repository }, AuthStandardClientScopes),
            manager.manage(
              { operation: "install", repository: "https://gitlab.com/team/second" },
              AuthStandardClientScopes,
            ),
          ],
          { concurrency: "unbounded" },
        );
        expect(catalogs.at(-1)?.plugins).toHaveLength(2);
        expect(JSON.parse(yield* fs.readFileString(`${temp}/plugins.json`)).plugins).toHaveLength(
          2,
        );
        expect(state.loads).toBe(2);
        const duplicate = yield* manager
          .manage({ operation: "install", repository }, AuthStandardClientScopes)
          .pipe(Effect.flip);
        expect(duplicate._tag).toBe("PluginRequestError");
        expect((yield* fs.stat(`${temp}/plugins.json`)).mode & 0o777).toBe(0o600);
      }),
    ),
);

it.effect("checks daily and on demand without reloading or automatically installing updates", () =>
  fixture((temp, state) =>
    Effect.gen(function* () {
      const manager = yield* PluginManager.PluginManager;
      const registry = yield* PluginRegistry.PluginRegistry;
      const fs = yield* FileSystem.FileSystem;
      yield* manager.manage({ operation: "install", repository }, AuthStandardClientScopes);
      state.version = 2;
      yield* TestClock.adjust("24 hours");
      const checked = yield* registry.changes.pipe(
        Stream.mapEffect(() => registry.list(AuthStandardClientScopes)),
        Stream.filter((catalog) => catalog.plugins[0]?.source?.latestTag === "v2.0.0"),
        Stream.take(1),
        Stream.runCollect,
      );
      expect(checked[0]?.plugins[0]).toMatchObject({
        version: "1.0.0",
        source: { tag: "v1.0.0", latestTag: "v2.0.0" },
      });
      expect(state.checks).toBe(1);
      expect(state.loads).toBe(1);
      yield* TestClock.adjust("23 hours");
      expect(state.checks).toBe(1);
      state.version = 3;
      const manual = yield* manager.manage({ operation: "check" }, AuthStandardClientScopes);
      expect(manual.plugins[0]?.source?.latestTag).toBe("v3.0.0");
      expect(state.loads).toBe(1);
      const updated = yield* manager.manage(
        { operation: "update", pluginId: "example" },
        AuthStandardClientScopes,
      );
      expect(updated.plugins[0]).toMatchObject({
        version: "3.0.0",
        status: "active",
        source: { commit: sha(3) },
      });
      expect(state.closed).toBe(1);
      expect(
        JSON.parse(yield* fs.readFileString(`${temp}/plugins.json`)).plugins[0].source.commit,
      ).toBe(sha(3));
    }),
  ),
);

it.effect(
  "reports failed update checks while keeping the installed version and last known update",
  () =>
    fixture((_, state) =>
      Effect.gen(function* () {
        const manager = yield* PluginManager.PluginManager;
        yield* manager.manage({ operation: "install", repository }, AuthStandardClientScopes);
        state.version = 2;
        yield* manager.manage({ operation: "check" }, AuthStandardClientScopes);
        state.checkFails = true;
        const catalog = yield* manager.manage({ operation: "check" }, AuthStandardClientScopes);
        expect(catalog.plugins[0]).toMatchObject({
          status: "active",
          version: "1.0.0",
          source: { latestTag: "v2.0.0", checkFailed: true },
        });
        expect(state.loads).toBe(1);
      }),
    ),
);

it.effect("rolls back a failed update and leaves its previous configuration persisted", () =>
  fixture((temp, state) =>
    Effect.gen(function* () {
      const manager = yield* PluginManager.PluginManager;
      const registry = yield* PluginRegistry.PluginRegistry;
      const fs = yield* FileSystem.FileSystem;
      yield* manager.manage({ operation: "install", repository }, AuthStandardClientScopes);
      const before = yield* fs.readFileString(`${temp}/plugins.json`);
      state.version = 2;
      state.failVersion = 2;
      expect(
        (yield* manager
          .manage({ operation: "update", pluginId: "example" }, AuthStandardClientScopes)
          .pipe(Effect.flip))._tag,
      ).toBe("PluginOperationError");
      expect((yield* registry.list(AuthStandardClientScopes)).plugins[0]).toMatchObject({
        version: "1.0.0",
        status: "active",
      });
      expect(yield* fs.readFileString(`${temp}/plugins.json`)).toBe(before);
      expect(state.closed).toBe(2);
    }),
  ),
);

it.effect(
  "disables, enables, configures the restart limit, and retries without restarting T3",
  () =>
    fixture((_, state) =>
      Effect.gen(function* () {
        const manager = yield* PluginManager.PluginManager;
        yield* manager.manage({ operation: "install", repository }, AuthStandardClientScopes);
        expect(
          (yield* manager.manage(
            { operation: "set-enabled", pluginId: "example", enabled: false },
            AuthStandardClientScopes,
          )).plugins[0]?.status,
        ).toBe("disabled");
        expect(state.closed).toBe(1);
        expect(
          (yield* manager.manage(
            { operation: "set-enabled", pluginId: "example", enabled: true },
            AuthStandardClientScopes,
          )).plugins[0]?.status,
        ).toBe("active");
        expect(
          (yield* manager.manage(
            { operation: "set-restart-limit", pluginId: "example", attempts: 2 },
            AuthStandardClientScopes,
          )).plugins[0]?.restartLimit,
        ).toBe(2);
        const before = state.loads;
        yield* manager.manage(
          { operation: "restart", pluginId: "example" },
          AuthStandardClientScopes,
        );
        expect(state.loads).toBe(before + 1);
      }),
    ),
);

it.effect(
  "unregisters before clearing only the removed plugin's data, packages, and credentials",
  () =>
    fixture((temp, state) =>
      Effect.gen(function* () {
        const manager = yield* PluginManager.PluginManager;
        const registry = yield* PluginRegistry.PluginRegistry;
        const fs = yield* FileSystem.FileSystem;
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        yield* manager.manage({ operation: "install", repository }, AuthStandardClientScopes);
        yield* fs.writeFileString(`${temp}/plugins/example/cache`, "cached");
        yield* secrets.set("plugin.example.token", new TextEncoder().encode("private"));
        yield* secrets.set("plugin.example-other.token", new TextEncoder().encode("keep"));
        expect(
          (yield* manager.manage(
            { operation: "remove", pluginId: "example" },
            AuthStandardClientScopes,
          )).plugins,
        ).toEqual([]);
        expect((yield* registry.configuration).plugins).toEqual([]);
        expect(state.closed).toBe(1);
        expect(state.removed).toEqual(["example"]);
        expect(yield* fs.exists(`${temp}/plugins/example`)).toBe(false);
        expect(yield* fs.exists(`${temp}/plugin-packages/example`)).toBe(false);
        expect(Option.isNone(yield* secrets.get("plugin.example.token"))).toBe(true);
        expect(Option.isSome(yield* secrets.get("plugin.example-other.token"))).toBe(true);
      }),
    ),
);

it.effect("keeps manually registered source folders on removal", () =>
  fixture(
    (temp, state) =>
      Effect.gen(function* () {
        const manager = yield* PluginManager.PluginManager;
        const fs = yield* FileSystem.FileSystem;
        yield* manager.manage(
          { operation: "remove", pluginId: "example" },
          AuthStandardClientScopes,
        );
        expect(state.removed).toEqual([]);
        expect(yield* fs.readFileString(`${temp}/manual/v1.mjs`)).toBe("manual source");
      }),
    { manual: true },
  ),
);

it.effect("refuses to overwrite malformed configuration during a settings operation", () =>
  fixture(
    (temp) =>
      Effect.gen(function* () {
        const manager = yield* PluginManager.PluginManager;
        const fs = yield* FileSystem.FileSystem;
        expect(
          (yield* manager
            .manage({ operation: "install", repository }, AuthStandardClientScopes)
            .pipe(Effect.flip))._tag,
        ).toBe("PluginOperationError");
        expect(yield* fs.readFileString(`${temp}/plugins.json`)).toBe("broken config");
      }),
    { malformed: true },
  ),
);

it.effect("restores the running version if saving an activated update fails", () =>
  fixture((temp, state) =>
    Effect.gen(function* () {
      const manager = yield* PluginManager.PluginManager;
      const registry = yield* PluginRegistry.PluginRegistry;
      const fs = yield* FileSystem.FileSystem;
      yield* manager.manage({ operation: "install", repository }, AuthStandardClientScopes);
      const before = yield* fs.readFileString(`${temp}/plugins.json`);
      state.version = 2;
      state.persistFails = true;
      const result = yield* manager
        .manage({ operation: "update", pluginId: "example" }, AuthStandardClientScopes)
        .pipe(Effect.flip);
      expect(result._tag).toBe("PluginOperationError");
      expect((yield* registry.list(AuthStandardClientScopes)).plugins[0]).toMatchObject({
        version: "1.0.0",
        status: "active",
      });
      expect(yield* fs.readFileString(`${temp}/plugins.json`)).toBe(before);
      expect(state.closed).toBe(2);
    }),
  ),
);

it.effect("authorizes management in the service before changing the environment", () =>
  fixture((_, state) =>
    Effect.gen(function* () {
      const manager = yield* PluginManager.PluginManager;
      const result = yield* manager
        .manage({ operation: "install", repository }, ["orchestration:read"])
        .pipe(Effect.flip);
      expect(result._tag).toBe("EnvironmentAuthorizationError");
      expect(state.loads).toBe(0);
    }),
  ),
);
