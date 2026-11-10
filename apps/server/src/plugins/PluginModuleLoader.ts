import * as ProcessRunner from "../processRunner.ts";
// @effect-diagnostics nodeBuiltinImport:off -- Node IPC is the plugin process boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodeTimersPromises from "node:timers/promises";
import {
  Environment as HostProcessEnvironment,
  ExecutablePath as HostProcessExecutablePath,
  IsExecutable as HostProcessIsExecutable,
} from "@t3tools/shared/HostProcess";
import {
  PluginActivity,
  PluginManifest,
  PluginMcpServers,
  PluginLifecycleTimeout,
  PluginLifecycleResult,
  PluginProcessInput,
  PluginPeerCall,
  type PluginLifecycleEvent,
  PluginHttpResponseTimeout,
  PluginView,
  PluginCommandDescriptor,
  PluginViewDescriptor,
  PluginError,
  PluginOperationError,
  PluginRuntimeHealth,
  type PluginContext,
  type PluginContributions,
  type PluginLaunch,
  type T3Plugin,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  decodePluginMessage,
  decodePluginLaunch,
  encodePluginLaunch,
  MAX_PLUGIN_MESSAGE_BYTES,
  type PluginMessage,
} from "./pluginProtocol.ts";

interface LoadedPlugin {
  readonly default: unknown;
  readonly health?: Stream.Stream<typeof PluginRuntimeHealth.Type>;
  readonly setRestartLimit?: (limit: number) => Effect.Effect<void>;
}
export class PluginModuleLoader extends Context.Service<
  PluginModuleLoader,
  {
    readonly load: (
      path: string,
      options?: { readonly restartLimit: number },
    ) => Effect.Effect<LoadedPlugin, PluginOperationError, Scope.Scope>;
  }
>()("t3/plugins/PluginModuleLoader") {}

const Activated = Schema.Struct({
  commands: Schema.Array(PluginCommandDescriptor),
  views: Schema.Array(PluginViewDescriptor),
  lifecycle: Schema.Boolean,
  lifecycleTimeoutMs: PluginLifecycleTimeout,
  mcp: Schema.Boolean,
  launch: Schema.Boolean,
  http: Schema.Boolean,
  httpResponseTimeoutMs: PluginHttpResponseTimeout,
});
const decodeProcessInput = Schema.decodeUnknownSync(PluginProcessInput);
const decodeThreadFile = Schema.decodeUnknownSync(
  Schema.Struct({ threadId: Schema.String, file: Schema.String }),
);
const decodeThreadImport = Schema.decodeUnknownSync(
  Schema.Struct({ file: Schema.String, projectId: Schema.String, branch: Schema.String }),
);
const decodeThreadArchive = Schema.decodeUnknownSync(
  Schema.Struct({
    threadId: Schema.String,
    movedTo: Schema.Struct({ environmentLabel: Schema.String, threadId: Schema.String }),
  }),
);
const decodePeerCall = Schema.decodeUnknownSync(PluginPeerCall);
/** Marks a host failure whose text the plugin may show its user. */
const shownToUser = new WeakSet<Error>();
const decodeActivated = Schema.decodeUnknownSync(Activated);
const decodeActivity = Schema.decodeUnknownSync(PluginActivity);
const decodeManifest = Schema.decodeUnknownSync(PluginManifest);
const decodeView = Schema.decodeUnknownSync(PluginView);
const metadataIdentity = Schema.encodeSync(Schema.fromJsonString(Activated));
const manifestIdentity = Schema.encodeSync(Schema.fromJsonString(PluginManifest));
const isOperationError = Schema.is(PluginOperationError);
const isPluginError = Schema.is(PluginError);
const pluginFailure = (operation: string) => (cause: unknown) =>
  new PluginError({ operation, cause });

