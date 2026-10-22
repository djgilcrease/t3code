// @effect-diagnostics nodeBuiltinImport:off -- isolated executable protocol boundary.
import * as NodeURL from "node:url";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  PluginError,
  PluginManifest,
  type PluginContext,
  type PluginContributions,
  type T3Plugin,
  type PluginInput,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  decodePluginMessage,
  decodePluginLaunch,
  encodePluginLaunch,
  MAX_PLUGIN_MESSAGE_BYTES,
  type PluginMessage,
} from "./pluginProtocol.ts";

/** Runs only in the isolated plugin process, including in single-executable installs. */
export async function runPluginWorker(): Promise<void> {
  const send = (message: PluginMessage) => {
    const text = JSON.stringify(message);
    if (Buffer.byteLength(text) > MAX_PLUGIN_MESSAGE_BYTES)
      throw new Error("Plugin protocol limit");
    process.send?.(text);
  };
  let nextId = 0;
  const pending = new Map<
    number,
    { resolve: (value: Schema.Json) => void; reject: (error: Error) => void }
  >();
  const hostCall = (method: string, payload: Schema.Json) =>
    new Promise<Schema.Json>((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      send({ kind: "host-call", id, method, payload, ok: true });
    });
  const hostEffect = (method: string, payload: Schema.Json) =>
    Effect.tryPromise({
      try: () => hostCall(method, payload),
      catch: (cause) => new PluginError({ operation: method, cause }),
    });
  const scope = await Effect.runPromise(Scope.make());
  let plugin: T3Plugin | undefined;
  let contributions: PluginContributions = {};
  const responses = new Map<
    number,
    {
      reader: ReadableStreamDefaultReader<Uint8Array>;
      remainder?: Uint8Array | undefined;
      controller: AbortController;
    }
  >();
  const controllers = new Map<number, AbortController>();
  const decodeManifest = Schema.decodeUnknownSync(PluginManifest);
  const dispatch = async (message: PluginMessage): Promise<Schema.Json> => {
    const payload = message.payload as Record<string, Schema.Json>;
    switch (message.method) {
      case "load": {
        const module = await import(
          /* @vite-ignore */ NodeURL.pathToFileURL(String(payload.path)).href
        );
        const manifest = decodeManifest(module.default);
        if (typeof module.default.activate !== "function") throw new Error("Invalid activation");
        plugin = module.default as T3Plugin;
        return manifest;
      }
      case "activate": {
        if (!plugin) throw new Error("Plugin not loaded");
        const context: PluginContext = {
          id: String(payload.id),
          dataDirectory: String(payload.dataDirectory),
          httpBasePath: String(payload.httpBasePath),
          httpBaseUrl: hostEffect("http-url", null).pipe(Effect.map(String)),
          secrets: {
            get: (key) =>
              hostEffect("secret-get", { key }).pipe(
                Effect.map((value) => (value === null ? null : String(value))),
              ),
            set: (key, value) => hostEffect("secret-set", { key, value }).pipe(Effect.asVoid),
            remove: (key) => hostEffect("secret-remove", { key }).pipe(Effect.asVoid),
          },
        };
        contributions = await Effect.runPromise(
          plugin.activate(context).pipe(Effect.provideService(Scope.Scope, scope)),
        );
        if (contributions.changes)
          Effect.runFork(
            contributions.changes.pipe(
              Stream.runForEach(() =>
                Effect.sync(() =>
                  send({ kind: "changed", id: 0, method: "", payload: null, ok: true }),
                ),
              ),
              Effect.provideService(Scope.Scope, scope),
              Effect.forkIn(scope),
            ),
          );
        return {
          commands: (contributions.commands ?? []).map(
            ({ run: _run, ...descriptor }) => descriptor,
          ),
          views: (contributions.views ?? []).map(({ read: _read, ...descriptor }) => descriptor),
          launch: !!contributions.prepareLaunch,
          http: !!contributions.handleHttp,
        };
      }
      case "command": {
        const command = contributions.commands?.find((command) => command.id === payload.id);
        if (!command) throw new Error("Unknown command");
        return await Effect.runPromise(command.run(payload.input as PluginInput));
      }
      case "view": {
        const view = contributions.views?.find((view) => view.id === payload.id);
        if (!view) throw new Error("Unknown view");
        return await Effect.runPromise(view.read());
      }
      case "launch":
        return encodePluginLaunch(
          await Effect.runPromise(
            contributions.prepareLaunch!(decodePluginLaunch(message.payload)),
          ),
        );
      case "http": {
        const id = message.id;
        const controller = new AbortController();
        controllers.set(id, controller);
        const body = payload.body
          ? new ReadableStream<Uint8Array>({
              async pull(stream) {
                const chunk = await hostCall("request-chunk", { id });
                if (chunk === null) stream.close();
                else stream.enqueue(Buffer.from(String(chunk), "base64"));
              },
            })
          : null;
        const request = new Request(String(payload.url), {
          method: String(payload.method),
          headers: payload.headers as Record<string, string>,
          ...(body ? { body, duplex: "half" } : {}),
          signal: controller.signal,
        });
        let response: Response;
        try {
          response = await Effect.runPromise(contributions.handleHttp!(request));
        } catch (error) {
          controller.abort();
          controllers.delete(id);
          void body?.cancel().catch(() => {});
          throw error;
        }
        if (response.body) responses.set(id, { reader: response.body.getReader(), controller });
        else controllers.delete(id);
        return {
          id,
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body: response.body !== null,
        };
      }
      case "response-chunk": {
        const id = Number(payload.id);
        const response = responses.get(id);
        if (!response) return null;
        let chunk: { readonly done: boolean; readonly value?: Uint8Array | undefined };
        try {
          chunk = response.remainder
            ? { done: false, value: response.remainder }
            : await response.reader.read();
        } catch (error) {
          response.controller.abort();
          responses.delete(id);
          controllers.delete(id);
          throw error;
        }
        if (chunk.done || !chunk.value) {
          responses.delete(id);
          controllers.delete(id);
          return null;
        }
        response.remainder = chunk.value.length > 65536 ? chunk.value.subarray(65536) : undefined;
        return Buffer.from(chunk.value.subarray(0, 65536)).toString("base64");
      }
      case "http-cancel": {
        const id = Number(payload.id);
        controllers.get(id)?.abort();
        await responses
          .get(id)
          ?.reader.cancel()
          .catch(() => {});
        responses.delete(id);
        controllers.delete(id);
        return null;
      }
      case "shutdown": {
        for (const controller of controllers.values()) controller.abort();
        await Effect.runPromise(Scope.close(scope, Exit.void));
        return null;
      }
      default:
        throw new Error("Unknown protocol method");
    }
  };
  process.on("message", (raw) => {
    let message: PluginMessage;
    try {
      if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_PLUGIN_MESSAGE_BYTES)
        throw new Error();
      message = decodePluginMessage(raw);
    } catch {
      process.exit(1);
    }
    if (message.kind === "host-reply") {
      const reply = pending.get(message.id);
      pending.delete(message.id);
      if (message.ok) reply?.resolve(message.payload);
      else reply?.reject(new Error("Host capability failed"));
    } else if (message.kind === "call") {
      void dispatch(message)
        .then(
          (payload) => send({ kind: "reply", id: message.id, method: "", payload, ok: true }),
          () => send({ kind: "reply", id: message.id, method: "", payload: null, ok: false }),
        )
        .catch(() => process.exit(1));
    }
  });
  process.on("disconnect", () => process.exit(0));
}
