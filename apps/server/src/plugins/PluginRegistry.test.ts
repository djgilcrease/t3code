import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AuthStandardClientScopes, PluginOperationError, type T3Plugin } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as PluginModuleLoader from "./PluginModuleLoader.ts";
import * as PluginRegistry from "./PluginRegistry.ts";

const encodeOperationError = Schema.encodeEffect(Schema.fromJsonString(PluginOperationError));
const encodeConfig = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const plugin = (
  activate: T3Plugin["activate"] = () => Effect.succeed({}),
  id = "test",
): T3Plugin => ({
  apiVersion: 1,
  id,
  name: id,
  version: "1.0.0",
  activate,
});
const launch = {
  provider: "codex",
  purpose: "agent" as const,
  args: ["app-server"],
  environment: { ORIGINAL: "kept" },
};
const command = {
  id: "change",
  title: "Change",
  description: "Update state",
  permission: "providers:manage" as const,
  agent: false,
  run: () => Effect.succeed(null),
};
const envelope = {
  pluginId: "test",
  commandId: "change",
  permission: "providers:manage" as const,
  input: {},
};

function withHost<A, E, R>(
  modules: readonly unknown[],
  use: Effect.Effect<A, E, R | PluginRegistry.PluginRegistry>,
  options: { readonly configuration?: string; readonly enabled?: boolean } = {},
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-test-" });
      yield* fs.writeFileString(
        `${temp}/plugins.json`,
        options.configuration ??
          encodeConfig({
            plugins: modules.map((value, i) => ({
              id: (value as T3Plugin).id ?? `plugin-${i}`,
              path: `/plugins/${i}.mjs`,
              enabled: options.enabled ?? true,
            })),
          }),
      );
      const hostLayer = PluginRegistry.layer.pipe(
        Layer.provide(
          Layer.succeed(PluginModuleLoader.PluginModuleLoader, {
            load: (path) =>
              Effect.succeed({ default: modules[Number(path.split("/").at(-1)?.split(".")[0])] }),
          }),
        ),
        Layer.provide(ServerSecretStore.layer),
        Layer.provide(ServerConfig.layerTest(temp, temp)),
      );
      return yield* use.pipe(Effect.provide(hostLayer));
    }),
  ).pipe(Effect.provide(NodeServices.layer));
}

it.effect(
  "loads contributions and checks the actual command permission even when the client lies",
  () =>
    withHost(
      [plugin(() => Effect.succeed({ commands: [command] }))],
      Effect.gen(function* () {
        const host = yield* PluginRegistry.PluginRegistry;
        expect((yield* host.list(["orchestration:read"])).plugins[0]?.commands).toEqual([]);
        const denied = yield* host
          .execute({ ...envelope, permission: "orchestration:read" }, ["orchestration:read"])
          .pipe(Effect.flip);
        expect(denied._tag).toBe("EnvironmentAuthorizationError");
        expect(yield* host.execute(envelope, AuthStandardClientScopes)).toBeNull();
        expect(
          (yield* host.execute(envelope, AuthStandardClientScopes, "agent").pipe(Effect.flip))._tag,
        ).toBe("PluginRequestError");
      }),
    ),
);

it.effect("a read-only agent cannot invoke a write command with a forged read envelope", () =>
  withHost(
    [plugin(() => Effect.succeed({ commands: [{ ...command, agent: true }] }))],
    Effect.gen(function* () {
      const host = yield* PluginRegistry.PluginRegistry;
      const denied = yield* host
        .execute(
          { ...envelope, permission: "orchestration:read" },
          AuthStandardClientScopes,
          "agent-read",
        )
        .pipe(Effect.flip);
      expect(denied._tag).toBe("PluginRequestError");
    }),
  ),
);