const make = Effect.gen(function* () {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const executable = yield* HostProcessExecutablePath;
  const environment = yield* HostProcessEnvironment;
  const standalone = yield* HostProcessIsExecutable;
  return PluginModuleLoader.of({
    load: Effect.fn("PluginModuleLoader.load")((path, options) =>
      Effect.gen(function* () {
        let limit = options?.restartLimit ?? 5;
        const runtimeContext = yield* Effect.context<never>();
        const exits = yield* Queue.unbounded<number>();
        const health = yield* SubscriptionRef.make({
          status: "active" as "active" | "restarting" | "stopped",
          attempts: 0,
          limit,
        });
        const revision = yield* SubscriptionRef.make(0);
        let hostContext: PluginContext | undefined;
        let closed = false;
        let generation = 0;
        let expectedMetadata: string | undefined;
        let expectedManifest: string | undefined;
        let current: Session | undefined;
        let ready = Promise.withResolvers<Session>();
        void ready.promise.catch(() => {});
        let failures = 0;
        let lastStartupFailure: unknown;
        let startedAt = yield* Clock.currentTimeMillis;

        let lifecycleTimeoutMs = 30_000;
        const openSession = () => {
          const ownGeneration = ++generation;
          const workerUrl = import.meta.url.endsWith(".ts")
            ? new URL("./plugin-worker.ts", import.meta.url)
            : new URL("./plugins/plugin-worker.mjs", import.meta.url);
          const workerEnvironment: NodeJS.ProcessEnv = {
            ...environment,
            ELECTRON_RUN_AS_NODE: "1",
            NODE_OPTIONS: "--max-old-space-size=256",
          };
          // Node watch mode reports imports over IPC; workers own that channel exclusively.
          delete workerEnvironment.WATCH_REPORT_DEPENDENCIES;
          const child = standalone
            ? NodeChildProcess.spawn(executable, ["__plugin-worker"], {
                stdio: ["ignore", "ignore", "ignore", "ipc"],
                env: workerEnvironment,
              })
            : NodeChildProcess.fork(NodeURL.fileURLToPath(workerUrl), [], {
                execPath: executable,
                execArgv: [],
                stdio: ["ignore", "ignore", "ignore", "ipc"],
                env: workerEnvironment,
              });
          let nextId = 0;
          let expected = false;
          let exited = false;
          const pending = new Map<
            number,
            {
              resolve: (value: Schema.Json) => void;
              reject: (error: Error) => void;
              cleanup: () => void;
            }
          >();
          const jobs = new Map<number, AbortController>();
          const requests = new Map<
            number,
            { reader: ReadableStreamDefaultReader<Uint8Array>; remainder?: Uint8Array | undefined }
          >();
          const send = (message: PluginMessage) => {
            const text = JSON.stringify(message);
            if (!child.connected || Buffer.byteLength(text) > MAX_PLUGIN_MESSAGE_BYTES)
              throw new Error("Plugin protocol unavailable");
            child.send(text, (error) => {
              if (error) child.kill();
            });
          };
          const invoke = (
            method: string,
            payload: Schema.Json,
            signal?: AbortSignal,
            onId?: (id: number) => void,
          ) =>
            new Promise<Schema.Json>((resolve, reject) => {
              if (exited || signal?.aborted || pending.size >= 256) {
                reject(new Error("Plugin process unavailable"));
                return;
              }
              const id = ++nextId;
              const supervised = ["command", "view", "launch", "mcp-servers", "lifecycle"].includes(
                method,
              );
              // Client refreshes can be superseded while the worker is still answering.
              // Keep their watchdog until the reply arrives, even after caller cancellation.
              const watchdog = supervised ? new AbortController() : undefined;
              if (watchdog)
                void Effect.runPromiseWith(runtimeContext)(
                  Effect.sleep(method === "lifecycle" ? lifecycleTimeoutMs : 30_000),
                  {
                    signal: watchdog.signal,
                  },
                ).then(
                  () => {
                    pending.delete(id);
                    cleanup();
                    child.kill("SIGKILL");
                    reject(new Error("Plugin handler timed out"));
                  },
                  () => {},
                );
              const abort = () => {
                signal?.removeEventListener("abort", abort);
                if (!supervised) {
                  pending.delete(id);
                  cleanup();
                  if (["load", "activate"].includes(method)) child.kill("SIGKILL");
                }
                if (method === "lifecycle" && child.connected)
                  send({
                    kind: "call",
                    id: ++nextId,
                    method: "http-cancel",
                    payload: { id },
                    ok: true,
                  });
                reject(new Error("Plugin call cancelled"));
              };
              const cleanup = () => {
                signal?.removeEventListener("abort", abort);
                watchdog?.abort();
              };
              pending.set(id, { resolve, reject, cleanup });
              signal?.addEventListener("abort", abort, { once: true });
              try {
                onId?.(id);
                send({ kind: "call", id, method, payload, ok: true });
              } catch {
                pending.delete(id);
                cleanup();
                reject(new Error("Plugin send failed"));
              }
            });
          const hostCall = async (
            method: string,
            value: Schema.Json,
            requestId: number,
          ): Promise<Schema.Json> => {
            if (!hostContext || closed || expected || exited || ownGeneration !== generation)
              throw new Error("Plugin not activated");
            const payload = value as Record<string, Schema.Json>;
            // Native IPC callbacks are a framework boundary, reusing the captured
            // application context rather than making per-plugin Effect runtimes.
            const run = Effect.runPromiseWith(runtimeContext);
            if (method === "process-cancel") {
              jobs.get(Number(payload.id))?.abort();
              return null;
            }
            if (method === "process-run") {
              if (jobs.size >= 4) throw new Error("Plugin process limit reached");
              const input = decodeProcessInput(value);
              const controller = new AbortController();
              jobs.set(requestId, controller);
              try {
                const result = await run(
                  processRunner.run({
                    command: input.command,
                    args: input.args,
                    cwd: input.cwd,
                    env: input.environment,
                    timeout: input.timeoutMs,
                    maxOutputBytes: 8192,
                    outputMode: "truncate",
                    timeoutBehavior: "timedOutResult",
                  }),
                  { signal: controller.signal },
                );
                return {
                  code: result.code,
                  timedOut: result.timedOut,
                  stdout: result.stdout,
                  stderr: result.stderr,
                  stdoutTruncated: result.stdoutTruncated,
                  stderrTruncated: result.stderrTruncated,
                };
              } finally {
                jobs.delete(requestId);
              }
            }
            if (method === "secret-get")
              return await run(hostContext.secrets.get(String(payload.key)));
            if (method === "secret-set") {
              await run(hostContext.secrets.set(String(payload.key), String(payload.value)));
              return null;
            }
            if (method === "secret-remove") {
              await run(hostContext.secrets.remove(String(payload.key)));
              return null;
            }
            if (method === "activity" && hostContext.activity)
              return decodeActivity(await run(hostContext.activity));
            if (method === "http-url") return await run(hostContext.httpBaseUrl);
            if (method === "plugin-list" || method === "plugin-run") {
              const plugins = hostContext.plugins;
              if (!plugins) throw new Error("Plugin access unavailable");
              const call: Effect.Effect<Schema.Json, PluginError> =
                method === "plugin-list"
                  ? plugins.list().pipe(Effect.map((peers) => [...peers]))
                  : plugins.run(decodePeerCall(value));
              const outcome = await run(
                call.pipe(
                  Effect.match({
                    onSuccess: (result) => ({ result }),
                    onFailure: (error) => ({
                      failure: error.cause instanceof Error ? error.cause.message : null,
                    }),
                  }),
                ),
              );
              if ("result" in outcome) return outcome.result;
              const failure = new Error(outcome.failure ?? "Plugin call failed");
              if (outcome.failure !== null) shownToUser.add(failure);
              throw failure;
            }
            if (method.startsWith("thread-")) {
              const threads = hostContext.threads;
              if (!threads) throw new Error("Thread access unavailable");
              const call: Effect.Effect<Schema.Json, PluginError> =
                method === "thread-describe"
                  ? threads.describe(String(payload.threadId))
                  : method === "thread-export"
                    ? threads.export(decodeThreadFile(value))
                    : method === "thread-projects"
                      ? threads.projects(String(payload.repository))
                      : method === "thread-import"
                        ? threads.import(decodeThreadImport(value))
                        : threads.archive(decodeThreadArchive(value)).pipe(Effect.as(null));
              const outcome = await run(
                call.pipe(
                  Effect.match({
                    onSuccess: (result) => ({ result }),
                    onFailure: (error) => ({
                      failure: error.cause instanceof Error ? error.cause.message : null,
                    }),
                  }),
                ),
              );
              if ("result" in outcome) return outcome.result;
              const failure = new Error(outcome.failure ?? "Thread call failed");
              if (outcome.failure !== null) shownToUser.add(failure);
              throw failure;
            }
            if (method === "request-chunk") {
              const request = requests.get(Number(payload.id));
              if (!request) return null;
              const chunk = request.remainder
                ? { done: false, value: request.remainder }
                : await request.reader.read();
              if (chunk.done || !chunk.value) {
                requests.delete(Number(payload.id));
                return null;
              }
              request.remainder =
                chunk.value.length > 65536 ? chunk.value.subarray(65536) : undefined;
              return Buffer.from(chunk.value.subarray(0, 65536)).toString("base64");
            }
            throw new Error("Unknown host capability");
          };
          const ended = () => {
            if (exited) return;
            exited = true;
            for (const job of jobs.values()) job.abort();
            jobs.clear();
            for (const reply of pending.values()) {
              reply.cleanup();
              reply.reject(new Error("Plugin process exited"));
            }
            pending.clear();
            for (const request of requests.values()) void request.reader.cancel().catch(() => {});
            requests.clear();
            if (!expected && !closed && ownGeneration === generation) {
              current = undefined;
              ready = Promise.withResolvers<Session>();
              void ready.promise.catch(() => {});
              Queue.offerUnsafe(exits, ownGeneration);
            }
          };
          child.on("exit", ended);
          child.on("error", ended);
          let hostCalls = 0;
          child.on("message", (raw) => {
            if (exited) return;
            let message: PluginMessage;
            try {
              if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_PLUGIN_MESSAGE_BYTES)
                throw new Error();
              message = decodePluginMessage(raw);
            } catch {
              child.kill();
              return;
            }
            if (message.kind === "reply") {
              const reply = pending.get(message.id);
              pending.delete(message.id);
              reply?.cleanup();
              if (message.ok) reply?.resolve(message.payload);
              else reply?.reject(new Error("Plugin handler failed"));
            } else if (message.kind === "host-call") {
              if (expected || closed) return;
              if (++hostCalls > 64) {
                child.kill("SIGKILL");
                return;
              }
              void hostCall(message.method, message.payload, message.id)
                .then(
                  (payload) =>
                    send({ kind: "host-reply", id: message.id, method: "", payload, ok: true }),
                  (error) =>
                    send({
                      kind: "host-reply",
                      id: message.id,
                      method: "",
                      payload:
                        error instanceof Error && shownToUser.has(error) ? error.message : null,
                      ok: false,
                    }),
                )
                .catch(() => {})
                .finally(() => {
                  hostCalls--;
                });
            } else if (message.kind === "changed") {
              if (expected || closed) return;
              Effect.runForkWith(runtimeContext)(SubscriptionRef.update(revision, (n) => n + 1));
            }
          });
          const session = {
            invoke,
            requests,
            terminate: () => {
              child.kill("SIGKILL");
            },
            close: async () => {
              expected = true;
              for (const job of jobs.values()) job.abort();
              if (exited) return;
              await invoke("shutdown", null, AbortSignal.timeout(1000)).catch(() => {});
              if (exited) return;
              child.kill("SIGTERM");
              await Promise.race([
                new Promise<void>((resolve) => {
                  if (exited) resolve();
                  else child.once("exit", () => resolve());
                }),
                NodeTimersPromises.setTimeout(1000, undefined, { ref: false }).then(() => {
                  child.kill("SIGKILL");
                }),
              ]);
            },
          };
          return session;
        };
        type Session = ReturnType<typeof openSession>;
        const start = Effect.gen(function* () {
          const session = yield* Effect.sync(openSession);
          current = session;
          const manifest = yield* Effect.tryPromise({
            try: async (signal) => {
              const manifest = decodeManifest(await session.invoke("load", { path }, signal));
              const identity = manifestIdentity(manifest);
              if (expectedManifest !== undefined && identity !== expectedManifest)
                throw new Error("Plugin manifest changed during restart");
              expectedManifest = identity;
              return manifest;
            },
            catch: (cause) =>
              new PluginOperationError({ pluginId: "worker", operation: "load", cause }),
          }).pipe(
            Effect.timeout("15 seconds"),
            Effect.onError(() => Effect.promise(session.close)),
          );
          startedAt = yield* Clock.currentTimeMillis;
          return { session, manifest };
        });
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            closed = true;
            ready.reject(new Error("Plugin stopped"));
            if (current) yield* Effect.promise(current.close);
          }),
        );
        let initial: { session: Session; manifest: PluginManifest } | undefined;
        while (!initial && failures < limit) {
          const result = yield* start.pipe(Effect.result);
          if (result._tag === "Success") initial = result.success;
          else {
            lastStartupFailure = result.failure;
            failures++;
          }
        }
        if (!initial)
          return yield* new PluginOperationError({
            pluginId: "worker",
            operation: "crash-limit",
            cause: lastStartupFailure,
          });
        const activateSession = (session: Session) =>
          session
            .invoke(
              "activate",
              {
                id: hostContext!.id,
                dataDirectory: hostContext!.dataDirectory,
                capabilities: [...(hostContext!.capabilities ?? [])],
                httpBasePath: hostContext!.httpBasePath,
              },
              AbortSignal.timeout(15_000),
            )
            .then(decodeActivated)
            .then((metadata) => {
              lifecycleTimeoutMs = metadata.lifecycleTimeoutMs;
              return metadata;
            });
        const supervise = Effect.gen(function* () {
          for (;;) {
            const exitedGeneration = yield* Queue.take(exits);
            if (exitedGeneration !== generation || !hostContext || closed) continue;
            if ((yield* Clock.currentTimeMillis) - startedAt >= 60_000) failures = 0;
            failures++;
            for (;;) {
              if (failures >= limit) {
                yield* SubscriptionRef.set(health, {
                  status: "stopped" as const,
                  attempts: failures,
                  limit,
                });
                ready.reject(new Error("Plugin crash limit reached"));
                return;
              }
              yield* SubscriptionRef.set(health, {
                status: "restarting" as const,
                attempts: failures,
                limit,
              });
              yield* Effect.sleep("1 second");
              if (failures >= limit) continue;
              const next = yield* start.pipe(
                Effect.flatMap(({ session }) =>
                  Effect.tryPromise({
                    try: () =>
                      activateSession(session).then((metadata) => {
                        if (expectedMetadata !== metadataIdentity(metadata))
                          throw new Error("Plugin contributions changed during restart");
                        return session;
                      }),
                    catch: (cause) =>
                      new PluginOperationError({ pluginId: "worker", operation: "restart", cause }),
                  }),
                ),
                Effect.result,
              );
              if (next._tag === "Success") {
                startedAt = yield* Clock.currentTimeMillis;
                ready.resolve(next.success);
                yield* SubscriptionRef.set(health, {
                  status: "active" as const,
                  attempts: failures,
                  limit,
                });
                break;
              }
              if (current) yield* Effect.promise(current.close);
              current = undefined;
              failures++;
            }
          }
        });
        const call = (method: string, payload: Schema.Json) =>
          Effect.tryPromise({
            try: async (signal) => (await ready.promise).invoke(method, payload, signal),
            catch: pluginFailure(method),
          });
        const proxy: T3Plugin = {
          ...initial.manifest,
          activate: Effect.fn("PluginModuleLoader.activate")((context) =>
            Effect.gen(function* () {
              hostContext = context;
              let session: Session | undefined = initial!.session;
              let metadata: typeof Activated.Type | undefined;
              while (!metadata && failures < limit) {
                const attempt = yield* Effect.gen(function* () {
                  if (!session) session = (yield* start).session;
                  return yield* Effect.tryPromise({
                    try: () => activateSession(session!),
                    catch: pluginFailure("activate"),
                  });
                }).pipe(Effect.result);
                if (attempt._tag === "Success") metadata = attempt.success;
                else {
                  failures++;
                  if (session) yield* Effect.promise(session.close);
                  session = undefined;
                }
              }
              if (!metadata)
                return yield* new PluginError({ operation: "crash-limit", cause: null });
              expectedMetadata = metadataIdentity(metadata);
              startedAt = yield* Clock.currentTimeMillis;
              ready.resolve(session!);
              yield* supervise.pipe(Effect.forkScoped);
              const contributions: PluginContributions = {
                changes: Stream.map(SubscriptionRef.changes(revision), () => undefined),
                commands: metadata.commands.map((command) => ({
                  ...command,
                  run: (input) => call("command", { id: command.id, input }),
                })),
                views: metadata.views.map((view) => ({
                  ...view,
                  read: () => call("view", { id: view.id }).pipe(Effect.map(decodeView)),
                })),
                ...(metadata.lifecycle
                  ? {
                      lifecycleTimeoutMs: metadata.lifecycleTimeoutMs,
                      onLifecycle: (event: PluginLifecycleEvent) =>
                        call("lifecycle", event).pipe(
                          Effect.map(Schema.decodeUnknownSync(PluginLifecycleResult)),
                        ),
                    }
                  : {}),
                ...(metadata.mcp
                  ? {
                      mcpServers: (context) =>
                        call("mcp-servers", context).pipe(
                          Effect.map(Schema.decodeUnknownSync(PluginMcpServers)),
                        ),
                    }
                  : {}),
                ...(metadata.launch
                  ? {
                      prepareLaunch: (launch: PluginLaunch) =>
                        call("launch", encodePluginLaunch(launch)).pipe(
                          Effect.map(decodePluginLaunch),
                        ),
                    }
                  : {}),
                ...(metadata.http
                  ? {
                      httpResponseTimeoutMs: metadata.httpResponseTimeoutMs,
                      handleHttp: (request: Request) =>
                        Effect.tryPromise({
                          try: async (signal) => {
                            const session = await ready.promise;
                            if (session.requests.size >= 128)
                              throw new Error("Too many plugin requests");
                            let requestId: number | undefined;
                            const cleanup = () => {
                              if (requestId !== undefined) {
                                const incoming = session.requests.get(requestId);
                                session.requests.delete(requestId);
                                void incoming?.reader.cancel().catch(() => {});
                              }
                              request.signal.removeEventListener("abort", abort);
                            };
                            const cancel = async () => {
                              cleanup();
                              if (requestId !== undefined)
                                await session
                                  .invoke(
                                    "http-cancel",
                                    { id: requestId },
                                    AbortSignal.timeout(1000),
                                  )
                                  .catch(() => {});
                            };
                            const abort = () => {
                              void cancel();
                            };
                            request.signal.addEventListener("abort", abort, { once: true });
                            let result: Schema.Json;
                            const timedOut = () => session.terminate();
                            signal.addEventListener("abort", timedOut, { once: true });
                            try {
                              result = await session.invoke(
                                "http",
                                {
                                  method: request.method,
                                  url: request.url,
                                  headers: Object.fromEntries(request.headers),
                                  body: request.body !== null,
                                },
                                AbortSignal.any([signal, request.signal]),
                                (id) => {
                                  requestId = id;
                                  if (request.body)
                                    session.requests.set(id, { reader: request.body.getReader() });
                                },
                              );
                            } catch (error) {
                              await cancel();
                              throw error;
                            } finally {
                              signal.removeEventListener("abort", timedOut);
                            }
                            const response = result as {
                              id: number;
                              status: number;
                              headers: Record<string, string>;
                              body: boolean;
                            };
                            const body = response.body
                              ? new ReadableStream<Uint8Array>({
                                  async pull(controller) {
                                    try {
                                      const chunk = await session.invoke(
                                        "response-chunk",
                                        { id: response.id },
                                        request.signal,
                                      );
                                      if (chunk === null) {
                                        cleanup();
                                        controller.close();
                                      } else
                                        controller.enqueue(Buffer.from(String(chunk), "base64"));
                                    } catch (error) {
                                      cleanup();
                                      controller.error(error);
                                    }
                                  },
                                  cancel,
                                })
                              : null;
                            if (!body) cleanup();
                            return new Response(body, {
                              status: response.status,
                              headers: response.headers,
                            });
                          },
                          catch: pluginFailure("http"),
                        }),
                    }
                  : {}),
              };
              return contributions;
            }).pipe(
              Effect.mapError((cause) =>
                isPluginError(cause) ? cause : pluginFailure("activate")(cause),
              ),
            ),
          ),
        };
        return {
          default: proxy,
          health: SubscriptionRef.changes(health),
          setRestartLimit: (next: number) =>
            Effect.sync(() => {
              limit = next;
            }).pipe(
              Effect.andThen(
                SubscriptionRef.update(health, (value) => ({ ...value, limit: next })),
              ),
            ),
        };
      }).pipe(
        Effect.mapError((cause) =>
          isOperationError(cause)
            ? cause
            : new PluginOperationError({ pluginId: "worker", operation: "start", cause }),
        ),
      ),
    ),
  });
});
export const layer = Layer.effect(PluginModuleLoader, make).pipe(
  Layer.provide(ProcessRunner.layer),
);
