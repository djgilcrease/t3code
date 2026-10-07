import {
  MODEL_PROXY_PATH,
  ModelProxyError,
  ModelProxyProvider,
  ModelProxyStrategy,
  ModelProxyStickyIdleMinutes,
  ModelProxyAccount,
  type ModelProxyManageInput,
  type ModelProxySnapshot,
  type ProviderDriverKind,
  type ServerProviderUsageLimits,
} from "@t3tools/contracts";
import { decodeJwt } from "jose";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
  HttpServerResponse,
} from "effect/http";
import * as ServerConfig from "../config.ts";
import { formatHostForUrl, isWildcardHost } from "../startupAccess.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { codexRateLimitsToLimits } from "../provider/codexUsageLimits.ts";
import { claudeUsageResponseToLimits } from "../provider/claudeUsageLimits.ts";
import { PROXY_OAUTH, ProxyDeviceResponse, ProxyTokenResponse } from "./modelProxyOAuth.ts";
import { receiveProxyCallback } from "./modelProxyCallback.ts";
import {
  ModelProxyBalancer,
  proxyNextReset,
  proxySessionId,
  proxyModelQuota,
  proxyQuotaExhausted,
} from "./modelProxyBalancer.ts";
import {
  ProxyPayload,
  object,
  prepareProxyRequest,
  proxyProviderForModel,
  proxyChatResponse,
  makeProxyStreamTranslator,
} from "./modelProxyProtocols.ts";

const StoredAccount = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  provider: ModelProxyProvider,
  email: Schema.optional(Schema.String),
  subject: Schema.optional(Schema.String),
  disabled: Schema.Boolean,
  accessToken: Schema.String,
  refreshToken: Schema.optional(Schema.String),
  apiKey: Schema.Boolean,
  expiresAt: Schema.Number,
  accountId: Schema.optional(Schema.String),
  projectId: Schema.optional(Schema.String),
  tokenUrl: Schema.optional(Schema.String),
});
type StoredAccount = typeof StoredAccount.Type;
const State = Schema.Struct({
  enabled: Schema.Boolean,
  // Older T3 Proxy state used fill-first; migrate it to the quota-aware strategy.
  strategy: Schema.Literals([...ModelProxyStrategy.literals, "fill-first"]),
  stickyIdleMinutes: Schema.optional(ModelProxyStickyIdleMinutes),
  accounts: Schema.Array(StoredAccount),
  client: Schema.optional(
    Schema.Union([
      Schema.Struct({ type: Schema.Literal("local") }),
      Schema.Struct({ type: Schema.Literal("remote"), url: Schema.String, apiKey: Schema.String }),
    ]),
  ),
});
const encodeState = Schema.encodeEffect(Schema.fromJsonString(State));
const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(State));
const Json = Schema.decodeUnknownEffect(ProxyPayload);
const Claims = Schema.Struct({
  email: Schema.optional(Schema.String),
  sub: Schema.optional(Schema.String),
  "https://api.openai.com/auth": Schema.optional(
    Schema.Struct({ chatgpt_account_id: Schema.optional(Schema.String) }),
  ),
});
const TokenImport = Schema.Struct({
  type: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  access_token: Schema.optional(Schema.String),
  refresh_token: Schema.optional(Schema.String),
  api_key: Schema.optional(Schema.String),
  id_token: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  account_id: Schema.optional(Schema.String),
  project_id: Schema.optional(Schema.String),
  expired: Schema.optional(Schema.String),
  expiry_date: Schema.optional(Schema.Number),
});
const Usage = Schema.Struct({
  plan_type: Schema.optional(Schema.String),
  rate_limit: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        primary_window: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              used_percent: Schema.Number,
              reset_at: Schema.optional(Schema.Number),
              limit_window_seconds: Schema.optional(Schema.Number),
            }),
          ),
        ),
        secondary_window: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              used_percent: Schema.Number,
              reset_at: Schema.optional(Schema.Number),
              limit_window_seconds: Schema.optional(Schema.Number),
            }),
          ),
        ),
      }),
    ),
  ),
});
const ClaudeUsage = Schema.Struct({
  five_hour: Schema.optional(
    Schema.NullOr(
      Schema.Struct({ utilization: Schema.Number, resets_at: Schema.NullOr(Schema.String) }),
    ),
  ),
  seven_day: Schema.optional(
    Schema.NullOr(
      Schema.Struct({ utilization: Schema.Number, resets_at: Schema.NullOr(Schema.String) }),
    ),
  ),
});
const decodeClaims = Schema.decodeUnknownEffect(Claims);
const decodeUsage = Schema.decodeUnknownEffect(Usage);
const decodeClaudeUsage = Schema.decodeUnknownEffect(ClaudeUsage);
const decodeTokens = Schema.decodeUnknownEffect(ProxyTokenResponse);
const decodeImportedToken = Schema.decodeUnknownEffect(TokenImport);
const decodeProvider = Schema.decodeUnknownEffect(ModelProxyProvider);
const decodeJsonPayload = Schema.decodeUnknownEffect(Schema.fromJsonString(ProxyPayload));
const encodeJsonPayload = Schema.encodeEffect(Schema.fromJsonString(ProxyPayload));
const encodeJsonString = Schema.encodeEffect(Schema.fromJsonString(Schema.String));
const decodeRemoteAccounts = Schema.decodeUnknownEffect(
  Schema.Struct({ accounts: Schema.Array(ModelProxyAccount) }),
);
const isProxyError = Schema.is(ModelProxyError);
const decodeProfile = Schema.decodeUnknownEffect(
  Schema.Struct({ email: Schema.optional(Schema.String), id: Schema.optional(Schema.String) }),
);
const decodeDevice = Schema.decodeUnknownEffect(ProxyDeviceResponse);
const decodeDiscovery = Schema.decodeUnknownEffect(
  Schema.Struct({ device_authorization_endpoint: Schema.String, token_endpoint: Schema.String }),
);
interface PendingLogin {
  provider: typeof ModelProxyProvider.Type;
  state: string;
  url: string;
  expiresAt: number;
  verifier: string;
  status: "wait" | "ok" | "error";
  deviceCode?: string;
  tokenUrl?: string;
  interval?: number;
  nextPollAt?: number;
}

export class ModelProxy extends Context.Service<
  ModelProxy,
  {
    readonly manage: (
      input: ModelProxyManageInput,
    ) => Effect.Effect<ModelProxySnapshot, ModelProxyError>;
    readonly environment: (
      driver: ProviderDriverKind,
      base: NodeJS.ProcessEnv,
    ) => Effect.Effect<NodeJS.ProcessEnv, ModelProxyError>;
    readonly forward: (input: {
      path: string;
      method: string;
      apiKey: string;
      headers: Readonly<Record<string, string | undefined>>;
      payload: unknown;
    }) => Effect.Effect<HttpServerResponse.HttpServerResponse, ModelProxyError>;
  }
>()("t3/usage/ModelProxy") {}

