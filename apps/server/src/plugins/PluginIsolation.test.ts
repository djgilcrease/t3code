import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AuthStandardClientScopes } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as PluginModuleLoader from "./PluginModuleLoader.ts";
import * as PluginRegistry from "./PluginRegistry.ts";

const header = `import * as Effect from ${JSON.stringify(import.meta.resolve("effect/Effect"))};
import * as fs from "node:fs";`;
const descriptor = (id: string) => ({
  id,
  title: id,
  description: id,
  permission: "diagnostics:read",
  agent: true,
});
const ping = `commands: [{ ...${JSON.stringify(descriptor("ping"))}, run: () => Effect.succeed("pong") }]`;
const healthy = `${header}\nexport default {apiVersion: 1, id: "healthy", name: "Healthy", version: "1.0.0", activate: () => Effect.succeed({${ping}})};`;
const envelope = (id: string, commandId: string) => ({
  pluginId: id,
  commandId,
  input: {},
  permission: "diagnostics:read" as const,
});

function fixture<A, E, R>(
  source: (temp: string) => string,
  use: (temp: string) => Effect.Effect<A, E, R | PluginRegistry.PluginRegistry>,
  limit?: number,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-isolated-plugin-" });
      yield* fs.writeFileString(`${temp}/plugin.mjs`, source(temp));
      yield* fs.writeFileString(`${temp}/healthy.mjs`, healthy);
      yield* fs.writeFileString(
        `${temp}/plugins.json`,
        JSON.stringify({
          plugins: [
            {
              id: "test",
              path: `${temp}/plugin.mjs`,
              enabled: true,
              ...(limit === undefined ? {} : { restartLimit: limit }),
            },
            { id: "healthy", path: `${temp}/healthy.mjs`, enabled: true },
          ],
        }),
      );
      return yield* use(temp).pipe(
        Effect.provide(
          PluginRegistry.layer.pipe(
            Layer.provide(PluginModuleLoader.layer),
            Layer.provide(ServerSecretStore.layer),
            Layer.provide(ServerConfig.layerTest(temp, temp)),
          ),
        ),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer));
}

it.live("contains a module-level process exit and stops after the default five attempts", () =>
  fixture(
    (temp) =>
      `${header}\nfs.appendFileSync(${JSON.stringify(`${temp}/attempts`)}, "attempt\\n"); process.exit(23);`,
    (temp) =>
      Effect.gen(function* () {
        const host = yield* PluginRegistry.PluginRegistry;
        const fs = yield* FileSystem.FileSystem;
        const catalog = yield* host.list(AuthStandardClientScopes);
        expect(catalog.plugins[0]).toMatchObject({
          status: "stopped",
          restartAttempts: 5,
          restartLimit: 5,
        });
        expect((yield* fs.readFileString(`${temp}/attempts`)).trim().split("\n")).toHaveLength(5);
        expect(yield* host.execute(envelope("healthy", "ping"), AuthStandardClientScopes)).toBe(
          "pong",
        );
      }),
  ),
);

it.live("uses the configured attempt limit for activation crashes", () =>
  fixture(
    (
      temp,
    ) => `${header}\nexport default {apiVersion: 1, id: "test", name: "Test", version: "1.0.0", activate: () => Effect.sync(() => {
    fs.appendFileSync(${JSON.stringify(`${temp}/attempts`)}, "attempt\\n"); process.exit(24);
  })};`,
    (temp) =>
      Effect.gen(function* () {
        const host = yield* PluginRegistry.PluginRegistry;
        const fs = yield* FileSystem.FileSystem;
        expect((yield* host.list(AuthStandardClientScopes)).plugins[0]).toMatchObject({
          status: "stopped",
          restartAttempts: 2,
        });
        expect((yield* fs.readFileString(`${temp}/attempts`)).trim().split("\n")).toHaveLength(2);
        expect(yield* host.execute(envelope("healthy", "ping"), AuthStandardClientScopes)).toBe(
          "pong",
        );
      }),
    2,
  ),
);

it.live(
  "supervises runtime crashes, fails routing closed, and recovers only after an explicit retry",
  () =>
    fixture(
      (temp) => `${header}
const marker = ${JSON.stringify(`${temp}/attempts`)};
fs.appendFileSync(marker, "attempt\\n");
export default { apiVersion: 1, id: "test", name: "Test", version: "1.0.0", activate: () => Effect.sync(() => {
  if (fs.readFileSync(marker, "utf8").trim().split("\\n").length > 1 && !fs.existsSync(${JSON.stringify(`${temp}/fixed`)})) throw new Error("uncaught activation failure");
  return { prepareLaunch: (launch) => Effect.succeed({...launch, environment: {...launch.environment, ROUTED: "yes"}}),
    commands: [{...${JSON.stringify(descriptor("crash"))}, run: () => Effect.sync(() => { process.nextTick(() => { throw new Error("uncaught runtime failure"); }); return null; })}] };
}) };`,
      (temp) =>
        Effect.gen(function* () {
          const host = yield* PluginRegistry.PluginRegistry;
          const fs = yield* FileSystem.FileSystem;
          const configuration = yield* host.configuration;
          yield* host.reconcile({
            plugins: configuration.plugins.map((entry) =>
              entry.id === "test" ? { ...entry, restartLimit: 1 } : entry,
            ),
          });
          expect((yield* fs.readFileString(`${temp}/attempts`)).trim().split("\n")).toHaveLength(1);
          yield* host
            .execute(envelope("test", "crash"), AuthStandardClientScopes)
            .pipe(Effect.ignore);
          const stopped = yield* host.changes.pipe(
            Stream.mapEffect(() => host.list(AuthStandardClientScopes)),
            Stream.filter((catalog) => catalog.plugins[0]?.status === "stopped"),
            Stream.take(1),
            Stream.runCollect,
          );
          expect(stopped[0]?.plugins[0]).toMatchObject({ status: "stopped", restartAttempts: 1 });
          const launch = {
            provider: "codex",
            purpose: "agent" as const,
            args: [],
            environment: {},
          };
          expect((yield* host.prepareLaunch(launch).pipe(Effect.flip)).operation).toBe(
            "launch-plugin-unavailable",
          );
          expect(yield* host.execute(envelope("healthy", "ping"), AuthStandardClientScopes)).toBe(
            "pong",
          );
          yield* fs.writeFileString(`${temp}/fixed`, "fixed");
          expect(yield* host.restart("test")).toBe(true);
          expect((yield* host.prepareLaunch(launch)).environment.ROUTED).toBe("yes");
        }),
      2,
    ),
);