it.effect("filters and authorizes views and rejects malformed view output", () =>
  withHost(
    [
      plugin(() =>
        Effect.succeed({
          views: [
            {
              id: "private",
              title: "Private",
              location: "settings",
              permission: "providers:manage",
              read: () =>
                Effect.succeed({
                  title: "Private",
                  blocks: [{ id: "private", kind: "text", text: "x".repeat(20_000) }],
                }),
            },
          ],
        }),
      ),
    ],
    Effect.gen(function* () {
      const host = yield* PluginRegistry.PluginRegistry;
      const input = { pluginId: "test", viewId: "private" };
      expect((yield* host.list(["orchestration:read"])).plugins[0]?.views).toEqual([]);
      expect((yield* host.readView(input, ["orchestration:read"]).pipe(Effect.flip))._tag).toBe(
        "EnvironmentAuthorizationError",
      );
      expect((yield* host.readView(input, AuthStandardClientScopes).pipe(Effect.flip))._tag).toBe(
        "PluginOperationError",
      );
    }),
  ),
);

it.effect("isolates activation failure and finalizes resources before reporting failure", () => {
  let finalized = false;
  return withHost(
    [
      plugin(() =>
        Effect.addFinalizer(() =>
          Effect.sync(() => {
            finalized = true;
          }),
        ).pipe(Effect.andThen(Effect.die("private error"))),
      ),
      plugin(undefined, "healthy"),
    ],
    Effect.gen(function* () {
      const host = yield* PluginRegistry.PluginRegistry;
      const catalog = yield* host.list(AuthStandardClientScopes);
      expect(finalized).toBe(true);
      expect(catalog.plugins.map((p) => p.status)).toEqual(["failed", "active"]);
    }),
  );
});

it.effect("closes active plugin scopes on shutdown", () => {
  let finalized = false;
  return withHost(
    [
      plugin(() =>
        Effect.addFinalizer(() =>
          Effect.sync(() => {
            finalized = true;
          }),
        ).pipe(Effect.as({})),
      ),
    ],
    Effect.flatMap(PluginRegistry.PluginRegistry, (host) => host.list(AuthStandardClientScopes)),
  ).pipe(Effect.tap(() => Effect.sync(() => expect(finalized).toBe(true))));
});

it.effect("does not activate disabled modules and rejects incompatible API versions", () => {
  let activated = false;
  const value = plugin(() =>
    Effect.sync(() => {
      activated = true;
      return {};
    }),
  );
  return Effect.gen(function* () {
    yield* withHost(
      [value],
      Effect.gen(function* () {
        const host = yield* PluginRegistry.PluginRegistry;
        expect((yield* host.list(AuthStandardClientScopes)).plugins[0]?.status).toBe("disabled");
      }),
      { enabled: false },
    );
    expect(activated).toBe(false);
    yield* withHost(
      [{ ...value, apiVersion: 2 }],
      Effect.gen(function* () {
        const host = yield* PluginRegistry.PluginRegistry;
        expect((yield* host.list(AuthStandardClientScopes)).plugins[0]?.status).toBe("failed");
      }),
    );
    expect(activated).toBe(false);
  });
});

it.effect("reports malformed and duplicate configuration without importing code", () =>
  Effect.gen(function* () {
    yield* withHost(
      [],
      Effect.gen(function* () {
        const host = yield* PluginRegistry.PluginRegistry;
        expect(yield* host.list(AuthStandardClientScopes)).toEqual({
          configurationError: true,
          plugins: [],
        });
      }),
      { configuration: "not json" },
    );
    yield* withHost(
      [plugin(), plugin()],
      Effect.gen(function* () {
        const host = yield* PluginRegistry.PluginRegistry;
        expect(yield* host.list(AuthStandardClientScopes)).toEqual({
          configurationError: true,
          plugins: [],
        });
      }),
    );
  }),
);

