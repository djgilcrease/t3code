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
  PluginManifest,
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
  launch: Schema.Boolean,
  http: Schema.Boolean,
});
const decodeActivated = Schema.decodeUnknownSync(Activated);
const decodeManifest = Schema.decodeUnknownSync(PluginManifest);
const decodeView = Schema.decodeUnknownSync(PluginView);
const metadataIdentity = Schema.encodeSync(Schema.fromJsonString(Activated));
const manifestIdentity = Schema.encodeSync(Schema.fromJsonString(PluginManifest));
const isOperationError = Schema.is(PluginOperationError);
const isPluginError = Schema.is(PluginError);
const pluginFailure = (operation: string) => (cause: unknown) =>
  new PluginError({ operation, cause });

const make = Effect.gen(function* () {
  const executable = yield* HostProcessExecutablePath;
  const environment = yield* HostProcessEnvironment;
  const standalone = yield* HostProcessIsExecutable;
  return PluginModuleLoader.of({
    load: (path, options) =>
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
        let startedAt = yield* Clock.currentTimeMillis;

        const openSession = () => {
          const ownGeneration = ++generation;
          const workerUrl = import.meta.url.endsWith(".ts")
            ? new URL("./plugin-worker.ts", import.meta.url)
            : new URL("./plugins/plugin-worker.mjs", import.meta.url);
          const workerEnvironment = {
            ...environment,
            ELECTRON_RUN_AS_NODE: "1",
            NODE_OPTIONS: "--max-old-space-size=256",
          };
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
              const abort = () => {
                pending.delete(id);
                // A stuck handler must not retain a live, unresponsive worker.
                if (["load", "activate", "command", "view", "launch"].includes(method))
                  child.kill("SIGKILL");
                reject(new Error("Plugin call cancelled"));
              };
              const cleanup = () => signal?.removeEventListener("abort", abort);
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
          const hostCall = async (method: string, value: Schema.Json): Promise<Schema.Json> => {
            if (!hostContext || closed || expected || exited || ownGeneration !== generation)
              throw new Error("Plugin not activated");
            const payload = value as Record<string, Schema.Json>;
            // Native IPC callbacks are a framework boundary, reusing the captured
            // application context rather than making per-plugin Effect runtimes.
            const run = Effect.runPromiseWith(runtimeContext);
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
            if (method === "http-url") return await run(hostContext.httpBaseUrl);
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
              void hostCall(message.method, message.payload)
                .then(
                  (payload) =>
                    send({ kind: "host-reply", id: message.id, method: "", payload, ok: true }),
                  () =>
                    send({
                      kind: "host-reply",
                      id: message.id,
                      method: "",
                      payload: null,
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
        let initial: { session: Session; manifest: typeof PluginManifest.Type } | undefined;
        while (!initial && failures < limit) {
          const result = yield* start.pipe(Effect.result);
          if (result._tag === "Success") initial = result.success;
          else failures++;
        }
        if (!initial)
          return yield* new PluginOperationError({
            pluginId: "worker",
            operation: "crash-limit",
            cause: null,
          });
        const activateSession = (session: Session) =>
          session
            .invoke(
              "activate",
              {
                id: hostContext!.id,
                dataDirectory: hostContext!.dataDirectory,
                httpBasePath: hostContext!.httpBasePath,
              },
              AbortSignal.timeout(15_000),
            )
            .then(decodeActivated);
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
          activate: (context) =>
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
  });
});
export const layer = Layer.effect(PluginModuleLoader, make);
