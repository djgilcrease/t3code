import { ProviderDriverKind } from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as Deferred from "effect/Deferred";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Logger from "effect/Logger";
import * as Fiber from "effect/Fiber";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
  HttpServerResponse,
} from "effect/http";
import { codexAppServerArgs } from "../provider/codexLaunchArgs.ts";
import * as ServerConfig from "../config.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { make } from "./ModelProxy.ts";

function fixture(
  respond: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Response | Effect.Effect<Response, HttpClientError.HttpClientError> = () =>
    Response.json({ data: [] }),
  initial?: string,
  host?: string,
  keyLoaded?: (bytes: Uint8Array) => Effect.Effect<Uint8Array>,
) {
  const saved = new Map<string, Uint8Array>();
  if (initial) saved.set("model-proxy-state", new TextEncoder().encode(initial));
  const requests: HttpClientRequest.HttpClientRequest[] = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request);
      return respond(request);
    }).pipe(
      Effect.flatMap((response) =>
        Effect.isEffect(response) ? response : Effect.succeed(response),
      ),
      Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
    ),
  );
  const secrets = ServerSecretStore.of({
    get: (name) => Effect.succeed(Option.fromNullishOr(saved.get(name))),
    set: (name, value) =>
      Effect.sync(() => {
        saved.set(name, value);
      }),
    create: (name, value) =>
      Effect.sync(() => {
        saved.set(name, value);
      }),
    remove: (name) =>
      Effect.sync(() => {
        saved.delete(name);
      }),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        const value = saved.get(name) ?? new Uint8Array(bytes).fill(17);
        saved.set(name, value);
        return value;
      }).pipe(Effect.flatMap((value) => (keyLoaded ? keyLoaded(value) : Effect.succeed(value)))),
  });
  return {
    saved,
    requests,
    api: Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return yield* make.pipe(
        Effect.provideService(ServerConfig.ServerConfig, { ...config, host }),
      );
    }).pipe(
      Effect.provideService(ServerSecretStore, secrets),
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provide(
        Layer.mergeAll(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-proxy-test-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
          NodeCrypto.layer,
        ),
      ),
    ),
  };
}
const request = {
  path: "/v1/responses",
  method: "POST",
  headers: {},
  payload: { model: "gpt-5.4", input: "Hello" },
};

const drainResponse = (response: HttpServerResponse.HttpServerResponse) =>
  response.body._tag === "Stream"
    ? Stream.runDrain(response.body.stream.pipe(Stream.orDie))
    : Effect.void;