it.effect("applies launch hooks in configured order and leaves unconfigured hosts unchanged", () =>
  Effect.gen(function* () {
    expect(yield* PluginRegistry.prepareLaunch(launch)).toEqual(launch);
    yield* withHost(
      [
        plugin(() =>
          Effect.succeed({
            prepareLaunch: (input) =>
              Effect.succeed({
                ...input,
                args: [...input.args, "first"],
                environment: { ...input.environment, ROUTE: "set" },
              }),
          }),
        ),
        plugin(
          () =>
            Effect.succeed({
              prepareLaunch: (input) =>
                Effect.succeed({
                  ...input,
                  args: [...input.args, input.environment.ROUTE ?? "missing"],
                }),
            }),
          "second",
        ),
      ],
      Effect.gen(function* () {
        const host = yield* PluginRegistry.PluginRegistry;
        expect(yield* host.prepareLaunch(launch)).toEqual({
          ...launch,
          args: ["app-server", "first", "set"],
          environment: { ORIGINAL: "kept", ROUTE: "set" },
        });
        expect(launch.environment).toEqual({ ORIGINAL: "kept" });
      }),
    );
  }),
);

it.effect("wraps command defects without disclosing private error messages", () =>
  withHost(
    [
      plugin(() =>
        Effect.succeed({ commands: [{ ...command, run: () => Effect.die("secret=private") }] }),
      ),
    ],
    Effect.gen(function* () {
      const host = yield* PluginRegistry.PluginRegistry;
      const error = yield* host.execute(envelope, AuthStandardClientScopes).pipe(Effect.flip);
      expect(error.message).not.toContain("private");
      expect(error._tag).toBe("PluginOperationError");
      const encoded = yield* encodeOperationError(
        new PluginOperationError({
          pluginId: "test",
          operation: "command",
          cause: { token: "private" },
        }),
      );
      expect(encoded).not.toContain("private");
      expect(encoded).toContain('"cause":null');
    }),
  ),
);

it.effect("namespaces secrets without collisions and rejects traversal keys", () => {
  const testSecrets = (id: string, key: string, value: string) =>
    plugin(
      (context) =>
        Effect.gen(function* () {
          yield* context.secrets.set(key, value);
          return { commands: [{ ...command, id: "read", run: () => context.secrets.get(key) }] };
        }),
      id,
    );
  return withHost(
    [
      testSecrets("foo-bar", "baz", "one"),
      testSecrets("foo", "bar-baz", "two"),
      plugin((ctx) => ctx.secrets.set("../escape", "bad").pipe(Effect.as({})), "invalid"),
    ],
    Effect.gen(function* () {
      const host = yield* PluginRegistry.PluginRegistry;
      expect(
        yield* host.execute(
          { ...envelope, pluginId: "foo-bar", commandId: "read" },
          AuthStandardClientScopes,
        ),
      ).toBe("one");
      expect(
        yield* host.execute(
          { ...envelope, pluginId: "foo", commandId: "read" },
          AuthStandardClientScopes,
        ),
      ).toBe("two");
      expect((yield* host.list(AuthStandardClientScopes)).plugins[2]?.status).toBe("failed");
    }),
  );
});

it.effect("notifies clients after commands without polling", () =>
  withHost(
    [plugin(() => Effect.succeed({ commands: [command] }))],
    Effect.gen(function* () {
      const host = yield* PluginRegistry.PluginRegistry;
      const before = yield* host.changes.pipe(Stream.take(1), Stream.runCollect);
      yield* host.execute(envelope, AuthStandardClientScopes);
      const after = yield* host.changes.pipe(Stream.take(1), Stream.runCollect);
      expect(after[0]).toBe((before[0] ?? 0) + 1);
    }),
  ),
);

