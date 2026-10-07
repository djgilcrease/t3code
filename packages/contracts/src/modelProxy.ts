import * as Schema from "effect/Schema";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ServerProviderUsageLimits } from "./providerUsageLimits.ts";

export const MODEL_PROXY_PATH = "/api/model-proxy";
export const ModelProxyProvider = Schema.Literals([
  "codex",
  "claude",
  "gemini",
  "antigravity",
  "kimi",
  "xai",
]);
export type ModelProxyProvider = typeof ModelProxyProvider.Type;
export const ModelProxyStrategy = Schema.Literals([
  "closest-reset",
  "round-robin",
  "least-active-sessions",
]);
export type ModelProxyStrategy = typeof ModelProxyStrategy.Type;
export const ModelProxyStickyIdleMinutes = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 1440 }),
);
export const ModelProxyAccount = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  provider: TrimmedNonEmptyString,
  email: Schema.optional(Schema.String),
  disabled: Schema.Boolean,
  status: Schema.String,
  activeSessions: Schema.optional(Schema.Int),
  usageLimits: Schema.optional(ServerProviderUsageLimits),
  plan: Schema.optional(Schema.String),
});
export type ModelProxyAccount = typeof ModelProxyAccount.Type;
export const ModelProxySnapshot = Schema.Struct({
  enabled: Schema.Boolean,
  status: Schema.Literals(["stopped", "running", "failed"]),
  version: Schema.String,
  endpointPath: Schema.String,
  strategy: ModelProxyStrategy,
  stickyIdleMinutes: ModelProxyStickyIdleMinutes,
  checkedAt: IsoDateTime,
  accounts: Schema.Array(ModelProxyAccount),
  error: Schema.optional(Schema.String),
  client: Schema.Struct({
    configured: Schema.Boolean,
    local: Schema.Boolean,
    url: Schema.optional(Schema.String),
  }),
  /** Returned only by an explicit key request. */
  apiKey: Schema.optional(Schema.String),
  oauth: Schema.optional(
    Schema.Struct({
      provider: ModelProxyProvider,
      url: Schema.String,
      state: Schema.String,
      status: Schema.Literals(["wait", "ok", "error"]),
    }),
  ),
});
export type ModelProxySnapshot = typeof ModelProxySnapshot.Type;
export const ModelProxyAccountName = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[^/\\\p{Cc}]+\.json$/u),
);
export const ModelProxyManageInput = Schema.Union([
  Schema.Struct({
    action: Schema.Literals(["status", "start", "stop", "refresh", "revealKey", "rotateKey"]),
  }),
  Schema.Struct({ action: Schema.Literal("setStrategy"), strategy: ModelProxyStrategy }),
  Schema.Struct({
    action: Schema.Literal("setStickyIdleMinutes"),
    minutes: ModelProxyStickyIdleMinutes,
  }),
  Schema.Struct({ action: Schema.Literal("authStart"), provider: ModelProxyProvider }),
  Schema.Struct({
    action: Schema.Literal("authStatus"),
    provider: ModelProxyProvider,
    state: TrimmedNonEmptyString,
  }),
  Schema.Struct({ action: Schema.Literal("authCancel"), state: TrimmedNonEmptyString }),
  Schema.Struct({
    action: Schema.Literal("authComplete"),
    provider: ModelProxyProvider,
    state: TrimmedNonEmptyString,
    redirectUrl: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    action: Schema.Literal("setAccountEnabled"),
    name: TrimmedNonEmptyString,
    enabled: Schema.Boolean,
  }),
  Schema.Struct({ action: Schema.Literal("removeAccount"), name: ModelProxyAccountName }),
  Schema.Struct({
    action: Schema.Literal("importAccount"),
    name: ModelProxyAccountName,
    credential: Schema.Record(Schema.String, Schema.Unknown),
  }),
  Schema.Struct({ action: Schema.Literal("useLocal") }),
  Schema.Struct({
    action: Schema.Literal("configureClient"),
    url: TrimmedNonEmptyString,
    fallbackUrls: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
    apiKey: TrimmedNonEmptyString,
  }),
  Schema.Struct({ action: Schema.Literal("disconnectClient") }),
]);
export type ModelProxyManageInput = typeof ModelProxyManageInput.Type;
export class ModelProxyError extends Schema.TaggedError<ModelProxyError>()("ModelProxyError", {
  operation: Schema.Literals([
    "storage",
    "management",
    "disabled",
    "callback",
    "unsupported",
    "unauthorized",
    "noAccounts",
    "upstream",
    "oauthConfig",
  ]),
}) {
  override get message() {
    return {
      storage: "Could not read or save model proxy settings.",
      management: "The model proxy management request failed.",
      disabled: "Start the model proxy before managing accounts.",
      callback: "Paste the full OAuth callback URL for this login.",
      unsupported: "This provider or API format is not supported by T3 Proxy yet.",
      unauthorized: "The T3 Proxy API key is invalid.",
      noAccounts:
        "No enabled account is available for this model. Check its quota or connect another account.",
      upstream: "The upstream provider request failed.",
      oauthConfig:
        "Google OAuth requires a client ID configured on this T3 server. See the T3 Proxy usage guide.",
    }[this.operation];
  }
}
