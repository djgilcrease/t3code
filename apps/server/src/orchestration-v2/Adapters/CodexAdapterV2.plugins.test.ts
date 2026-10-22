import { assert, describe, it } from "@effect/vitest";
import { CodexSettings, ThreadId, ProviderSessionId, PluginOperationError } from "@t3tools/contracts";
import { Platform as HostProcessPlatform } from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as PlatformError from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as PluginRegistry from "../../plugins/PluginRegistry.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
const DEFAULT_CODEX_SETTINGS = Schema.decodeSync(CodexSettings)({});
describe("Codex plugin launch integration", () => {
  it.effect(
    "applies plugin routing at spawn and refuses to spawn when the routing hook fails",
    () =>
      Effect.gen(function* () {
        const spawned: Array<{ args: readonly string[]; env: unknown }> = [];
        const spawner = ChildProcessSpawner.make((command) => {
          if (ChildProcess.isStandardCommand(command))
            spawned.push({ args: command.args, env: command.options.env });
          return Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "ChildProcess",
              method: "spawn",
            }),
          );
        });
        let routingAvailable = true;
        const factory = yield* CodexAdapterV2.CodexAppServerClientFactory.pipe(
          Effect.provide(CodexAdapterV2.layerAppServerClientFactory),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
          Effect.provide(
            Layer.mock(PluginRegistry.PluginRegistry)({
              prepareLaunch: (launch) =>
                routingAvailable
                  ? Effect.succeed({
                      ...launch,
                      args: [...launch.args, "--plugin-route"],
                      environment: {
                        ...launch.environment,
                        PLUGIN_ROUTE: "private",
                        DELETE_ME: undefined,
                      },
                    })
                  : Effect.fail(
                      new PluginOperationError({
                        pluginId: "routing",
                        operation: "launch-plugin-unavailable",
                        cause: null,
                      }),
                    ),
            }),
          ),
        );
        const open = factory
          .open({
            instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
            threadId: ThreadId.make("thread-plugin-routing"),
            providerSessionId: ProviderSessionId.make("session-plugin-routing"),
            runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: "/workspace",
            }),
            settings: DEFAULT_CODEX_SETTINGS,
            environment: { ORIGINAL: "kept", DELETE_ME: "remove" },
          })
          .pipe(Effect.scoped, Effect.exit);
        yield* open;
        assert.lengthOf(spawned, 1);
        assert.include(spawned[0]?.args ?? [], "--plugin-route");
        assert.deepEqual(spawned[0]?.env, {
          ORIGINAL: "kept",
          CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "T3 Code",
          DELETE_ME: undefined,
          PLUGIN_ROUTE: "private",
        });
        routingAvailable = false;
        yield* open;
        assert.lengthOf(spawned, 1);
      }).pipe(Effect.provideService(HostProcessPlatform, "linux")),
  );

});