it.effect(
  "loads a standalone routing plugin from outside the repository and routes launches through its own HTTP endpoint",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temp = yield* fs.makeTempDirectoryScoped({ prefix: "external-t3-plugin-" });
        const root = path.resolve(import.meta.dirname, "../../../..");
        yield* fs.makeDirectory(`${temp}/node_modules/@t3tools`, { recursive: true });
        yield* fs.symlink(
          `${root}/packages/plugin-sdk`,
          `${temp}/node_modules/@t3tools/plugin-sdk`,
        );
        yield* fs.symlink(
          `${root}/packages/plugin-sdk/node_modules/effect`,
          `${temp}/node_modules/effect`,
        );
        yield* fs.copyFile(
          `${root}/packages/plugin-sdk/examples/model-routing/plugin.mjs`,
          `${temp}/plugin.mjs`,
        );
        yield* fs.writeFileString(
          `${temp}/plugins.json`,
          encodeConfig({
            plugins: [{ id: "model-routing", path: `${temp}/plugin.mjs`, enabled: true }],
          }),
        );
        yield* Effect.gen(function* () {
          const host = yield* PluginRegistry.PluginRegistry;
          expect((yield* host.list(AuthStandardClientScopes)).plugins[0]?.status).toBe("active");
          yield* host.setHttpOrigin("http://127.0.0.1:54321");
          const input = {
            ...envelope,
            pluginId: "model-routing",
            commandId: "configure",
            input: {
              endpoint: "https://model.example/v1",
              token: "upstream-private",
              "gateway-key": "gateway-private",
            },
          };
          yield* host.execute(input, AuthStandardClientScopes);
          const prepared = yield* host.prepareLaunch(launch);
          expect(prepared.environment.T3_ROUTING_KEY).toBe("gateway-private");
          expect(prepared.args.join(" ")).toContain(
            "http://127.0.0.1:54321/api/plugins/model-routing/v1",
          );
          expect(prepared.args.join(" ")).not.toContain("upstream-private");
          const usage = yield* host.readView(
            { pluginId: "model-routing", viewId: "usage" },
            AuthStandardClientScopes,
          );
          expect(usage.title).toBe("Model routing");
          const response = yield* host.handleHttp(
            "model-routing",
            new Request("http://test/api/plugins/model-routing/v1/models"),
          );
          expect(response.status).toBe(401);
          yield* host.execute(
            { ...envelope, pluginId: "model-routing", commandId: "disable" },
            AuthStandardClientScopes,
            "agent",
          );
          expect(yield* host.prepareLaunch(launch)).toEqual(launch);
        }).pipe(
          Effect.provide(
            PluginRegistry.layer.pipe(
              Layer.provide(PluginModuleLoader.layer),
              Layer.provide(ServerSecretStore.layer),
              Layer.provide(ServerConfig.layerTest(temp, temp)),
            ),
          ),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "discloses a secret result only through an explicit client command with a write permission",
  () =>
    withHost(
      [
        plugin(() =>
          Effect.succeed({
            commands: [
              {
                ...command,
                agent: true,
                run: () =>
                  Effect.succeed({ $t3: "secret", label: "API key", value: "private-test-value" }),
              },
            ],
          }),
        ),
      ],
      Effect.gen(function* () {
        const host = yield* PluginRegistry.PluginRegistry;
        expect(yield* host.execute(envelope, AuthStandardClientScopes)).toMatchObject({
          $t3: "secret",
          label: "API key",
        });
        expect(
          yield* host.execute(envelope, AuthStandardClientScopes, "agent").pipe(Effect.flip),
        ).toMatchObject({ reason: "secret-access-disabled" });
      }),
    ),
);

it.effect("constructs the environment services while a plugin activation is stalled", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    yield* withHost(
      [plugin(() => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)))],
      Effect.gen(function* () {
        const host = yield* PluginRegistry.PluginRegistry;
        yield* Deferred.await(started);
        yield* host.setHttpOrigin("http://localhost:43123");
        const bootstrap = yield* host.list(AuthStandardClientScopes).pipe(Effect.forkChild);
        expect(bootstrap.pollUnsafe()).toBeUndefined();
      }),
    );
  }),
);