describe("native T3 Proxy", () => {
  it.effect("keeps a rotated key authoritative when an older key load completes later", () =>
    Effect.gen(function* () {
      const loading = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const test = fixture(undefined, undefined, undefined, (bytes) =>
        Deferred.succeed(loading, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as(bytes),
        ),
      );
      const proxy = yield* test.api;
      yield* proxy.manage({ action: "start" });
      const oldKey = "11".repeat(32);
      const pending = yield* proxy
        .forward({ ...request, apiKey: oldKey })
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(loading);
      const rotated = (yield* proxy.manage({ action: "rotateKey" })).apiKey!;
      yield* Deferred.succeed(release, undefined);
      const delayed = yield* Fiber.join(pending);
      expect(delayed._tag === "Failure" && delayed.failure.operation).toBe("unauthorized");
      expect((yield* proxy.manage({ action: "revealKey" })).apiKey).toBe(rotated);
      expect(yield* proxy.forward({ ...request, apiKey: oldKey }).pipe(Effect.flip)).toMatchObject({
        operation: "unauthorized",
      });
      expect(
        (yield* proxy.forward({ ...request, path: "/v1/t3/quota", method: "GET", apiKey: rotated }))
          .status,
      ).toBe(200);
      // A restart must load the same generation that the running service accepts.
      expect(Buffer.from(test.saved.get("model-proxy-api")!).toString("hex")).toBe(rotated);
      const restarted = yield* test.api;
      expect((yield* restarted.manage({ action: "revealKey" })).apiKey).toBe(rotated);
    }).pipe(Effect.scoped),
  );
  it.effect("preserves account disablement when an earlier OAuth flow replaces its tokens", () =>
    Effect.gen(function* () {
      const test = fixture((req) =>
        req.url.endsWith("/oauth/token")
          ? Response.json({ access_token: "oauth", account: { uuid: "subject" } })
          : Response.json({}),
      );
      const proxy = yield* test.api;
      const signIn = (state: string) =>
        proxy.manage({
          action: "authComplete",
          provider: "codex",
          state,
          redirectUrl: `http://localhost:1455/auth/callback?code=c&state=${state}`,
        });
      const first = (yield* proxy.manage({ action: "authStart", provider: "codex" })).oauth!;
      const account = (yield* signIn(first.state)).accounts[0]!;
      const pending = (yield* proxy.manage({ action: "authStart", provider: "codex" })).oauth!;
      yield* proxy.manage({ action: "setAccountEnabled", name: account.name, enabled: false });
      const completed = yield* signIn(pending.state);
      expect(completed.accounts).toHaveLength(1);
      expect(completed.accounts[0]).toMatchObject({ id: account.id, disabled: true });
      yield* proxy.manage({ action: "start" });
      const apiKey = (yield* proxy.manage({ action: "revealKey" })).apiKey!;
      expect(yield* proxy.forward({ ...request, apiKey }).pipe(Effect.flip)).toMatchObject({
        operation: "noAccounts",
      });
      yield* proxy.manage({ action: "setAccountEnabled", name: account.name, enabled: true });
      expect((yield* proxy.forward({ ...request, apiKey })).status).toBe(200);
    }).pipe(Effect.scoped),
  );
  it.effect("logs storage and HTTP failures without exposing credentials or response bodies", () =>
    Effect.gen(function* () {
      const logs: Array<{ message: unknown; annotations: Record<string, unknown> }> = [];
      const logger = Logger.make(({ message, fiber }) => {
        logs.push({ message, annotations: { ...fiber.getRef(References.CurrentLogAnnotations) } });
      });
      yield* Effect.gen(function* () {
        const broken = yield* fixture(undefined, "secret-storage-token").api;
        const storage = yield* broken.manage({ action: "start" }).pipe(Effect.result);
        expect(storage._tag === "Failure" && storage.failure.operation).toBe("storage");
        const proxy = yield* fixture(() => new Response("secret-response-token", { status: 503 }))
          .api;
        const flow = (yield* proxy.manage({ action: "authStart", provider: "codex" })).oauth!;
        const result = yield* proxy
          .manage({
            action: "authComplete",
            provider: "codex",
            state: flow.state,
            redirectUrl: `http://localhost:1455/auth/callback?code=secret-auth-code&state=${flow.state}`,
          })
          .pipe(Effect.result);
        expect(result._tag === "Failure" && result.failure.operation).toBe("upstream");
        expect(JSON.stringify(result)).not.toContain("secret-");
        yield* proxy.manage({
          action: "importAccount",
          name: "codex.json",
          credential: { type: "codex", access_token: "secret-access-token" },
        });
        yield* proxy.manage({ action: "start" });
      }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
      expect(logs.some((log) => log.annotations.operation === "storage")).toBe(true);
      expect(
        logs.some(
          (log) =>
            log.annotations.operation === "upstream" &&
            log.annotations.status === 503 &&
            log.annotations.category === "StatusCodeError",
        ),
      ).toBe(true);
      expect(JSON.stringify(logs)).not.toContain("secret-");
      expect(
        logs.some(
          (log) =>
            log.annotations.provider === "codex" &&
            log.annotations.stage === "quota" &&
            log.annotations.status === 503,
        ),
      ).toBe(true);
      expect(JSON.stringify(logs)).not.toContain("oauth/token");
    }).pipe(Effect.scoped),
  );
  it.effect("rejects local routing while stopped and preserves normal CLI launches", () =>
    Effect.gen(function* () {
      const proxy = yield* fixture().api;
      const result = yield* proxy.manage({ action: "useLocal" }).pipe(Effect.result);
      expect(result._tag === "Failure" && result.failure.operation).toBe("disabled");
      expect((yield* proxy.manage({ action: "status" })).client.configured).toBe(false);
      const base = { PATH: "original" };
      expect(yield* proxy.environment(ProviderDriverKind.make("codex"), base)).toBe(base);
      yield* proxy.manage({ action: "start" });
      expect((yield* proxy.manage({ action: "useLocal" })).client.local).toBe(true);
    }).pipe(Effect.scoped),
  );
  it.effect("routes local CLIs to the server's specific bound host and formats IPv6", () =>
    Effect.gen(function* () {
      for (const [host, expected] of [
        [undefined, "127.0.0.1"],
        ["0.0.0.0", "127.0.0.1"],
        ["::", "127.0.0.1"],
        ["100.100.1.2", "100.100.1.2"],
        ["192.168.1.10", "192.168.1.10"],
        ["::1", "[::1]"],
      ] as const) {
        const proxy = yield* fixture(undefined, undefined, host).api;
        yield* proxy.manage({ action: "start" });
        const url = `http://${expected}:0/api/model-proxy`;
        expect(
          (yield* proxy.environment(ProviderDriverKind.make("claudeAgent"), {})).ANTHROPIC_BASE_URL,
        ).toBe(url);
        const codex = yield* proxy.environment(ProviderDriverKind.make("codex"), {});
        expect(codex.T3CODE_CODEX_LAUNCH_ARGS).toContain(`${url}/v1`);
        const opencode = yield* proxy.environment(ProviderDriverKind.make("opencode"), {});
        expect(JSON.parse(opencode.OPENCODE_CONFIG_CONTENT!).provider.google.options.baseURL).toBe(
          `${url}/v1beta`,
        );
      }
    }).pipe(Effect.scoped),
  );
  it.effect("forwards Claude beta message and token-count routes with their query strings", () =>
    Effect.gen(function* () {
      const test = fixture(() => Response.json({ content: [], input_tokens: 10 }));
      const proxy = yield* test.api;
      yield* proxy.manage({
        action: "importAccount",
        name: "claude.json",
        credential: { type: "claude", api_key: "key" },
      });
      yield* proxy.manage({ action: "start" });
      const key = (yield* proxy.manage({ action: "revealKey" })).apiKey!;
      for (const path of ["/v1/messages?beta=true", "/v1/messages/count_tokens?beta=true"]) {
        const response = yield* proxy.forward({
          ...request,
          path,
          apiKey: key,
          payload: { model: "claude-sonnet-4-6", messages: [], max_tokens: 8 },
        });
        expect(response.status).toBe(200);
        expect(test.requests.at(-1)?.url).toBe(`https://api.anthropic.com${path}`);
      }
    }).pipe(Effect.scoped),
  );
  it.effect(
    "forwards Google OAuth token counts without generation metadata or response unwrapping",
    () =>
      Effect.gen(function* () {
        for (const provider of ["gemini", "antigravity"] as const) {
          const test = fixture((request) =>
            request.url.endsWith(":countTokens")
              ? Response.json({ totalTokens: 42 })
              : Response.json({ buckets: [] }),
          );
          const proxy = yield* test.api;
          yield* proxy.manage({
            action: "importAccount",
            name: `${provider}.json`,
            credential: { type: provider, access_token: "test-token", project_id: "test-project" },
          });
          yield* proxy.manage({ action: "start" });
          const key = (yield* proxy.manage({ action: "revealKey" })).apiKey!;
          const contents = [{ role: "user", parts: [{ text: "Hello" }] }];
          const response = yield* proxy.forward({
            ...request,
            path: "/v1beta/models/gemini-2.5-pro:countTokens",
            apiKey: key,
            payload: {
              model: provider === "antigravity" ? "antigravity/gemini-2.5-pro" : "gemini-2.5-pro",
              contents,
            },
          });
          const sent = test.requests.find((request) => request.url.endsWith(":countTokens"))!;
          expect(sent.body._tag).toBe("Uint8Array");
          if (sent.body._tag === "Uint8Array") {
            expect(JSON.parse(new TextDecoder().decode(sent.body.body))).toEqual({
              request: { model: "models/gemini-2.5-pro", contents },
            });
          }
          expect(response.status).toBe(200);
          expect(response.body._tag).toBe("Stream");
          if (response.body._tag === "Stream") {
            const json = yield* response.body.stream.pipe(
              Stream.orDie,
              Stream.decodeText(),
              Stream.runFold(
                () => "",
                (previous, chunk) => previous + chunk,
              ),
            );
            expect(JSON.parse(json)).toEqual({ totalTokens: 42 });
          }
        }
      }).pipe(Effect.scoped),
  );
  it.effect("uses the configured Google OAuth client for authorization and token exchange", () =>
    Effect.gen(function* () {
      const test = fixture((request) =>
        request.url.includes("oauth2.googleapis.com")
          ? Response.json({ access_token: "google-token", expires_in: 3600 })
          : request.url.includes("userinfo")
            ? Response.json({ id: "google-account", email: "account@example.test" })
            : request.url.includes("loadCodeAssist")
              ? Response.json({ cloudaicompanionProject: "project" })
              : Response.json({ buckets: [] }),
      );
      const proxy = yield* test.api.pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                T3CODE_PROXY_GEMINI_OAUTH_CLIENT_ID: "test-google-client",
                T3CODE_PROXY_GEMINI_OAUTH_CLIENT_SECRET: "test-google-secret",
              },
            }),
          ),
        ),
      );
      yield* proxy.manage({ action: "start" });
      const flow = (yield* proxy.manage({ action: "authStart", provider: "gemini" })).oauth!;
      expect(new URL(flow.url).searchParams.get("client_id")).toBe("test-google-client");
      const signedIn = yield* proxy.manage({
        action: "authComplete",
        provider: "gemini",
        state: flow.state,
        redirectUrl: `http://localhost:8085/oauth2callback?code=google-code&state=${flow.state}`,
      });
      expect(signedIn.accounts[0]).toMatchObject({
        provider: "gemini",
        email: "account@example.test",
      });
      const exchange = test.requests.find((request) =>
        request.url.includes("oauth2.googleapis.com"),
      )!;
      expect(exchange.body._tag).toBe("Uint8Array");
      if (exchange.body._tag === "Uint8Array") {
        const params = new URLSearchParams(new TextDecoder().decode(exchange.body.body));
        expect(params.get("client_id")).toBe("test-google-client");
        expect(params.get("client_secret")).toBe("test-google-secret");
        expect(params.get("code_verifier")).toBeTruthy();
      }
    }).pipe(Effect.scoped),
  );
  it.effect(
    "rejects Google sign-in without server OAuth configuration before making a request",
    () =>
      Effect.gen(function* () {
        const test = fixture();
        const proxy = yield* test.api.pipe(
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} }))),
        );
        yield* proxy.manage({ action: "start" });
        const result = yield* proxy
          .manage({ action: "authStart", provider: "gemini" })
          .pipe(Effect.result);
        expect(result._tag === "Failure" && result.failure.operation).toBe("oauthConfig");
        expect(test.requests).toHaveLength(0);
      }).pipe(Effect.scoped),
  );
  it.effect(
    "refreshes quota in the background without duplicating recent probes or probing after stop",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(0);
        const refreshed = yield* Deferred.make<void>();
        let probes = 0;
        const test = fixture((request) => {
          if (request.url.includes("/wham/usage")) {
            probes++;
            if (probes === 2) Deferred.doneUnsafe(refreshed, Effect.void);
          }
          return Response.json({ rate_limit: { primary_window: { used_percent: 20 } } });
        });
        const proxy = yield* test.api;
        yield* proxy.manage({
          action: "importAccount",
          name: "account.json",
          credential: { type: "codex", access_token: "oauth" },
        });
        yield* proxy.manage({ action: "start" });
        expect(probes).toBe(1);
        yield* TestClock.adjust("5 minutes");
        yield* Deferred.await(refreshed);
        expect(probes).toBe(2);
        yield* proxy.manage({ action: "stop" });
        yield* TestClock.adjust("5 minutes");
        expect(probes).toBe(2);
      }).pipe(Effect.scoped),
  );
  it.effect("defaults to 12 idle minutes and migrates existing fill-first settings", () =>
    Effect.gen(function* () {
      const test = fixture(
        undefined,
        JSON.stringify({ enabled: false, strategy: "fill-first", accounts: [] }),
      );
      const proxy = yield* test.api;
      expect(yield* proxy.manage({ action: "status" })).toMatchObject({
        strategy: "closest-reset",
        stickyIdleMinutes: 12,
      });
      yield* proxy.manage({ action: "setStickyIdleMinutes", minutes: 3 });
      expect((yield* proxy.manage({ action: "status" })).stickyIdleMinutes).toBe(3);
      expect(new TextDecoder().decode(test.saved.get("model-proxy-state"))).toContain(
        '"stickyIdleMinutes":3',
      );
    }).pipe(Effect.scoped),
  );
  it.effect(
    "balances new CLI sessions, preserving cache headers and renewing sticky idle time",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(0);
        const test = fixture(() => Response.json({ id: "r", output: [] }));
        const proxy = yield* test.api;
        for (const apiKey of ["first", "second"])
          yield* proxy.manage({
            action: "importAccount",
            name: `${apiKey}.json`,
            credential: { type: "codex", api_key: apiKey },
          });
        yield* proxy.manage({ action: "start" });
        yield* proxy.manage({ action: "setStickyIdleMinutes", minutes: 2 });
        const key = (yield* proxy.manage({ action: "revealKey" })).apiKey!;
        const call = (session: string) =>
          proxy
            .forward({ ...request, headers: { "session-id": session }, apiKey: key })
            .pipe(Effect.flatMap(drainResponse));
        yield* call("first-session");
        yield* call("other-session");
        yield* TestClock.setTime(119_000);
        yield* call("first-session");
        yield* TestClock.setTime(238_000);
        yield* call("first-session");
        yield* call("third-session");
        yield* TestClock.setTime(358_000);
        yield* call("first-session");
        expect(test.requests.map((req) => req.headers.authorization)).toEqual([
          "Bearer first",
          "Bearer second",
          "Bearer first",
          "Bearer first",
          "Bearer first",
          "Bearer second",
        ]);
        expect(test.requests[0]?.headers["session-id"]).toBe("first-session");
        expect(
          (yield* proxy.manage({ action: "status" })).accounts.map(
            (account) => account.activeSessions,
          ),
        ).toEqual([0, 1]);
      }).pipe(Effect.scoped),
  );
  it.effect("starts the idle deadline after a long response stream finishes", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(0);
      const test = fixture(() => Response.json({ id: "r", output: [] }));
      const proxy = yield* test.api;
      for (const apiKey of ["first", "second"])
        yield* proxy.manage({
          action: "importAccount",
          name: `${apiKey}.json`,
          credential: { type: "codex", api_key: apiKey },
        });
      yield* proxy.manage({ action: "start" });
      yield* proxy.manage({ action: "setStickyIdleMinutes", minutes: 1 });
      const key = (yield* proxy.manage({ action: "revealKey" })).apiKey!;
      const sessionRequest = {
        ...request,
        headers: { "x-opencode-session-id": "long-session" },
        apiKey: key,
      };
      const open = yield* proxy.forward(sessionRequest);
      yield* TestClock.setTime(180_000);
      yield* proxy.forward(sessionRequest).pipe(Effect.flatMap(drainResponse));
      yield* drainResponse(open);
      yield* TestClock.setTime(239_000);
      yield* proxy.forward(sessionRequest).pipe(Effect.flatMap(drainResponse));
      yield* TestClock.setTime(299_000);
      yield* proxy.forward(sessionRequest).pipe(Effect.flatMap(drainResponse));
      expect(test.requests.map((req) => req.headers.authorization)).toEqual([
        "Bearer first",
        "Bearer first",
        "Bearer first",
        "Bearer second",
      ]);
    }).pipe(Effect.scoped),
  );
  it.effect("releases a sticky account after an upstream response stream fails", () =>
    Effect.gen(function* () {
      const test = fixture((req) =>
        req.headers.authorization === "Bearer first"
          ? new Response(
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.error(new Error("Upstream body failed"));
                },
              }),
              { headers: { "Content-Type": "text/event-stream" } },
            )
          : Response.json({ id: "r", output: [] }),
      );
      const proxy = yield* test.api;
      for (const apiKey of ["first", "second"])
        yield* proxy.manage({
          action: "importAccount",
          name: `${apiKey}.json`,
          credential: { type: "codex", api_key: apiKey },
        });
      yield* proxy.manage({ action: "start" });
      const apiKey = (yield* proxy.manage({ action: "revealKey" })).apiKey!;
      const sessionRequest = {
        ...request,
        headers: { "session-id": "failed-stream" },
        apiKey,
        payload: { ...request.payload, stream: true },
      };
      const response = yield* proxy.forward(sessionRequest);
      expect(response.status).toBe(200);
      if (response.body._tag !== "Stream") throw new Error("Expected a streamed response");
      expect(
        (yield* response.body.stream.pipe(
          Stream.mapError((cause) => new Error("Response stream failed", { cause })),
          Stream.runDrain,
          Effect.result,
        ))._tag,
      ).toBe("Failure");
      expect(
        (yield* proxy.manage({ action: "status" })).accounts.map((a) => a.activeSessions),
      ).toEqual([0, 0]);
      yield* proxy.forward(sessionRequest).pipe(Effect.flatMap(drainResponse));
      yield* proxy.forward(sessionRequest).pipe(Effect.flatMap(drainResponse));
      expect(test.requests.map((req) => req.headers.authorization)).toEqual([
        "Bearer first",
        "Bearer second",
        "Bearer second",
      ]);
    }).pipe(Effect.scoped),
  );
  it.effect("releases a sticky account when streamed protocol translation fails", () =>
    Effect.gen(function* () {
      const test = fixture((req) =>
        req.url.endsWith("/responses")
          ? new Response(
              req.headers.authorization === "Bearer first"
                ? "data: {invalid-json}\n\n"
                : 'data: {"type":"response.completed","response":{"id":"r","output":[]}}\n\n',
              { headers: { "Content-Type": "text/event-stream" } },
            )
          : Response.json({}),
      );
      const proxy = yield* test.api;
      for (const accessToken of ["first", "second"])
        yield* proxy.manage({
          action: "importAccount",
          name: `${accessToken}.json`,
          credential: { type: "codex", access_token: accessToken },
        });
      yield* proxy.manage({ action: "start" });
      const apiKey = (yield* proxy.manage({ action: "revealKey" })).apiKey!;
      const sessionRequest = {
        ...request,
        path: "/v1/chat/completions",
        headers: { "session-id": "failed-translation" },
        apiKey,
        payload: { model: "gpt-5.4", messages: [{ role: "user", content: "Hello" }], stream: true },
      };
      const response = yield* proxy.forward(sessionRequest);
      expect(response.status).toBe(200);
      if (response.body._tag !== "Stream") throw new Error("Expected a streamed response");
      expect(
        (yield* response.body.stream.pipe(
          Stream.mapError((cause) => new Error("Response stream failed", { cause })),
          Stream.runDrain,
          Effect.result,
        ))._tag,
      ).toBe("Failure");
      expect(
        (yield* proxy.manage({ action: "status" })).accounts.map((a) => a.activeSessions),
      ).toEqual([0, 0]);
      yield* proxy.forward(sessionRequest).pipe(Effect.flatMap(drainResponse));
      yield* proxy.forward(sessionRequest).pipe(Effect.flatMap(drainResponse));
      expect(
        test.requests
          .filter((req) => req.url.endsWith("/responses"))
          .map((req) => req.headers.authorization),
      ).toEqual(["Bearer first", "Bearer second", "Bearer second"]);
    }).pipe(Effect.scoped),
  );
  it.effect("keeps a sticky account on client cancellation and starts its idle deadline then", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(0);
      const consumed = yield* Deferred.make<void>();
      let firstResponse = true;
      const test = fixture(() => {
        if (!firstResponse) return Response.json({ id: "r", output: [] });
        firstResponse = false;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("data: {}\n\n"));
            },
            pull: () => new Promise<void>(() => {}),
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        );
      });
      const proxy = yield* test.api;
      for (const apiKey of ["first", "second"])
        yield* proxy.manage({
          action: "importAccount",
          name: `${apiKey}.json`,
          credential: { type: "codex", api_key: apiKey },
        });
      yield* proxy.manage({ action: "start" });
      yield* proxy.manage({ action: "setStickyIdleMinutes", minutes: 1 });
      const apiKey = (yield* proxy.manage({ action: "revealKey" })).apiKey!;
      const sessionRequest = {
        ...request,
        headers: { "session-id": "cancelled-stream" },
        apiKey,
        payload: { ...request.payload, stream: true },
      };
      const response = yield* proxy.forward(sessionRequest);
      if (response.body._tag !== "Stream") throw new Error("Expected a streamed response");
      const pending = yield* response.body.stream.pipe(
        Stream.tap(() => Deferred.succeed(consumed, undefined)),
        Stream.runDrain,
        Effect.forkChild,
      );
      yield* Deferred.await(consumed);
      yield* TestClock.setTime(60_000);
      yield* Fiber.interrupt(pending);
      expect(
        (yield* proxy.manage({ action: "status" })).accounts.map((a) => a.activeSessions),
      ).toEqual([1, 0]);
      yield* TestClock.setTime(119_000);
      yield* proxy.forward(sessionRequest).pipe(Effect.flatMap(drainResponse));
      yield* TestClock.setTime(179_000);
      yield* proxy.forward(sessionRequest).pipe(Effect.flatMap(drainResponse));
      expect(test.requests.map((req) => req.headers.authorization)).toEqual([
        "Bearer first",
        "Bearer first",
        "Bearer second",
      ]);
    }).pipe(Effect.scoped),
  );
  it.effect(
    "uses nearest available reset quotas for new sessions without moving sticky sessions",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(0);
        let reversed = false;
        const test = fixture((req) =>
          req.url.includes("/wham/usage")
            ? Response.json({
                rate_limit: {
                  primary_window: {
                    used_percent: 50,
                    reset_at:
                      (req.headers.authorization === "Bearer first") === reversed ? 1000 : 2000,
                  },
                },
              })
            : Response.json({ id: "r", output: [] }),
        );
        const proxy = yield* test.api;
        for (const accessToken of ["first", "second"])
          yield* proxy.manage({
            action: "importAccount",
            name: `${accessToken}.json`,
            credential: { type: "codex", access_token: accessToken },
          });
        yield* proxy.manage({
          action: "importAccount",
          name: "unknown.json",
          credential: { type: "codex", api_key: "unknown" },
        });
        yield* proxy.manage({ action: "start" });
        yield* proxy.manage({ action: "setStrategy", strategy: "closest-reset" });
        const key = (yield* proxy.manage({ action: "revealKey" })).apiKey!;
        const call = (session: string) =>
          proxy
            .forward({ ...request, headers: { "session-id": session }, apiKey: key })
            .pipe(Effect.flatMap(drainResponse));
        yield* call("sticky");
        reversed = true;
        yield* proxy.manage({ action: "refresh" });
        yield* call("sticky");
        yield* call("new");
        expect(
          test.requests
            .filter((req) => req.url.includes("/codex/responses"))
            .map((req) => req.headers.authorization),
        ).toEqual(["Bearer second", "Bearer second", "Bearer first"]);
      }).pipe(Effect.scoped),
  );
  it.effect("moves a sticky session on quota exhaustion and keeps the replacement account", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(0);
      let exhausted = false;
      const test = fixture((req) =>
        exhausted && req.headers.authorization === "Bearer first"
          ? Response.json({}, { status: 429 })
          : Response.json({ id: "r", output: [] }),
      );
      const proxy = yield* test.api;
      for (const apiKey of ["first", "second"])
        yield* proxy.manage({
          action: "importAccount",
          name: `${apiKey}.json`,
          credential: { type: "codex", api_key: apiKey },
        });
      yield* proxy.manage({ action: "start" });
      const key = (yield* proxy.manage({ action: "revealKey" })).apiKey!;
      const sessionRequest = {
        ...request,
        headers: { "x-claude-code-session-id": "sticky" },
        apiKey: key,
      };
      yield* proxy.forward(sessionRequest).pipe(Effect.flatMap(drainResponse));
      exhausted = true;
      yield* proxy.forward(sessionRequest).pipe(Effect.flatMap(drainResponse));
      yield* TestClock.setTime(61_000);
      exhausted = false;
      yield* proxy.forward(sessionRequest).pipe(Effect.flatMap(drainResponse));
      expect(test.requests.map((req) => req.headers.authorization)).toEqual([
        "Bearer first",
        "Bearer first",
        "Bearer second",
        "Bearer second",
      ]);
      expect(
        (yield* proxy.manage({ action: "status" })).accounts.map(
          (account) => account.activeSessions,
        ),
      ).toEqual([0, 1]);
    }).pipe(Effect.scoped),
  );
  it.effect("scopes CLI configuration to T3 launches and disables it reversibly", () =>
    Effect.gen(function* () {
      const test = fixture();
      const proxy = yield* test.api;
      const original = {
        ANTHROPIC_API_KEY: "terminal-key",
        T3CODE_CODEX_LAUNCH_ARGS: "--sandbox workspace-write",
      };
      expect(yield* proxy.environment(ProviderDriverKind.make("claudeAgent"), original)).toBe(
        original,
      );
      yield* proxy.manage({ action: "start" });
      const claude = yield* proxy.environment(ProviderDriverKind.make("claudeAgent"), original);
      expect(claude.ANTHROPIC_BASE_URL).toBe("http://127.0.0.1:0/api/model-proxy");
      expect(claude.ANTHROPIC_API_KEY).toBe("");
      expect(original.ANTHROPIC_API_KEY).toBe("terminal-key");
      const codex = yield* proxy.environment(ProviderDriverKind.make("codex"), original);
      expect(codex.T3CODE_CODEX_LAUNCH_ARGS).toContain("--sandbox workspace-write");
      expect(codex.T3CODE_CODEX_LAUNCH_ARGS).toContain('model_provider="t3_proxy"');
      expect(codexAppServerArgs(codex.T3CODE_CODEX_LAUNCH_ARGS)).toContain(
        'model_providers.t3_proxy.base_url="http://127.0.0.1:0/api/model-proxy/v1"',
      );
      expect(original.T3CODE_CODEX_LAUNCH_ARGS).toBe("--sandbox workspace-write");
      const openCode = yield* proxy.environment(ProviderDriverKind.make("opencode"), {
        OPENCODE_CONFIG_CONTENT:
          '{"theme":"custom","provider":{"openai":{"options":{"timeout":5000}}}}',
      });
      expect(openCode.OPENCODE_CONFIG_CONTENT).toContain('"theme":"custom"');
      expect(openCode.OPENCODE_CONFIG_CONTENT).toContain('"timeout":5000');
      expect(openCode.OPENCODE_CONFIG_CONTENT).toContain(
        '"baseURL":"http://127.0.0.1:0/api/model-proxy/v1"',
      );
      expect(yield* proxy.environment(ProviderDriverKind.make("cursor"), original)).toBe(original);
      expect(yield* proxy.manage({ action: "status" })).not.toHaveProperty("apiKey");
      yield* proxy.manage({ action: "stop" });
      expect(yield* proxy.environment(ProviderDriverKind.make("claudeAgent"), original)).toBe(
        original,
      );
    }).pipe(Effect.scoped),
  );
  it.effect(
    "rotates accounts, fails over on quota exhaustion, and excludes disabled accounts",
    () =>
      Effect.gen(function* () {
        const test = fixture((req) =>
          req.headers.authorization === "Bearer first"
            ? Response.json({}, { status: 429 })
            : Response.json({ id: "r", object: "response", output: [] }),
        );
        const proxy = yield* test.api;
        yield* proxy.manage({
          action: "importAccount",
          name: "first.json",
          credential: { type: "codex", api_key: "first" },
        });
        yield* proxy.manage({
          action: "importAccount",
          name: "second.json",
          credential: { type: "codex", api_key: "second" },
        });
        yield* proxy.manage({ action: "start" });
        const key = (yield* proxy.manage({ action: "revealKey" })).apiKey!;
        expect((yield* proxy.forward({ ...request, apiKey: key })).status).toBe(200);
        expect(test.requests.map((req) => req.headers.authorization)).toEqual([
          "Bearer first",
          "Bearer second",
        ]);
        yield* proxy.forward({ ...request, apiKey: key });
        expect(test.requests.at(-1)?.headers.authorization).toBe("Bearer second");
        yield* proxy.manage({ action: "setAccountEnabled", name: "second.json", enabled: false });
        const failed = yield* proxy.forward({ ...request, apiKey: key }).pipe(Effect.result);
        expect(failed._tag).toBe("Failure");
        yield* proxy.manage({ action: "removeAccount", name: "first.json" });
        expect((yield* proxy.manage({ action: "status" })).accounts).toHaveLength(1);
      }).pipe(Effect.scoped),
  );
  it.effect("fails over when an account's credential is rejected", () =>
    Effect.gen(function* () {
      const test = fixture((req) =>
        req.headers.authorization === "Bearer rejected"
          ? Response.json({ error: "invalid credential" }, { status: 401 })
          : Response.json({ id: "r", object: "response", output: [] }),
      );
      const proxy = yield* test.api;
      for (const apiKey of ["rejected", "valid"]) {
        yield* proxy.manage({
          action: "importAccount",
          name: `${apiKey}.json`,
          credential: { type: "codex", api_key: apiKey },
        });
      }
      yield* proxy.manage({ action: "start" });
      const key = (yield* proxy.manage({ action: "revealKey" })).apiKey!;
      expect((yield* proxy.forward({ ...request, apiKey: key })).status).toBe(200);
      expect(test.requests.map((req) => req.headers.authorization)).toEqual([
        "Bearer rejected",
        "Bearer valid",
      ]);
    }).pipe(Effect.scoped),
  );
  it.effect("rejects bad keys before calling an upstream and invalidates rotated keys", () =>
    Effect.gen(function* () {
      const test = fixture();
      const proxy = yield* test.api;
      yield* proxy.manage({ action: "start" });
      const old = (yield* proxy.manage({ action: "revealKey" })).apiKey!;
      const denied = yield* proxy.forward({ ...request, apiKey: "wrong" }).pipe(Effect.result);
      expect(denied._tag).toBe("Failure");
      expect(test.requests).toHaveLength(0);
      yield* proxy.manage({ action: "rotateKey" });
      expect((yield* proxy.forward({ ...request, apiKey: old }).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
    }).pipe(Effect.scoped),
  );
  it.effect("preserves corrupt credential storage instead of overwriting it", () =>
    Effect.gen(function* () {
      const test = fixture(undefined, "invalid");
      const proxy = yield* test.api;
      expect((yield* proxy.manage({ action: "status" })).status).toBe("failed");
      expect((yield* proxy.manage({ action: "start" }).pipe(Effect.result))._tag).toBe("Failure");
      const base = { PATH: "original-path", T3CODE_CODEX_LAUNCH_ARGS: "--original" };
      for (const driver of ["codex", "claudeAgent", "opencode"] as const)
        expect(yield* proxy.environment(ProviderDriverKind.make(driver), base)).toBe(base);
      expect(new TextDecoder().decode(test.saved.get("model-proxy-state"))).toBe("invalid");
    }).pipe(Effect.scoped),
  );
  it.effect("verifies the remote proxy before enabling client mode", () =>
    Effect.gen(function* () {
      const test = fixture((req) =>
        req.url.endsWith("/v1/models")
          ? Response.json({ data: [] })
          : Response.json({ accounts: [] }),
      );
      const proxy = yield* test.api;
      const client = yield* proxy.manage({
        action: "configureClient",
        url: "http://peer.test/api/model-proxy/v1/",
        apiKey: "remote-key",
      });
      expect(client).toMatchObject({
        enabled: false,
        client: { configured: true, local: false, url: "http://peer.test/api/model-proxy" },
      });
      expect(test.requests[0]?.url).toBe("http://peer.test/api/model-proxy/v1/models");
      expect(
        (yield* proxy.environment(ProviderDriverKind.make("claudeAgent"), {})).ANTHROPIC_AUTH_TOKEN,
      ).toBe("remote-key");
      yield* proxy.manage({ action: "disconnectClient" });
      expect(yield* proxy.environment(ProviderDriverKind.make("claudeAgent"), {})).toEqual({});
    }).pipe(Effect.scoped),
  );
  it.effect("keeps a reachable HTTPS proxy without trying HTTP fallbacks", () =>
    Effect.gen(function* () {
      const test = fixture();
      const proxy = yield* test.api;
      const client = yield* proxy.manage({
        action: "configureClient",
        url: "https://peer.test/api/model-proxy",
        fallbackUrls: ["http://100.100.1.2/api/model-proxy"],
        apiKey: "remote-key",
      });
      expect(client.client.url).toBe("https://peer.test/api/model-proxy");
      expect(test.requests.map((req) => req.url)).toEqual([
        "https://peer.test/api/model-proxy/v1/models",
        "https://peer.test/api/model-proxy/v1/t3/quota",
      ]);
    }).pipe(Effect.scoped),
  );
  it.effect("uses and persists a reachable fallback after an HTTPS transport failure", () =>
    Effect.gen(function* () {
      const test = fixture((req) =>
        req.url.startsWith("https:")
          ? Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request: req }),
              }),
            )
          : Response.json({ accounts: [] }),
      );
      const proxy = yield* test.api;
      const client = yield* proxy.manage({
        action: "configureClient",
        url: "https://peer.test/api/model-proxy",
        fallbackUrls: ["http://100.100.1.2/api/model-proxy"],
        apiKey: "remote-key",
      });
      expect(client.client.url).toBe("http://100.100.1.2/api/model-proxy");
      expect(test.requests.slice(0, 2).map((req) => req.url)).toEqual([
        "https://peer.test/api/model-proxy/v1/models",
        "http://100.100.1.2/api/model-proxy/v1/models",
      ]);
      expect(test.requests[1]?.headers.authorization).toBe("Bearer remote-key");
      const restarted = yield* test.api;
      expect(
        (yield* restarted.environment(ProviderDriverKind.make("claudeAgent"), {}))
          .ANTHROPIC_BASE_URL,
      ).toBe("http://100.100.1.2/api/model-proxy");
    }).pipe(Effect.scoped),
  );
  it.effect("tries a fallback after the preferred proxy times out", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const test = fixture((req) =>
        req.url.startsWith("https:")
          ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
          : Response.json({ accounts: [] }),
      );
      const proxy = yield* test.api;
      const pending = yield* proxy
        .manage({
          action: "configureClient",
          url: "https://peer.test/api/model-proxy",
          fallbackUrls: ["http://100.100.1.2/api/model-proxy"],
          apiKey: "remote-key",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust("10 seconds");
      expect((yield* Fiber.join(pending)).client.url).toBe("http://100.100.1.2/api/model-proxy");
    }).pipe(Effect.scoped),
  );
  it.effect("stops on HTTP rejections without probing fallbacks or changing local routing", () =>
    Effect.gen(function* () {
      for (const status of [401, 503]) {
        const test = fixture(() => Response.json({}, { status }));
        const proxy = yield* test.api;
        yield* proxy.manage({ action: "start" });
        yield* proxy.manage({ action: "useLocal" });
        const before = test.saved.get("model-proxy-state");
        const failure = yield* proxy
          .manage({
            action: "configureClient",
            url: "https://peer.test/api/model-proxy",
            fallbackUrls: ["http://100.100.1.2/api/model-proxy"],
            apiKey: "remote-key",
          })
          .pipe(Effect.flip);
        expect(failure.operation).toBe("upstream");
        expect(test.requests).toHaveLength(1);
        expect(test.saved.get("model-proxy-state")).toEqual(before);
        expect(
          (yield* proxy.environment(ProviderDriverKind.make("claudeAgent"), {})).ANTHROPIC_BASE_URL,
        ).toMatch(/^http:\/\/127\.0\.0\.1:/u);
      }
    }).pipe(Effect.scoped),
  );
  it.effect("keeps existing routing when every discovered proxy is unreachable", () =>
    Effect.gen(function* () {
      const test = fixture((req) =>
        Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ request: req }),
          }),
        ),
      );
      const proxy = yield* test.api;
      yield* proxy.manage({ action: "start" });
      yield* proxy.manage({ action: "useLocal" });
      const before = test.saved.get("model-proxy-state");
      const failure = yield* proxy
        .manage({
          action: "configureClient",
          url: "https://peer.test/api/model-proxy",
          fallbackUrls: [
            "https://peer.test/api/model-proxy/v1/",
            "http://100.100.1.2/api/model-proxy",
            "http://100.100.1.2/api/model-proxy",
          ],
          apiKey: "remote-key",
        })
        .pipe(Effect.flip);
      expect(failure.operation).toBe("upstream");
      expect(test.requests).toHaveLength(2);
      expect(test.saved.get("model-proxy-state")).toEqual(before);
    }).pipe(Effect.scoped),
  );
  it.effect("validates every candidate before sending a key or changing routing", () =>
    Effect.gen(function* () {
      const test = fixture();
      const proxy = yield* test.api;
      const failure = yield* proxy
        .manage({
          action: "configureClient",
          url: "https://peer.test/api/model-proxy",
          fallbackUrls: ["https://user:password@peer.test/api/model-proxy"],
          apiKey: "remote-key",
        })
        .pipe(Effect.flip);
      expect(failure.operation).toBe("management");
      expect(test.requests).toHaveLength(0);
      expect(test.saved.has("model-proxy-state")).toBe(false);
      expect(yield* proxy.environment(ProviderDriverKind.make("claudeAgent"), {})).toEqual({});
    }).pipe(Effect.scoped),
  );
  it.effect("discovers OAuth Google models and advertises explicit Antigravity routing", () =>
    Effect.gen(function* () {
      const test = fixture(() =>
        Response.json({ models: { "claude-sonnet-4-6": { displayName: "Claude Sonnet" } } }),
      );
      const proxy = yield* test.api;
      yield* proxy.manage({
        action: "importAccount",
        name: "google.json",
        credential: { type: "antigravity", access_token: "oauth", project_id: "project" },
      });
      yield* proxy.manage({ action: "start" });
      const key = (yield* proxy.manage({ action: "revealKey" })).apiKey!;
      const response = yield* proxy.forward({
        ...request,
        method: "GET",
        path: "/v1/models?client_version=0.156.1",
        apiKey: key,
      });
      const json = yield* Effect.promise(() => HttpServerResponse.toWeb(response).json());
      expect(json).toEqual({
        object: "list",
        data: [{ id: "antigravity/claude-sonnet-4-6", object: "model", owned_by: "antigravity" }],
      });
      expect(test.requests.at(-1)?.method).toBe("POST");
      expect(test.requests.at(-1)?.url).toContain(":fetchAvailableModels");
    }).pipe(Effect.scoped),
  );
  it.effect("shares an expiring account's refresh across concurrent model requests", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(0);
      let refreshes = 0;
      const test = fixture((req) => {
        if (req.url.endsWith("/oauth/token")) {
          refreshes++;
          return Response.json({
            access_token: "renewed",
            refresh_token: "rotated",
            expires_in: 3600,
          });
        }
        return Response.json({ id: "r", output: [] });
      });
      const proxy = yield* test.api;
      yield* proxy.manage({
        action: "importAccount",
        name: "account.json",
        credential: {
          type: "codex",
          access_token: "old",
          refresh_token: "refresh",
          expiry_date: 3600000,
        },
      });
      yield* proxy.manage({ action: "start" });
      yield* TestClock.setTime(4000000);
      const key = (yield* proxy.manage({ action: "revealKey" })).apiKey!;
      yield* Effect.all(
        [proxy.forward({ ...request, apiKey: key }), proxy.forward({ ...request, apiKey: key })],
        { concurrency: 2 },
      );
      expect(refreshes).toBe(1);
      expect(
        test.requests
          .filter((req) => req.url.includes("/codex/responses"))
          .map((req) => req.headers.authorization),
      ).toEqual(["Bearer renewed", "Bearer renewed"]);
      expect(new TextDecoder().decode(test.saved.get("model-proxy-state"))).toContain(
        '"refreshToken":"rotated"',
      );
    }).pipe(Effect.scoped),
  );
  it.effect(
    "exchanges OAuth only after verifying callback state and deduplicates the same login",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(0);
        let exchanges = 0;
        const test = fixture((req) =>
          req.url.endsWith("/oauth/token")
            ? Response.json({
                ...(++exchanges === 1 ? { refresh_token: "refresh" } : {}),
                access_token: "oauth",
                expires_in: 3600,
                account: { uuid: "subject", email_address: "account@example.test" },
              })
            : Response.json({}),
        );
        const proxy = yield* test.api;
        const flow = (yield* proxy.manage({ action: "authStart", provider: "codex" })).oauth!;
        expect(new URL(flow.url).searchParams.get("code_challenge_method")).toBe("S256");
        expect(
          (yield* proxy
            .manage({
              action: "authComplete",
              provider: "codex",
              state: flow.state,
              redirectUrl: "http://localhost:1455/auth/callback?code=c&state=wrong",
            })
            .pipe(Effect.result))._tag,
        ).toBe("Failure");
        expect(test.requests).toHaveLength(0);
        const signedIn = yield* proxy.manage({
          action: "authComplete",
          provider: "codex",
          state: flow.state,
          redirectUrl: `http://localhost:1455/auth/callback?code=c&state=${flow.state}`,
        });
        expect(signedIn.accounts).toHaveLength(1);
        expect(signedIn.accounts[0]?.email).toBe("account@example.test");
        const second = (yield* proxy.manage({ action: "authStart", provider: "codex" })).oauth!;
        expect(
          (yield* proxy.manage({
            action: "authComplete",
            provider: "codex",
            state: second.state,
            redirectUrl: `http://localhost:1455/auth/callback?code=c&state=${second.state}`,
          })).accounts,
        ).toHaveLength(1);
        yield* proxy.manage({ action: "start" });
        yield* TestClock.setTime(4_000_000);
        const key = (yield* proxy.manage({ action: "revealKey" })).apiKey!;
        expect((yield* proxy.forward({ ...request, apiKey: key })).status).toBe(200);
        expect(exchanges).toBe(3);
        const refresh = test.requests.findLast((req) => req.url.endsWith("/oauth/token"))!;
        expect(refresh.body._tag).toBe("Uint8Array");
        if (refresh.body._tag === "Uint8Array")
          expect(
            new URLSearchParams(new TextDecoder().decode(refresh.body.body)).get("refresh_token"),
          ).toBe("refresh");
      }).pipe(Effect.scoped),
  );
  it.effect("collects Codex's forced SSE into a non-streaming Chat response", () =>
    Effect.gen(function* () {
      const completed = {
        type: "response.completed",
        response: {
          id: "r",
          output: [{ type: "message", content: [{ type: "output_text", text: "Hello" }] }],
          usage: { input_tokens: 3, output_tokens: 2 },
        },
      };
      const test = fixture((req) =>
        req.url.endsWith("/responses")
          ? new Response(`data: ${JSON.stringify(completed)}\n\n`, {
              headers: { "Content-Type": "text/event-stream" },
            })
          : Response.json({}),
      );
      const proxy = yield* test.api;
      yield* proxy.manage({
        action: "importAccount",
        name: "oauth.json",
        credential: { type: "codex", access_token: "oauth" },
      });
      yield* proxy.manage({ action: "start" });
      const key = (yield* proxy.manage({ action: "revealKey" })).apiKey!;
      const response = yield* proxy.forward({
        ...request,
        path: "/v1/chat/completions",
        apiKey: key,
        payload: {
          model: "gpt-5.4",
          messages: [{ role: "user", content: "Hello" }],
          stream: false,
        },
      });
      const raw = yield* Effect.promise(() => HttpServerResponse.toWeb(response).text());
      expect(raw).toContain('"content":"Hello"');
      expect(raw).toContain('"total_tokens":5');
    }).pipe(Effect.scoped),
  );
  it.effect("recognizes Codex subscription SSE when upstream omits Content-Type", () =>
    Effect.gen(function* () {
      const test = fixture((req) => {
        if (!req.url.endsWith("/responses")) return Response.json({});
        const response = new Response(
          [
            {
              type: "response.output_item.done",
              output_index: 1,
              item: { type: "function_call", call_id: "call", name: "read", arguments: "{}" },
            },
            {
              type: "response.output_item.done",
              output_index: 0,
              item: { type: "message", content: [{ type: "output_text", text: "Hello" }] },
            },
            { type: "response.completed", response: { id: "r", output: [] } },
          ]
            .map((event) => `data: ${JSON.stringify(event)}\n\n`)
            .join(""),
        );
        response.headers.delete("content-type");
        return response;
      });
      const proxy = yield* test.api;
      yield* proxy.manage({
        action: "importAccount",
        name: "oauth.json",
        credential: { type: "codex", access_token: "oauth" },
      });
      yield* proxy.manage({ action: "start" });
      const key = (yield* proxy.manage({ action: "revealKey" })).apiKey!;
      const response = yield* proxy.forward({ ...request, apiKey: key });
      const raw = yield* Effect.promise(() => HttpServerResponse.toWeb(response).json());
      expect(raw).toMatchObject({
        id: "r",
        output: [{ content: [{ text: "Hello" }] }, { type: "function_call", call_id: "call" }],
      });
    }).pipe(Effect.scoped),
  );
});