/** @public Tests construct the service with isolated secret and HTTP layers. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const serviceScope = yield* Scope.Scope;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const crypto = yield* Crypto.Crypto;
  const http = yield* HttpClient.HttpClient;
  const googleClients = yield* Config.all({
    geminiId: Config.String("T3CODE_PROXY_GEMINI_OAUTH_CLIENT_ID").pipe(Config.withDefault("")),
    geminiSecret: Config.String("T3CODE_PROXY_GEMINI_OAUTH_CLIENT_SECRET").pipe(
      Config.withDefault(""),
    ),
    antigravityId: Config.String("T3CODE_PROXY_ANTIGRAVITY_OAUTH_CLIENT_ID").pipe(
      Config.withDefault(""),
    ),
    antigravitySecret: Config.String("T3CODE_PROXY_ANTIGRAVITY_OAUTH_CLIENT_SECRET").pipe(
      Config.withDefault(""),
    ),
  }).pipe(Effect.orDie);
  const oauthClients = {
    ...PROXY_OAUTH,
    gemini: {
      ...PROXY_OAUTH.gemini,
      clientId: googleClients.geminiId,
      clientSecret: googleClients.geminiSecret,
    },
    antigravity: {
      ...PROXY_OAUTH.antigravity,
      clientId: googleClients.antigravityId,
      clientSecret: googleClients.antigravitySecret,
    },
  };
  const writes = yield* Semaphore.make(1);
  const management = yield* Semaphore.make(1);
  const quotaRefresh = yield* Semaphore.make(1);
  const tokenLocks = new Map<string, Semaphore.Semaphore>();
  const pending = new Map<string, PendingLogin>();
  const receivers = new Map<string, Fiber.Fiber<unknown, unknown>>();
  const limits = new Map<string, ServerProviderUsageLimits>();
  const cooldowns = new Map<string, number>();
  const balancer = new ModelProxyBalancer();
  let state: typeof State.Type = { enabled: false, strategy: "round-robin", accounts: [] };
  let storageFailed = false;
  let key: string | undefined;
  // HTTP failures include authenticated requests; never serialize them across T3's wire.
  const storageError = () => new ModelProxyError({ operation: "storage" });
  const upstreamError = () => new ModelProxyError({ operation: "upstream" });
  // Extract only bounded diagnostics: HTTP errors can contain tokens in their request or body.
  const logFailure = (operation: "storage" | "upstream") => (cause: unknown) => {
    const httpError = HttpClientError.isHttpClientError(cause) ? cause : undefined;
    return Effect.logWarning("T3 Proxy operation failed").pipe(
      Effect.annotateLogs({
        operation,
        category: httpError ? httpError.reason._tag : "Failure",
        ...(httpError?.response ? { status: httpError.response.status } : {}),
      }),
    );
  };
  const storageFailure = (cause: unknown) =>
    logFailure("storage")(cause).pipe(Effect.andThen(Effect.fail(storageError())));
  const upstreamFailure = (cause: unknown) =>
    logFailure("upstream")(cause).pipe(Effect.andThen(Effect.fail(upstreamError())));
  const getKey = Effect.suspend(() =>
    key
      ? Effect.succeed(key)
      : secrets.getOrCreateRandom("model-proxy-api", 32).pipe(
          Effect.map((bytes) => {
            // A rotation may have populated the cache while this older read was in flight.
            key ??= Hex.encode(bytes);
            return key;
          }),
          Effect.catch(storageFailure),
        ),
  );
  const update = (change: (current: typeof State.Type) => typeof State.Type) =>
    Effect.gen(function* () {
      if (storageFailed) return yield* new ModelProxyError({ operation: "storage" });
      const next = change(state);
      const json = yield* encodeState(next).pipe(Effect.catch(storageFailure));
      yield* secrets
        .set("model-proxy-state", new TextEncoder().encode(json))
        .pipe(Effect.catch(storageFailure));
      state = next;
    }).pipe(writes.withPermits(1));
  yield* secrets.get("model-proxy-state").pipe(
    Effect.flatMap((saved) =>
      Option.isSome(saved)
        ? decodeState(new TextDecoder().decode(saved.value)).pipe(
            Effect.map((value) => {
              state = value;
            }),
          )
        : Effect.void,
    ),
    Effect.catch((cause) =>
      logFailure("storage")(cause).pipe(
        Effect.andThen(
          Effect.sync(() => {
            storageFailed = true;
          }),
        ),
      ),
    ),
  );
  const tokenRequest = (
    provider: typeof ModelProxyProvider.Type,
    data: Record<string, string>,
    tokenUrl = PROXY_OAUTH[provider].tokenUrl,
  ) => {
    const request = HttpClientRequest.post(tokenUrl);
    return http
      .execute(
        provider === "claude"
          ? HttpClientRequest.bodyJsonUnsafe(request, data)
          : HttpClientRequest.bodyUrlParams(request, data),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
        Effect.flatMap(decodeTokens),
        Effect.timeout("30 seconds"),
        Effect.catch(upstreamFailure),
        Effect.annotateLogs({ provider, stage: "token" }),
      );
  };
  const getAccountToken = Effect.fn("ModelProxy.getAccountToken")(function* (
    id: string,
    force = false,
  ) {
    let lock = tokenLocks.get(id);
    if (!lock) {
      lock = yield* Semaphore.make(1);
      tokenLocks.set(id, lock);
    }
    return yield* Effect.gen(function* () {
      const account = state.accounts.find((entry) => entry.id === id);
      if (!account || account.disabled)
        return yield* new ModelProxyError({ operation: "noAccounts" });
      const now = yield* Clock.currentTimeMillis;
      if (
        account.apiKey ||
        (!force && (account.expiresAt === 0 || account.expiresAt > now + 60_000))
      )
        return account;
      if (!account.refreshToken) return yield* new ModelProxyError({ operation: "upstream" });
      const oauth = oauthClients[account.provider];
      if (!oauth.clientId) return yield* new ModelProxyError({ operation: "oauthConfig" });
      const result = yield* tokenRequest(
        account.provider,
        {
          grant_type: "refresh_token",
          refresh_token: account.refreshToken,
          client_id: oauth.clientId,
          ...(oauth.clientSecret ? { client_secret: oauth.clientSecret } : {}),
          ...(account.provider === "claude" ? { scope: oauth.scope } : {}),
        },
        account.tokenUrl,
      );
      const next = {
        ...account,
        accessToken: result.access_token,
        refreshToken: result.refresh_token ?? account.refreshToken,
        expiresAt: now + (result.expires_in ?? 3600) * 1000,
      };
      yield* update((current) => ({
        ...current,
        accounts: current.accounts.map((entry) =>
          entry.id === id
            ? {
                ...entry,
                accessToken: next.accessToken,
                refreshToken: next.refreshToken,
                expiresAt: next.expiresAt,
              }
            : entry,
        ),
      }));
      const current = state.accounts.find((entry) => entry.id === id);
      if (!current || current.disabled)
        return yield* new ModelProxyError({ operation: "noAccounts" });
      return current;
    }).pipe(lock.withPermits(1));
  });
  const accountHeaders = (
    account: StoredAccount,
    incoming: Readonly<Record<string, string | undefined>> = {},
  ) => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${account.accessToken}`,
    };
    for (const name of [
      "session-id",
      "session_id",
      "thread-id",
      "x-opencode-session",
      "x-opencode-session-id",
      "x-session-affinity",
      "x-claude-code-session-id",
      "x-client-session-id",
    ]) {
      if (incoming[name]) headers[name] = incoming[name];
    }
    if (account.provider === "codex" && !account.apiKey) {
      headers["OpenAI-Beta"] = "responses=experimental";
      headers.Originator = "codex_cli_rs";
      if (account.accountId) headers["Chatgpt-Account-Id"] = account.accountId;
    }
    if (account.provider === "claude" || account.provider === "kimi") {
      headers["anthropic-version"] = incoming["anthropic-version"] ?? "2023-06-01";
      if (account.apiKey) {
        delete headers.Authorization;
        headers["x-api-key"] = account.accessToken;
      } else
        headers["anthropic-beta"] = [
          ...new Set([
            "oauth-2025-04-20",
            "claude-code-20250219",
            ...(incoming["anthropic-beta"] ?? "").split(",").filter(Boolean),
          ]),
        ].join(",");
      if (incoming["user-agent"]) headers["User-Agent"] = incoming["user-agent"];
    }
    if (account.provider === "gemini" && account.apiKey) {
      delete headers.Authorization;
      headers["x-goog-api-key"] = account.accessToken;
    }
    return headers;
  };
  const readLimits = Effect.fn("ModelProxy.readLimits")(function* (entry: StoredAccount) {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (
      entry.disabled ||
      entry.apiKey ||
      !["codex", "claude", "gemini", "antigravity"].includes(entry.provider)
    )
      return;
    const read = Effect.gen(function* () {
      const account = yield* getAccountToken(entry.id);
      if (account.provider === "gemini" || account.provider === "antigravity") {
        const raw = yield* http
          .execute(
            HttpClientRequest.post(
              `https://cloudcode-pa.googleapis.com/v1internal:${account.provider === "antigravity" ? "fetchAvailableModels" : "retrieveUserQuota"}`,
            ).pipe(
              HttpClientRequest.setHeaders(accountHeaders(account)),
              HttpClientRequest.bodyJsonUnsafe({ project: account.projectId }),
            ),
          )
          .pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap((response) => response.json),
            Effect.flatMap(Json),
          );
        const buckets: ProxyPayload[] = Array.isArray(raw.buckets)
          ? raw.buckets.map((bucket: unknown) => object(bucket))
          : Object.entries(object(raw.models)).map(([modelId, model]) => ({
              modelId,
              ...object(object(model).quotaInfo),
            }));
        const windows = buckets.flatMap((bucket) => {
          if (typeof bucket.remainingFraction !== "number") return [];
          const resetsAt =
            typeof bucket.resetTime === "string"
              ? Option.map(DateTime.make(bucket.resetTime), DateTime.formatIso).pipe(
                  Option.getOrUndefined,
                )
              : undefined;
          const id = String(bucket.modelId ?? "quota");
          return [
            {
              id,
              label: id,
              kind: "other" as const,
              usedPercent: Math.max(0, Math.min(100, (1 - bucket.remainingFraction) * 100)),
              ...(resetsAt ? { resetsAt } : {}),
            },
          ];
        });
        return { checkedAt, windows } satisfies ServerProviderUsageLimits;
      }
      const url =
        account.provider === "codex"
          ? "https://chatgpt.com/backend-api/wham/usage"
          : "https://api.anthropic.com/api/oauth/usage";
      const response = yield* http.get(url, { headers: accountHeaders(account) }).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.json),
      );
      if (account.provider === "claude") {
        const quota = yield* decodeClaudeUsage(response);
        return claudeUsageResponseToLimits({
          checkedAt,
          response: {
            rate_limits_available: true,
            rate_limits: { five_hour: quota.five_hour ?? null, seven_day: quota.seven_day ?? null },
          },
        }).limits;
      }
      const quota = yield* decodeUsage(response);
      const toWindow = (window: NonNullable<typeof quota.rate_limit>["primary_window"]) =>
        window
          ? {
              usedPercent: window.used_percent,
              resetsAt: window.reset_at ?? null,
              ...(window.limit_window_seconds !== undefined
                ? { windowDurationMins: window.limit_window_seconds / 60 }
                : {}),
            }
          : null;
      return codexRateLimitsToLimits({
        checkedAt,
        snapshot: {
          primary: toWindow(quota.rate_limit?.primary_window),
          secondary: toWindow(quota.rate_limit?.secondary_window),
          planType: quota.plan_type ?? null,
        },
      });
    });
    yield* read.pipe(
      Effect.timeout("15 seconds"),
      Effect.tapError(logFailure("upstream")),
      Effect.match({
        onSuccess: (quota) => {
          if (quota) limits.set(entry.id, quota);
        },
        onFailure: () => {
          const previous = limits.get(entry.id);
          limits.set(entry.id, {
            checkedAt,
            windows: previous?.windows ?? [],
            unavailable: {
              reason: "probeFailed",
              message: "Could not refresh this account's quota.",
            },
          });
        },
      }),
      Effect.annotateLogs({ provider: entry.provider, stage: "quota" }),
    );
  });
  const refreshAccounts = Effect.fn("ModelProxy.refreshAccounts")(function* (force: boolean) {
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.forEach(
      state.accounts.filter((account) => {
        const checkedAt = limits.get(account.id)?.checkedAt;
        return force || !checkedAt || now - Date.parse(checkedAt) >= 5 * 60_000;
      }),
      readLimits,
      { concurrency: 4, discard: true },
    );
  }, quotaRefresh.withPermits(1));
  const snapshot = Effect.gen(function* (): Effect.fn.Return<ModelProxySnapshot> {
    const now = yield* Clock.currentTimeMillis;
    balancer.prune(now, (state.stickyIdleMinutes ?? 12) * 60_000);
    const remote =
      state.client?.type === "remote"
        ? yield* http
            .get(`${state.client.url}/v1/t3/quota`, {
              headers: { Authorization: `Bearer ${state.client.apiKey}` },
            })
            .pipe(
              Effect.flatMap(HttpClientResponse.filterStatusOk),
              Effect.flatMap((response) => response.json),
              Effect.flatMap(decodeRemoteAccounts),
              Effect.timeout("10 seconds"),
              Effect.result,
            )
        : undefined;
    const remoteAccounts = remote?._tag === "Success" ? remote.success.accounts : undefined;
    return {
      enabled: state.enabled,
      status: storageFailed ? "failed" : state.enabled ? "running" : "stopped",
      version: "built-in",
      endpointPath: `${MODEL_PROXY_PATH}/v1`,
      strategy: state.strategy === "fill-first" ? "closest-reset" : state.strategy,
      stickyIdleMinutes: state.stickyIdleMinutes ?? 12,
      checkedAt: DateTime.formatIso(yield* DateTime.now),
      client: {
        configured: !!state.client,
        local: state.client?.type === "local",
        ...(state.client?.type === "remote" ? { url: state.client.url } : {}),
      },
      accounts:
        state.client?.type === "remote"
          ? (remoteAccounts ?? [])
          : state.accounts.map((account): ModelProxyAccount => ({
              id: account.id,
              name: account.name,
              provider: account.provider,
              disabled: account.disabled,
              activeSessions: balancer.activeSessions(account.id),
              ...(account.email ? { email: account.email } : {}),
              status: account.disabled
                ? "disabled"
                : [...cooldowns].some(
                      ([key, until]) => key.startsWith(`${account.id}:`) && until > now,
                    )
                  ? "cooldown"
                  : "ready",
              ...(limits.has(account.id) ? { usageLimits: limits.get(account.id)! } : {}),
            })),
      ...(storageFailed
        ? { error: "Could not read proxy credentials. Existing data has been preserved." }
        : remote?._tag === "Failure"
          ? { error: "The configured proxy server is unavailable." }
          : {}),
    };
  });
  const saveTokens = Effect.fn("ModelProxy.saveTokens")(function* (
    provider: typeof ModelProxyProvider.Type,
    tokens: typeof ProxyTokenResponse.Type,
    tokenUrl?: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const id = yield* crypto.randomUUIDv4.pipe(Effect.catch(storageFailure));
    const claims = yield* Effect.try({
      try: () => (tokens.id_token ? decodeJwt(tokens.id_token) : {}),
      catch: upstreamError,
    }).pipe(
      Effect.flatMap(decodeClaims),
      Effect.orElseSucceed(() => ({}) as typeof Claims.Type),
    );
    let email = tokens.account?.email_address ?? claims.email;
    let subject = tokens.account?.uuid ?? claims.sub;
    let projectId: string | undefined;
    if (provider === "gemini" || provider === "antigravity") {
      const profile = yield* http
        .get("https://www.googleapis.com/oauth2/v2/userinfo", {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        })
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((r) => r.json),
          Effect.flatMap(decodeProfile),
          Effect.catch(upstreamFailure),
        );
      email = profile.email;
      subject = profile.id;
      const assist = yield* http
        .execute(
          HttpClientRequest.post(
            "https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist",
          ).pipe(
            HttpClientRequest.setHeader("Authorization", `Bearer ${tokens.access_token}`),
            HttpClientRequest.bodyJsonUnsafe({
              metadata: {
                ideType: "GEMINI_CLI",
                platform: "PLATFORM_UNSPECIFIED",
                pluginType: "GEMINI",
              },
            }),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((r) => r.json),
          Effect.flatMap(Json),
          Effect.catch(upstreamFailure),
        );
      projectId =
        typeof assist.cloudaicompanionProject === "string"
          ? assist.cloudaicompanionProject
          : typeof object(assist.cloudaicompanionProject).id === "string"
            ? String(object(assist.cloudaicompanionProject).id)
            : undefined;
      if (!projectId) {
        const tier = Array.isArray(assist.allowedTiers)
          ? assist.allowedTiers
              .map((value: unknown) => object(value))
              .find((tier) => tier.isDefault === true)
          : undefined;
        const metadata =
          provider === "antigravity"
            ? { ide_type: "ANTIGRAVITY", ide_name: "antigravity" }
            : { ideType: "GEMINI_CLI", platform: "PLATFORM_UNSPECIFIED", pluginType: "GEMINI" };
        for (let attempt = 0; attempt < 5 && !projectId; attempt++) {
          const onboard = yield* http
            .execute(
              HttpClientRequest.post(
                `https://${provider === "antigravity" ? "daily-" : ""}cloudcode-pa.googleapis.com/v1internal:onboardUser`,
              ).pipe(
                HttpClientRequest.setHeader("Authorization", `Bearer ${tokens.access_token}`),
                HttpClientRequest.bodyJsonUnsafe({
                  tierId: tier?.id ?? "free-tier",
                  tier_id: tier?.id ?? "free-tier",
                  metadata,
                }),
              ),
            )
            .pipe(
              Effect.flatMap(HttpClientResponse.filterStatusOk),
              Effect.flatMap((response) => response.json),
              Effect.flatMap(Json),
              Effect.timeout("30 seconds"),
              Effect.catch(upstreamFailure),
            );
          const project =
            object(onboard.response).cloudaicompanionProject ?? onboard.cloudaicompanionProject;
          projectId =
            typeof project === "string"
              ? project
              : typeof object(project).id === "string"
                ? String(object(project).id)
                : undefined;
          if (!projectId && attempt < 4) yield* Effect.sleep("2 seconds");
        }
        if (!projectId) return yield* new ModelProxyError({ operation: "upstream" });
      }
    }
    const existing = subject
      ? state.accounts.find(
          (account) => account.provider === provider && account.subject === subject,
        )
      : undefined;
    const account: StoredAccount = {
      id: existing?.id ?? id,
      name: existing?.name ?? `${provider}-${id}.json`,
      provider,
      disabled: existing?.disabled ?? false,
      accessToken: tokens.access_token,
      apiKey: false,
      expiresAt: now + (tokens.expires_in ?? 3600) * 1000,
      ...((tokens.refresh_token ?? existing?.refreshToken)
        ? { refreshToken: tokens.refresh_token ?? existing?.refreshToken }
        : {}),
      ...(email ? { email } : {}),
      ...(subject ? { subject } : {}),
      ...(claims["https://api.openai.com/auth"]?.chatgpt_account_id
        ? { accountId: claims["https://api.openai.com/auth"]!.chatgpt_account_id }
        : {}),
      ...(projectId ? { projectId } : {}),
      ...(tokenUrl ? { tokenUrl } : {}),
    };
    yield* update((current) => ({
      ...current,
      accounts: [...current.accounts.filter((entry) => entry.id !== account.id), account],
    }));
    yield* readLimits(account);
  });
  const oauthSnapshot = (login: PendingLogin) =>
    snapshot.pipe(
      Effect.map((value) => ({
        ...value,
        oauth: {
          provider: login.provider,
          url: login.url,
          state: login.state,
          status: login.status,
        },
      })),
    );
  const completeAuth = Effect.fn("ModelProxy.completeAuth")(function* (
    login: PendingLogin,
    redirectUrl: string,
  ) {
    if (
      login.status !== "wait" ||
      login.expiresAt < (yield* Clock.currentTimeMillis) ||
      !pending.has(login.state)
    )
      return yield* new ModelProxyError({ operation: "callback" });
    const callback = yield* Effect.try({
      try: () => new URL(redirectUrl),
      catch: () => new ModelProxyError({ operation: "callback" }),
    });
    const code = callback.searchParams.get("code");
    if (callback.searchParams.get("state") !== login.state || !code)
      return yield* new ModelProxyError({ operation: "callback" });
    const definition = oauthClients[login.provider];
    const tokens = yield* tokenRequest(login.provider, {
      grant_type: "authorization_code",
      client_id: definition.clientId,
      code,
      code_verifier: login.verifier,
      redirect_uri: definition.redirectUri!,
      ...(definition.clientSecret ? { client_secret: definition.clientSecret } : {}),
      ...(login.provider === "claude" ? { state: login.state } : {}),
    });
    yield* saveTokens(login.provider, tokens);
    login.status = "ok";
  });
  const startAuth = Effect.fn("ModelProxy.startAuth")(function* (
    provider: typeof ModelProxyProvider.Type,
  ) {
    const now = yield* Clock.currentTimeMillis;
    for (const [id, flow] of pending)
      if (flow.expiresAt < now) {
        pending.delete(id);
        receivers.delete(id);
      }
    if ([...pending.values()].filter((flow) => flow.status === "wait").length >= 10)
      return yield* new ModelProxyError({ operation: "management" });
    const state = Hex.encode(yield* crypto.randomBytes(32).pipe(Effect.catch(storageFailure)));
    const verifier = Hex.encode(yield* crypto.randomBytes(32).pipe(Effect.catch(storageFailure)));
    const definition = oauthClients[provider];
    if (!definition.clientId) return yield* new ModelProxyError({ operation: "oauthConfig" });
    const login: PendingLogin = {
      provider,
      state,
      verifier,
      status: "wait",
      url: "",
      expiresAt: now + 10 * 60_000,
    };
    if (definition.authorizeUrl && definition.redirectUri) {
      const digest = yield* crypto
        .digest("SHA-256", new TextEncoder().encode(verifier))
        .pipe(Effect.catch(storageFailure));
      const challenge = btoa(String.fromCharCode(...digest))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/u, "");
      const url = new URL(definition.authorizeUrl);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: definition.clientId,
        redirect_uri: definition.redirectUri,
        scope: definition.scope,
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
        ...(provider === "codex"
          ? {
              id_token_add_organizations: "true",
              codex_cli_simplified_flow: "true",
              prompt: "login",
            }
          : {}),
        ...(provider === "gemini" || provider === "antigravity"
          ? { access_type: "offline", prompt: "consent" }
          : {}),
      }).toString();
      login.url = url.toString();
    } else {
      let deviceUrl = definition.deviceUrl;
      let tokenUrl = definition.tokenUrl;
      if (definition.discoveryUrl) {
        const discovery = yield* http.get(definition.discoveryUrl).pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((r) => r.json),
          Effect.flatMap(decodeDiscovery),
          Effect.catch(upstreamFailure),
        );
        if (
          ![discovery.device_authorization_endpoint, discovery.token_endpoint].every(
            (url) => new URL(url).origin === "https://auth.x.ai",
          )
        )
          return yield* new ModelProxyError({ operation: "upstream" });
        deviceUrl = discovery.device_authorization_endpoint;
        tokenUrl = discovery.token_endpoint;
      }
      if (!deviceUrl) return yield* new ModelProxyError({ operation: "unsupported" });
      const response = yield* http
        .execute(
          HttpClientRequest.post(deviceUrl).pipe(
            HttpClientRequest.bodyUrlParams({
              client_id: definition.clientId,
              ...(definition.scope ? { scope: definition.scope } : {}),
            }),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap((r) => r.json),
          Effect.flatMap(decodeDevice),
          Effect.catch(upstreamFailure),
        );
      login.deviceCode = response.device_code;
      login.tokenUrl = tokenUrl;
      login.interval = Math.max(5, response.interval ?? 5) * 1000;
      login.expiresAt = now + Math.min(1800, response.expires_in ?? 600) * 1000;
      login.url =
        response.verification_uri_complete ??
        `${response.verification_uri}${response.verification_uri.includes("?") ? "&" : "?"}user_code=${encodeURIComponent(response.user_code)}`;
    }
    pending.set(state, login);
    if (definition.redirectUri) {
      const fiber = yield* receiveProxyCallback(definition.redirectUri, state).pipe(
        Effect.flatMap((url) =>
          completeAuth(login, url).pipe(
            Effect.tapError(() =>
              Effect.sync(() => {
                login.status = "error";
              }),
            ),
            management.withPermits(1),
          ),
        ),
        Effect.timeout("10 minutes"),
        Effect.ignore,
        Effect.scoped,
        Effect.forkIn(serviceScope),
      );
      receivers.set(state, fiber);
    }
    return yield* oauthSnapshot(login);
  });
  const manage = Effect.fn("ModelProxy.manage")(function* (input: ModelProxyManageInput) {
    switch (input.action) {
      case "status":
        break;
      case "start":
        yield* update((current) => ({ ...current, enabled: true, client: { type: "local" } }));
        yield* refreshAccounts(false);
        break;
      case "stop":
        yield* update(({ client: _client, ...current }) => ({ ...current, enabled: false }));
        balancer.clear();
        break;
      case "refresh":
        if (state.client?.type === "remote")
          yield* http
            .get(`${state.client.url}/v1/t3/quota/refresh`, {
              headers: { Authorization: `Bearer ${state.client.apiKey}` },
            })
            .pipe(
              Effect.flatMap(HttpClientResponse.filterStatusOk),
              Effect.flatMap((response) => Stream.runDrain(response.stream)),
              Effect.timeout("30 seconds"),
              Effect.catch(upstreamFailure),
            );
        else yield* refreshAccounts(true);
        break;
      case "setStrategy":
        yield* update((current) => ({ ...current, strategy: input.strategy }));
        break;
      case "setStickyIdleMinutes":
        yield* update((current) => ({ ...current, stickyIdleMinutes: input.minutes }));
        balancer.prune(yield* Clock.currentTimeMillis, input.minutes * 60_000);
        break;
      case "revealKey":
        return { ...(yield* snapshot), apiKey: yield* getKey };
      case "rotateKey": {
        const bytes = yield* crypto.randomBytes(32).pipe(Effect.catch(storageFailure));
        yield* secrets.set("model-proxy-api", bytes).pipe(Effect.catch(storageFailure));
        key = Hex.encode(bytes);
        return { ...(yield* snapshot), apiKey: key };
      }
      case "useLocal":
        if (!state.enabled) return yield* new ModelProxyError({ operation: "disabled" });
        yield* update((current) => ({ ...current, client: { type: "local" } }));
        break;
      case "configureClient": {
        const urls = yield* Effect.forEach(
          [input.url, ...(input.fallbackUrls ?? [])],
          (candidate) =>
            Effect.gen(function* () {
              const url = yield* Effect.try({
                try: () => new URL(candidate),
                catch: () => new ModelProxyError({ operation: "management" }),
              });
              if (
                !["http:", "https:"].includes(url.protocol) ||
                url.username ||
                url.password ||
                url.search ||
                url.hash
              )
                return yield* new ModelProxyError({ operation: "management" });
              url.pathname =
                url.pathname.replace(/\/$/u, "").replace(/\/v1$/u, "") || MODEL_PROXY_PATH;
              return url.toString().replace(/\/$/u, "");
            }),
        );
        let selected: string | undefined;
        for (const url of new Set(urls)) {
          const reachable = yield* http
            .get(`${url}/v1/models`, {
              headers: { Authorization: `Bearer ${input.apiKey}` },
            })
            .pipe(
              Effect.flatMap(HttpClientResponse.filterStatusOk),
              Effect.flatMap((response) => Stream.runDrain(response.stream)),
              Effect.timeout("10 seconds"),
              Effect.as(true),
              // An HTTP rejection must not trigger fallback or a protocol downgrade.
              Effect.catchTags({
                HttpClientError: (error) =>
                  error.reason._tag === "TransportError"
                    ? logFailure("upstream")(error).pipe(Effect.as(false))
                    : upstreamFailure(error),
                TimeoutError: (error) => logFailure("upstream")(error).pipe(Effect.as(false)),
              }),
            );
          if (reachable) {
            selected = url;
            break;
          }
        }
        if (!selected) return yield* new ModelProxyError({ operation: "upstream" });
        yield* update((current) => ({
          ...current,
          enabled: false,
          client: { type: "remote", url: selected, apiKey: input.apiKey },
        }));
        break;
      }
      case "disconnectClient":
        yield* update(({ client: _client, ...current }) => current);
        break;
      case "setAccountEnabled":
        if (!state.accounts.some((account) => account.name === input.name))
          return yield* new ModelProxyError({ operation: "noAccounts" });
        yield* update((current) => ({
          ...current,
          accounts: current.accounts.map((entry) =>
            entry.name === input.name ? { ...entry, disabled: !input.enabled } : entry,
          ),
        }));
        if (!input.enabled) {
          const account = state.accounts.find((entry) => entry.name === input.name);
          if (account) balancer.invalidate(account.id);
        }
        break;
      case "removeAccount":
        for (const account of state.accounts) {
          if (account.name === input.name) {
            balancer.invalidate(account.id);
            limits.delete(account.id);
            tokenLocks.delete(account.id);
            for (const key of cooldowns.keys())
              if (key.startsWith(`${account.id}:`)) cooldowns.delete(key);
          }
        }
        yield* update((current) => ({
          ...current,
          accounts: current.accounts.filter((entry) => entry.name !== input.name),
        }));
        break;
      case "importAccount": {
        const raw = {
          ...input.credential,
          ...object(input.credential.token),
          ...object(input.credential.tokens),
        };
        const imported = yield* decodeImportedToken(raw).pipe(Effect.catch(upstreamFailure));
        const provider = yield* decodeProvider(imported.provider ?? imported.type).pipe(
          Effect.mapError(() => new ModelProxyError({ operation: "unsupported" })),
        );
        const accessToken = imported.api_key ?? imported.access_token;
        if (!accessToken && !imported.refresh_token)
          return yield* new ModelProxyError({ operation: "management" });
        const id = yield* crypto.randomUUIDv4.pipe(Effect.catch(storageFailure));
        const expiresAt =
          imported.expiry_date ??
          (imported.expired
            ? Date.parse(imported.expired)
            : imported.refresh_token && !accessToken
              ? 1
              : 0);
        if (!Number.isFinite(expiresAt))
          return yield* new ModelProxyError({ operation: "management" });
        const claims = yield* Effect.try({
          try: () => (imported.id_token ? decodeJwt(imported.id_token) : {}),
          catch: upstreamError,
        }).pipe(
          Effect.flatMap(decodeClaims),
          Effect.orElseSucceed(() => ({}) as typeof Claims.Type),
        );
        const accountId =
          imported.account_id ?? claims["https://api.openai.com/auth"]?.chatgpt_account_id;
        const email = imported.email ?? claims.email;
        const account: StoredAccount = {
          id,
          name: input.name,
          provider,
          accessToken: accessToken ?? "",
          disabled: false,
          apiKey: !!imported.api_key,
          expiresAt,
          ...(imported.refresh_token ? { refreshToken: imported.refresh_token } : {}),
          ...(email ? { email } : {}),
          ...(accountId ? { accountId } : {}),
          ...(imported.project_id ? { projectId: imported.project_id } : {}),
        };
        if (state.accounts.some((entry) => entry.name === input.name))
          return yield* new ModelProxyError({ operation: "management" });
        yield* update((current) => ({ ...current, accounts: [...current.accounts, account] }));
        yield* readLimits(account);
        break;
      }
      case "authStart":
        return yield* startAuth(input.provider);
      case "authCancel":
        pending.delete(input.state);
        if (receivers.has(input.state)) yield* Fiber.interrupt(receivers.get(input.state)!);
        receivers.delete(input.state);
        break;
      case "authComplete": {
        const login = pending.get(input.state);
        const now = yield* Clock.currentTimeMillis;
        if (
          !login ||
          login.provider !== input.provider ||
          login.status !== "wait" ||
          login.expiresAt < now ||
          login.deviceCode
        )
          return yield* new ModelProxyError({ operation: "callback" });
        yield* completeAuth(login, input.redirectUrl);
        if (receivers.has(input.state)) yield* Fiber.interrupt(receivers.get(input.state)!);
        receivers.delete(input.state);
        return yield* oauthSnapshot(login);
      }
      case "authStatus": {
        const login = pending.get(input.state);
        const now = yield* Clock.currentTimeMillis;
        if (!login || login.provider !== input.provider)
          return yield* new ModelProxyError({ operation: "callback" });
        if (login.expiresAt < now) login.status = "error";
        if (login.status === "wait" && login.deviceCode && now >= (login.nextPollAt ?? 0)) {
          login.nextPollAt = now + (login.interval ?? 5000);
          const response = yield* http
            .execute(
              HttpClientRequest.post(login.tokenUrl!).pipe(
                HttpClientRequest.bodyUrlParams({
                  grant_type: "urn:ietf:params:oauth:grant-type:device_code",
                  client_id: oauthClients[login.provider].clientId,
                  device_code: login.deviceCode,
                }),
              ),
            )
            .pipe(
              Effect.flatMap((r) => r.json),
              Effect.flatMap(Json),
              Effect.catch(upstreamFailure),
            );
          if (response.error === "slow_down") login.interval = (login.interval ?? 5000) + 5000;
          else if (response.error && response.error !== "authorization_pending")
            login.status = "error";
          else if (response.access_token) {
            const tokens = yield* decodeTokens(response).pipe(Effect.catch(upstreamFailure));
            yield* saveTokens(login.provider, tokens, login.tokenUrl);
            login.status = "ok";
          }
        }
        return yield* oauthSnapshot(login);
      }
    }
    return yield* snapshot;
  }, management.withPermits(1));

  const environment = Effect.fn("ModelProxy.environment")(function* (
    driver: ProviderDriverKind,
    base: NodeJS.ProcessEnv,
  ) {
    const supported = driver === "codex" || driver === "claudeAgent" || driver === "opencode";
    // Cursor, Grok's proprietary ACP CLI, Antigravity, and arbitrary ACP agents do not
    // expose a shared launch-only API override. Keep their own runtimes unchanged.
    if (!state.client || !supported) return base;
    if (storageFailed) return yield* new ModelProxyError({ operation: "storage" });
    if (state.client.type === "local" && !state.enabled)
      return yield* new ModelProxyError({ operation: "disabled" });
    const apiKey = state.client.type === "remote" ? state.client.apiKey : yield* getKey;
    const url =
      state.client.type === "remote"
        ? state.client.url
        : `http://${formatHostForUrl(config.host && !isWildcardHost(config.host) ? config.host : "127.0.0.1")}:${config.port}${MODEL_PROXY_PATH}`;
    if (driver === "claudeAgent")
      return {
        ...base,
        ANTHROPIC_BASE_URL: url,
        ANTHROPIC_AUTH_TOKEN: apiKey,
        ANTHROPIC_API_KEY: "",
        CLAUDE_CODE_OAUTH_TOKEN: "",
      };
    if (driver === "opencode") {
      const content = yield* decodeJsonPayload(base.OPENCODE_CONFIG_CONTENT ?? "{}").pipe(
        Effect.catch(storageFailure),
      );
      const provider = { ...object(content.provider) };
      for (const name of ["openai", "anthropic", "google", "xai", "kimi-for-coding"]) {
        const existing = object(provider[name]);
        provider[name] = {
          ...existing,
          options: {
            ...object(existing.options),
            baseURL: `${url}/${name === "google" ? "v1beta" : "v1"}`,
            apiKey,
          },
        };
      }
      const json = yield* encodeJsonPayload({
        ...content,
        provider,
      }).pipe(Effect.catch(storageFailure));
      return { ...base, OPENCODE_CONFIG_CONTENT: json };
    }
    // Config overrides travel only in the app-server/exec argv. No config.toml is edited.
    const proxyConfig = [
      "--config",
      'model_provider="t3_proxy"',
      "--config",
      'model_providers.t3_proxy.name="T3 Proxy"',
      "--config",
      `model_providers.t3_proxy.base_url=${yield* encodeJsonString(`${url}/v1`).pipe(Effect.catch(storageFailure))}`,
      "--config",
      'model_providers.t3_proxy.wire_api="responses"',
      "--config",
      'model_providers.t3_proxy.env_key="T3CODE_PROXY_API_KEY"',
      "--config",
      "model_providers.t3_proxy.requires_openai_auth=false",
    ];
    const escaped = proxyConfig.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
    return {
      ...base,
      T3CODE_PROXY_API_KEY: apiKey,
      T3CODE_CODEX_LAUNCH_ARGS: `${base.T3CODE_CODEX_LAUNCH_ARGS ?? ""} ${escaped}`.trim(),
    };
  });

  const forward = Effect.fn("ModelProxy.forward")(function* (
    input: Parameters<ModelProxy["Service"]["forward"]>[0],
  ) {
    if (!state.enabled) return yield* new ModelProxyError({ operation: "disabled" });
    const expected = yield* getKey;
    const suppliedDigest = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(input.apiKey))
      .pipe(Effect.catch(upstreamFailure));
    const expectedDigest = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(expected))
      .pipe(Effect.catch(upstreamFailure));
    let difference = 0;
    for (let i = 0; i < expectedDigest.length; i++)
      difference |= expectedDigest[i]! ^ suppliedDigest[i]!;
    if (difference !== 0) return yield* new ModelProxyError({ operation: "unauthorized" });
    const pathname = input.path.split("?", 1)[0];
    if (pathname === "/v1/t3/quota" && input.method === "GET")
      return HttpServerResponse.jsonUnsafe(yield* snapshot);
    if (pathname === "/v1/t3/quota/refresh" && input.method === "GET") {
      yield* refreshAccounts(true);
      return HttpServerResponse.jsonUnsafe(yield* snapshot);
    }
    if (pathname === "/v1/models" && input.method === "GET") {
      const data = yield* Effect.forEach(
        state.accounts.filter((account) => !account.disabled),
        (entry) =>
          Effect.gen(function* () {
            const account = yield* getAccountToken(entry.id);
            const url =
              account.provider === "codex"
                ? account.apiKey
                  ? "https://api.openai.com/v1/models"
                  : "https://chatgpt.com/backend-api/codex/models?client_version=0.156.1"
                : account.provider === "claude"
                  ? "https://api.anthropic.com/v1/models"
                  : account.provider === "kimi"
                    ? "https://api.kimi.com/coding/v1/models"
                    : account.provider === "xai"
                      ? "https://api.x.ai/v1/models"
                      : "https://generativelanguage.googleapis.com/v1beta/models";
            const googleOAuth =
              (account.provider === "gemini" || account.provider === "antigravity") &&
              !account.apiKey;
            const discovery = googleOAuth
              ? http.execute(
                  HttpClientRequest.post(
                    "https://cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels",
                  ).pipe(
                    HttpClientRequest.setHeaders(accountHeaders(account)),
                    HttpClientRequest.bodyJsonUnsafe({ project: account.projectId }),
                  ),
                )
              : http.get(url, { headers: accountHeaders(account) });
            const raw = yield* discovery.pipe(
              Effect.flatMap(HttpClientResponse.filterStatusOk),
              Effect.flatMap((r) => r.json),
              Effect.flatMap(Json),
              Effect.catch(upstreamFailure),
            );
            const rows = Array.isArray(raw.data)
              ? raw.data
              : Array.isArray(raw.models)
                ? raw.models
                : Object.entries(object(raw.models)).map(([id, item]) => ({ ...object(item), id }));
            return rows.flatMap((row: unknown) => {
              const item = object(row);
              const id = item.id ?? item.slug ?? item.name;
              return typeof id === "string"
                ? [
                    {
                      id:
                        account.provider === "antigravity"
                          ? `antigravity/${id.replace(/^models\//u, "")}`
                          : id.replace(/^models\//u, ""),
                      object: "model",
                      owned_by: account.provider,
                    },
                  ]
                : [];
            });
          }).pipe(Effect.orElseSucceed(() => [])),
        { concurrency: 4 },
      );
      const unique = new Map(data.flat().map((model) => [model.id, model]));
      return HttpServerResponse.jsonUnsafe({ object: "list", data: [...unique.values()] });
    }
    if (input.method !== "POST") return yield* new ModelProxyError({ operation: "unsupported" });
    const payload = yield* Json(input.payload).pipe(Effect.catch(upstreamFailure));
    const model =
      typeof payload.model === "string"
        ? payload.model
        : /\/models\/([^:]+)/u.exec(input.path)?.[1];
    if (!model) return yield* new ModelProxyError({ operation: "unsupported" });
    const provider = proxyProviderForModel(model);
    const now = yield* Clock.currentTimeMillis;
    const rawSession = proxySessionId(input.headers, payload);
    const session = rawSession
      ? Hex.encode(
          yield* crypto
            .digest("SHA-256", new TextEncoder().encode(rawSession))
            .pipe(Effect.catch(upstreamFailure)),
        )
      : null;
    const candidates = state.accounts.filter(
      (entry) =>
        entry.provider === provider &&
        !entry.disabled &&
        !proxyQuotaExhausted(proxyModelQuota(limits.get(entry.id), provider, model), now) &&
        (cooldowns.get(`${entry.id}:${model}`) ?? 0) <= now,
    );
    const attempted = new Set<string>();
    for (let attempt = 0; attempt < candidates.length; attempt++) {
      const reservation = balancer.acquire({
        provider,
        session,
        candidates: candidates
          .filter((entry) => !attempted.has(entry.id))
          .map((entry) => ({
            id: entry.id,
            nextReset: proxyNextReset(proxyModelQuota(limits.get(entry.id), provider, model), now),
          })),
        strategy: state.strategy === "fill-first" ? "closest-reset" : state.strategy,
        now,
        idleMs: (state.stickyIdleMinutes ?? 12) * 60_000,
      });
      if (!reservation) break;
      attempted.add(reservation.accountId);
      const entry = candidates.find((account) => account.id === reservation.accountId)!;
      let streamingResponse = false;
      let succeeded = false;
      const finish = (success: boolean) =>
        Clock.currentTimeMillis.pipe(
          Effect.tap((time) => Effect.sync(() => reservation.finish(time, success))),
          Effect.asVoid,
        );
      const responseStream = <E, R>(stream: Stream.Stream<Uint8Array, E, R>) => {
        streamingResponse = true;
        return stream.pipe(
          Stream.tapError(() =>
            Effect.sync(() => {
              succeeded = false;
            }),
          ),
          // Cancellation keeps the binding; upstream and translation errors release it.
          Stream.ensuring(Effect.suspend(() => finish(succeeded))),
        );
      };
      const attemptResponse = yield* Effect.gen(function* () {
        const accountResult = yield* getAccountToken(entry.id).pipe(Effect.result);
        if (accountResult._tag === "Failure") return null;
        let account = accountResult.success;
        const prepared = yield* Effect.try({
          try: () => prepareProxyRequest(provider, account.apiKey, input.path, payload),
          catch: (cause) => (isProxyError(cause) ? cause : upstreamError()),
        });
        // OAuth token counting uses a plain request, without generation metadata.
        const body: typeof ProxyPayload.Type =
          (provider === "gemini" || provider === "antigravity") &&
          !account.apiKey &&
          prepared.translation !== "native"
            ? {
                ...prepared.body,
                project: account.projectId,
                ...(provider === "antigravity"
                  ? {
                      userAgent: "antigravity",
                      requestType: model.includes("image") ? "image_gen" : "agent",
                      requestId: yield* crypto.randomUUIDv4.pipe(Effect.catch(storageFailure)),
                    }
                  : {}),
              }
            : prepared.body;
        const send = () =>
          http
            .execute(
              HttpClientRequest.post(prepared.url).pipe(
                HttpClientRequest.setHeaders(accountHeaders(account, input.headers)),
                HttpClientRequest.bodyJsonUnsafe(body),
              ),
            )
            .pipe(Effect.catch(upstreamFailure));
        const sent = yield* send().pipe(Effect.result);
        if (sent._tag === "Failure") return null;
        let response = sent.success;
        if (response.status === 401 && account.refreshToken) {
          yield* Stream.runDrain(response.stream).pipe(Effect.ignore);
          const renewed = yield* getAccountToken(account.id, true).pipe(Effect.result);
          if (renewed._tag === "Failure") return null;
          account = renewed.success;
          const retried = yield* send().pipe(Effect.result);
          if (retried._tag === "Failure") return null;
          response = retried.success;
        }
        if (response.status === 401 || response.status === 429 || response.status >= 500) {
          const retry = Number(response.headers["retry-after"]);
          cooldowns.set(
            `${account.id}:${model}`,
            now + (Number.isFinite(retry) && retry > 0 ? Math.min(retry, 3600) : 60) * 1000,
          );
          balancer.invalidate(account.id);
          yield* Stream.runDrain(response.stream).pipe(Effect.ignore);
          return null;
        }
        // Codex's subscription endpoint can omit Content-Type even for its forced SSE.
        const contentType =
          response.headers["content-type"] ??
          (provider === "codex" && !account.apiKey && body.stream === true
            ? "text/event-stream"
            : "application/json");
        if (response.status >= 400)
          return HttpServerResponse.stream(responseStream(response.stream), {
            status: response.status,
            contentType,
          });
        succeeded = true;
        const streaming = payload.stream === true || input.path.includes("streamGenerateContent");
        const upstreamStreaming = contentType.includes("text/event-stream");
        if (prepared.translation === "native" && (!upstreamStreaming || streaming))
          return HttpServerResponse.stream(responseStream(response.stream), {
            status: response.status,
            contentType,
            headers: { "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
          });
        if (upstreamStreaming && streaming) {
          const translate = makeProxyStreamTranslator(prepared.translation, model);
          const stream = response.stream.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.filter((line) => line.startsWith("data: ") && line.slice(6) !== "[DONE]"),
            Stream.mapEffect((line) => decodeJsonPayload(line.slice(6))),
            Stream.map(translate),
            Stream.filter((chunk) => chunk.length > 0),
            Stream.encodeText,
          );
          return HttpServerResponse.stream(responseStream(stream), {
            contentType: "text/event-stream",
            headers: { "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
          });
        }
        let raw: typeof ProxyPayload.Type;
        if (upstreamStreaming) {
          const collected = yield* response.stream.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.filter((line) => line.startsWith("data: ") && line.slice(6) !== "[DONE]"),
            Stream.mapEffect((line) => decodeJsonPayload(line.slice(6))),
            Stream.runFold(
              () => ({ response: {} as ProxyPayload, output: new Map<number, ProxyPayload>() }),
              (previous, event) => {
                if (
                  event.type === "response.output_item.done" &&
                  typeof event.output_index === "number"
                )
                  previous.output.set(event.output_index, object(event.item));
                if (event.type === "response.completed" || event.type === "response.incomplete")
                  previous.response = object(event.response);
                return previous;
              },
            ),
            Effect.catch(upstreamFailure),
          );
          // Some Codex backends send output only in item events, leaving terminal output empty.
          raw = {
            ...collected.response,
            output:
              Array.isArray(collected.response.output) && collected.response.output.length
                ? collected.response.output
                : [...collected.output]
                    .sort(([left], [right]) => left - right)
                    .map(([, item]) => item),
          };
          if (!raw.id) return yield* new ModelProxyError({ operation: "upstream" });
        } else raw = yield* response.json.pipe(Effect.flatMap(Json), Effect.catch(upstreamFailure));
        return HttpServerResponse.jsonUnsafe(proxyChatResponse(prepared.translation, raw, model));
      }).pipe(
        Effect.onExit((exit) =>
          streamingResponse ? Effect.void : finish(exit._tag === "Success" && succeeded),
        ),
      );
      if (attemptResponse) return attemptResponse;
    }
    return yield* new ModelProxyError({ operation: "noAccounts" });
  });
  if (state.enabled) yield* refreshAccounts(false).pipe(Effect.forkScoped);
  // Quota-aware selection must keep working while no client has the Usage page open.
  yield* Effect.forever(
    Effect.sleep("1 minute").pipe(
      Effect.andThen(Effect.suspend(() => (state.enabled ? refreshAccounts(false) : Effect.void))),
    ),
  ).pipe(Effect.forkScoped);
  return ModelProxy.of({ manage, environment, forward });
});
export const layer = Layer.effect(ModelProxy, make);

/** Resolve on each process launch so changing the proxy affects new T3 sessions immediately. */
export const proxyProviderEnvironment = Effect.fn("proxyProviderEnvironment")(function* (
  driver: ProviderDriverKind,
  base: NodeJS.ProcessEnv,
) {
  const proxy = yield* Effect.serviceOption(ModelProxy);
  return Option.isSome(proxy) ? yield* proxy.value.environment(driver, base) : base;
});