it.live(
  "streams bodies across IPC, propagates cancellation, and preserves environment deletions",
  () =>
    fixture(
      () => `${header}
let cancelled = false;
export default {apiVersion: 1, id: "test", name: "Test", version: "1.0.0", activate: () => Effect.succeed({
  prepareLaunch: launch => Effect.succeed({...launch, environment: {...launch.environment, DELETE_ME: undefined}}),
  commands: [{...${JSON.stringify(descriptor("cancelled"))}, run: () => Effect.succeed(cancelled)}],
  handleHttp: request => Effect.succeed(request.method === "POST" ? new Response(request.body, {headers: {"x-plugin": "echo"}}) : new Response(new ReadableStream({
    start(controller) {controller.enqueue(new TextEncoder().encode("data: first\\n\\n"));},
    cancel() {cancelled = true;}
  })))
})};`,
      () =>
        Effect.gen(function* () {
          const host = yield* PluginRegistry.PluginRegistry;
          const text = "x".repeat(200_000);
          const response = yield* host.handleHttp(
            "test",
            new Request("http://test/api/plugins/test/echo", { method: "POST", body: text }),
          );
          expect(response.headers.get("x-plugin")).toBe("echo");
          expect(yield* Effect.promise(() => response.text())).toBe(text);
          const stream = yield* host.handleHttp(
            "test",
            new Request("http://test/api/plugins/test/events"),
          );
          const reader = stream.body!.getReader();
          const first = yield* Effect.promise(() => reader.read());
          expect(new TextDecoder().decode(first.value)).toBe("data: first\n\n");
          yield* Effect.promise(() => reader.cancel());
          expect(yield* host.execute(envelope("test", "cancelled"), AuthStandardClientScopes)).toBe(
            true,
          );
          const launch = yield* host.prepareLaunch({
            provider: "codex",
            purpose: "agent",
            args: [],
            environment: { KEEP: "yes", DELETE_ME: "gone" },
          });
          expect(launch.environment).toEqual({ KEEP: "yes", DELETE_ME: undefined });
          expect(Object.hasOwn(launch.environment, "DELETE_ME")).toBe(true);
        }),
    ),
);

it.effect(
  "kills an event-loop stall at the handler deadline while other plugins remain usable",
  () =>
    fixture(
      () => `${header}
export default {apiVersion: 1, id: "test", name: "Test", version: "1.0.0", activate: () => Effect.succeed({
  commands: [{...${JSON.stringify(descriptor("block"))}, run: () => Effect.sync(() => { for (;;) {} })}]
})};`,
      () =>
        Effect.gen(function* () {
          const host = yield* PluginRegistry.PluginRegistry;
          const blocked = yield* host
            .execute(envelope("test", "block"), AuthStandardClientScopes)
            .pipe(Effect.result, Effect.forkChild);
          yield* TestClock.adjust("30 seconds");
          expect((yield* Fiber.join(blocked))._tag).toBe("Failure");
          const stopped = yield* host.changes.pipe(
            Stream.mapEffect(() => host.list(AuthStandardClientScopes)),
            Stream.filter((catalog) => catalog.plugins[0]?.status === "stopped"),
            Stream.take(1),
            Stream.runCollect,
          );
          expect(stopped[0]?.plugins[0]?.restartAttempts).toBe(1);
          expect(yield* host.execute(envelope("healthy", "ping"), AuthStandardClientScopes)).toBe(
            "pong",
          );
        }),
      1,
    ),
);

it.live("loads plugins when the server inherits Node watch mode IPC reporting", () =>
  Effect.flatMap(HostProcess.Environment, (environment) =>
    fixture(
      () => healthy.replace('id: "healthy"', 'id: "test"'),
      () =>
        Effect.gen(function* () {
          const host = yield* PluginRegistry.PluginRegistry;
          expect(
            (yield* host.list(AuthStandardClientScopes)).plugins.map((plugin) => plugin.status),
          ).toEqual(["active", "active"]);
          expect(yield* host.execute(envelope("test", "ping"), AuthStandardClientScopes)).toBe(
            "pong",
          );
        }),
    ).pipe(
      Effect.provideService(HostProcess.Environment, {
        ...environment,
        WATCH_REPORT_DEPENDENCIES: "1",
      }),
    ),
  ),
);
