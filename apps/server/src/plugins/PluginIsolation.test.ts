// @effect-diagnostics nodeBuiltinImport:off -- A local socket observes subprocess lifetime without polling.
import * as NodeNet from "node:net";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AuthStandardClientScopes } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import type { T3Plugin } from "@t3tools/contracts";
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
  ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
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
  return { mcpServers: () => Effect.succeed({"test-database": {transport: "stdio", command: "db-server", args: [], environment: {TOKEN: "private-db-token"}}}),
    prepareLaunch: (launch) => Effect.succeed({...launch, environment: {...launch.environment, ROUTED: "yes"}}),
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
          expect(
            (yield* host.mcpServers({ provider: "codex", instanceId: "codex" }).pipe(Effect.flip))
              .operation,
          ).toBe("mcp-plugin-unavailable");
          expect((yield* host.prepareLaunch(launch).pipe(Effect.flip)).operation).toBe(
            "launch-plugin-unavailable",
          );
          expect(yield* host.execute(envelope("healthy", "ping"), AuthStandardClientScopes)).toBe(
            "pong",
          );
          yield* fs.writeFileString(`${temp}/fixed`, "fixed");
          expect(yield* host.restart("test")).toBe(true);
          expect((yield* host.prepareLaunch(launch)).environment.ROUTED).toBe("yes");
          expect(yield* host.mcpServers({ provider: "codex", instanceId: "codex" })).toEqual({
            "test-database": {
              transport: "stdio",
              command: "db-server",
              args: [],
              environment: { TOKEN: "private-db-token" },
            },
          });
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

it.effect.each(["command", "mcp", "lifecycle"])(
  "kills an event-loop stall at the handler deadline while other plugins remain usable (%s)",
  (operation) =>
    fixture(
      () => `${header}
export default {apiVersion: 1, id: "test", name: "Test", version: "1.0.0", activate: () => Effect.succeed({
  mcpServers: () => Effect.sync(() => { for (;;) {} }),
  onLifecycle: () => Effect.sync(() => { for (;;) {} }),
  commands: [{...${JSON.stringify(descriptor("block"))}, run: () => Effect.sync(() => { for (;;) {} })}]
})};`,
      () =>
        Effect.gen(function* () {
          const host = yield* PluginRegistry.PluginRegistry;
          expect((yield* host.list(AuthStandardClientScopes)).plugins[0]?.status).toBe("active");
          const blocked = yield* Effect.gen(function* () {
            if (operation === "command")
              yield* host.execute(envelope("test", "block"), AuthStandardClientScopes);
            else if (operation === "mcp")
              yield* host.mcpServers({ provider: "codex", instanceId: "codex" });
            else
              yield* host.lifecycle({
                type: "worktree.removing",
                repositoryDirectory: "/project",
                worktreePath: "/project-worktree",
              });
          }).pipe(Effect.result, Effect.forkChild);
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

it.effect("keeps a worker alive when a superseded view request is cancelled", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-cancelled-view-" });
      yield* fs.writeFileString(
        `${temp}/plugin.mjs`,
        `${header}
import * as Deferred from ${JSON.stringify(import.meta.resolve("effect/Deferred"))};
const release = Deferred.makeUnsafe();
export default {apiVersion: 1, id: "test", name: "Test", version: "1.0.0", activate: (host) => Effect.succeed({
  commands: [{...${JSON.stringify(descriptor("release"))}, run: () => Deferred.succeed(release, undefined).pipe(Effect.as("released"))}],
  views: [{id: "view", location: "settings", title: "View", permission: "diagnostics:read", read: () => Effect.gen(function* () {
    yield* host.secrets.set("started", "true");
    yield* Deferred.await(release);
    return {title: "View", blocks: []};
  })}]
})};`,
      );
      const started = yield* Deferred.make<void>();
      const loader = yield* PluginModuleLoader.PluginModuleLoader;
      const loaded = yield* loader.load(`${temp}/plugin.mjs`, { restartLimit: 1 });
      const plugin = loaded.default as T3Plugin;
      const contributions = yield* plugin.activate({
        id: "test",
        dataDirectory: temp,
        httpBasePath: "/api/plugins/test",
        httpBaseUrl: Effect.succeed("http://localhost/api/plugins/test"),
        secrets: {
          get: () => Effect.succeed(null),
          set: () => Deferred.succeed(started, undefined).pipe(Effect.asVoid),
          remove: () => Effect.void,
        },
      });
      const view = contributions.views![0]!;
      const reading = yield* view.read().pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Fiber.interrupt(reading);
      expect(yield* contributions.commands![0]!.run({})).toBe("released");
      expect(yield* view.read()).toEqual({ title: "View", blocks: [] });
    }).pipe(Effect.provide(PluginModuleLoader.layer)),
  ).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.live("returns a deliberate lifecycle failure across IPC and keeps other plugins usable", () =>
  fixture(
    () => `${header}
export default {apiVersion:1,id:"test",name:"Test",version:"1.0.0",activate:()=>Effect.succeed({
  onLifecycle:event=>Effect.succeed(event.type==="worktree.removing"?{error:"Stop containers: exit 7. Retry removal after fixing the script."}:null)
})};`,
    () =>
      Effect.gen(function* () {
        const host = yield* PluginRegistry.PluginRegistry;
        const event = {
          type: "worktree.removing" as const,
          repositoryDirectory: "/project",
          worktreePath: "/project-worktree",
        };
        const error = yield* Effect.flip(host.lifecycle(event));
        expect(error).toMatchObject({
          _tag: "PluginLifecycleBlocked",
          pluginId: "test",
          message: "Stop containers: exit 7. Retry removal after fixing the script.",
        });
        yield* host.lifecycle({ ...event, type: "worktree.created" });
        expect(yield* host.execute(envelope("healthy", "ping"), AuthStandardClientScopes)).toBe(
          "pong",
        );
      }),
  ),
);

it.live(
  "supervises plugin subprocess output and stops an owned process when its worker is disabled",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const connected = Promise.withResolvers<void>(),
          disconnected = Promise.withResolvers<void>();
        const server = yield* Effect.acquireRelease(
          Effect.sync(() =>
            NodeNet.createServer((socket) => {
              connected.resolve();
              socket.on("close", () => disconnected.resolve());
            }),
          ),
          (server) =>
            Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
        );
        yield* Effect.promise(
          () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
        );
        const address = server.address();
        if (!address || typeof address === "string") throw Error("Expected a TCP address");
        const script = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(`require('node:net').connect(${address.port},'127.0.0.1');setInterval(()=>{},1000);`)}]);setInterval(()=>{},1000);`;
        yield* fixture(
          (temp) => `${header}
export default {apiVersion:1,id:"test",name:"Test",version:"1.0.0",activate:context=>Effect.succeed({commands:[
 {...${JSON.stringify(descriptor("run"))},run:()=>context.runProcess({command:${JSON.stringify(process.execPath)},args:["-e",${JSON.stringify(script)}],cwd:${JSON.stringify(temp)},environment:{},timeoutMs:60000})},
 {...${JSON.stringify(descriptor("output"))},run:()=>context.runProcess({command:${JSON.stringify(process.execPath)},args:["-e","process.stdout.write('x'.repeat(12000));process.stderr.write(process.env.PLUGIN_VALUE)"],cwd:${JSON.stringify(temp)},environment:{PLUGIN_VALUE:"owned"},timeoutMs:10000})}
]})};`,
          () =>
            Effect.gen(function* () {
              const host = yield* PluginRegistry.PluginRegistry;
              const output = yield* host.execute(
                envelope("test", "output"),
                AuthStandardClientScopes,
              );
              expect(output).toMatchObject({
                code: 0,
                timedOut: false,
                stdoutTruncated: true,
                stderr: "owned",
              });
              const pending = yield* host
                .execute(envelope("test", "run"), AuthStandardClientScopes)
                .pipe(Effect.result, Effect.forkChild);
              yield* Effect.promise(() => connected.promise);
              const configuration = yield* host.configuration;
              yield* host.reconcile({
                plugins: configuration.plugins.map((plugin) =>
                  plugin.id === "test" ? { ...plugin, enabled: false } : plugin,
                ),
              });
              yield* Effect.promise(() => disconnected.promise);
              expect((yield* Fiber.join(pending))._tag).toBe("Failure");
            }),
        );
      }),
    ),
);

it.effect(
  "gives a worker thread access with failures it can show, inside its own data only",
  () => {
    const summary = {
      environmentId: "environment-home",
      environmentLabel: "home",
      threadId: "known",
      title: "Known thread",
      projectId: "project",
      repository: "github.com/example/repo",
      directory: "/repo",
      branch: "main",
      running: false,
      subagents: 0,
      archived: false,
    };
    const exported: Array<string> = [];
    const shown = `Effect.catch((error) => Effect.succeed({ shown: error.cause.message }))`;
    return fixture(
      () => `${header}
export default {apiVersion: 1, id: "test", name: "Test", version: "1.0.0", activate: (host) => Effect.succeed({
  commands: [
    {...${JSON.stringify(descriptor("describe"))}, run: (input) => host.threads.describe(input.threadId).pipe(${shown})},
    {...${JSON.stringify(descriptor("export"))}, run: (input) => host.threads.export({ threadId: "known", file: input.file }).pipe(${shown})},
    {...${JSON.stringify(descriptor("peer"))}, run: (input) => host.plugins.run({ pluginId: "healthy", commandId: input.commandId, input: {} }).pipe(${shown})},
  ],
})};`,
      (temp) =>
        Effect.gen(function* () {
          const host = yield* PluginRegistry.PluginRegistry;
          const run = (commandId: string, input: Record<string, string>) =>
            host.execute({ ...envelope("test", commandId), input }, AuthStandardClientScopes);
          expect(yield* run("describe", { threadId: "known" })).toEqual({
            shown: "Thread access is not ready on this environment.",
          });
          yield* host.setThreads({
            describe: (threadId) =>
              threadId === "known"
                ? Effect.succeed(summary)
                : Effect.fail({ message: "This thread does not exist on this environment." }),
            export: (input) =>
              Effect.sync(() => {
                exported.push(input.file);
                return {
                  snapshot: null,
                  snapshotRef: null,
                  head: null,
                  messages: 0,
                  omittedMessages: 0,
                };
              }),
            projects: () => Effect.succeed([]),
            import: () => Effect.fail({ message: "unused" }),
            archive: () => Effect.void,
          });
          expect(yield* run("describe", { threadId: "known" })).toEqual(summary);
          expect(yield* run("describe", { threadId: "missing" })).toEqual({
            shown: "This thread does not exist on this environment.",
          });
          const inside = `${temp}/plugins/test/conversation.json`;
          expect(yield* run("export", { file: inside })).toMatchObject({ messages: 0 });
          expect(yield* run("export", { file: `${temp}/plugins/other/conversation.json` })).toEqual(
            {
              shown: "The file must be inside the plugin's data directory.",
            },
          );
          expect(exported).toEqual([inside]);
          // Another plugin's command crosses two workers and back.
          expect(yield* run("peer", { commandId: "ping" })).toBe("pong");
          expect(yield* run("peer", { commandId: "missing" })).toEqual({
            shown: "unknown-contribution",
          });
        }),
    );
  },
);
