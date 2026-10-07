import type { ModelProxyProvider } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const googleScopes =
  "https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile";

/** CLI OAuth flows. Google clients are supplied by the server operator. */
export const PROXY_OAUTH: Record<
  ModelProxyProvider,
  {
    clientId: string;
    tokenUrl: string;
    scope: string;
    authorizeUrl?: string;
    redirectUri?: string;
    clientSecret?: string;
    deviceUrl?: string;
    discoveryUrl?: string;
  }
> = {
  codex: {
    clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
    authorizeUrl: "https://auth.openai.com/oauth/authorize",
    tokenUrl: "https://auth.openai.com/oauth/token",
    redirectUri: "http://localhost:1455/auth/callback",
    scope: "openid email profile offline_access",
  },
  claude: {
    clientId: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    authorizeUrl: "https://claude.ai/oauth/authorize",
    tokenUrl: "https://platform.claude.com/v1/oauth/token",
    redirectUri: "http://localhost:54545/callback",
    scope:
      "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
  },
  gemini: {
    clientId: "",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    redirectUri: "http://localhost:8085/oauth2callback",
    scope: googleScopes,
  },
  antigravity: {
    clientId: "",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    redirectUri: "http://localhost:51121/oauth-callback",
    scope: `${googleScopes} https://www.googleapis.com/auth/cclog https://www.googleapis.com/auth/experimentsandconfigs`,
  },
  kimi: {
    clientId: "17e5f671-d194-4dfb-9706-5516cb48c098",
    tokenUrl: "https://auth.kimi.com/api/oauth/token",
    deviceUrl: "https://auth.kimi.com/api/oauth/device_authorization",
    scope: "",
  },
  xai: {
    clientId: "b1a00492-073a-47ea-816f-4c329264a828",
    tokenUrl: "https://auth.x.ai/oauth/token",
    discoveryUrl: "https://auth.x.ai/.well-known/openid-configuration",
    scope: "openid profile email offline_access grok-cli:access api:access",
  },
};

export const ProxyTokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.optional(Schema.String),
  id_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
  account: Schema.optional(
    Schema.Struct({
      uuid: Schema.optional(Schema.String),
      email_address: Schema.optional(Schema.String),
    }),
  ),
});
export const ProxyDeviceResponse = Schema.Struct({
  device_code: Schema.NonEmptyString,
  user_code: Schema.String,
  verification_uri: Schema.String,
  verification_uri_complete: Schema.optional(Schema.String),
  interval: Schema.optional(Schema.Number),
  expires_in: Schema.optional(Schema.Number),
});
