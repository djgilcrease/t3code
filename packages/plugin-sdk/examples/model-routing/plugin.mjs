import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Stream from "effect/Stream";
import { PluginError } from "@t3tools/plugin-sdk";

// A standalone package: no T3 server imports and no feature-specific core code.
// This routes to an existing model endpoint; account pools/OAuth belong to the
// plugin that implements them, rather than to the T3 plugin host.
const Configuration = Schema.Struct({
  endpoint: Schema.String,
  token: Schema.String,
  "gateway-key": Schema.String,
});
const decodeConfiguration = Schema.decodeUnknownEffect(Configuration);
const decodeStoredConfiguration = Schema.decodeUnknownEffect(Schema.fromJsonString(Configuration));
const encodeConfiguration = Schema.encodeEffect(Schema.fromJsonString(Configuration));
const failed = (operation) => (cause) => new PluginError({ operation, cause });

export default {
  apiVersion: 1,
  id: "model-routing",
  name: "Model routing",
  version: "0.1.0",
  activate: (host) =>
    Effect.gen(function* () {
      const count = yield* SubscriptionRef.make(0);
      const configuration = Effect.gen(function* () {
        const stored = yield* host.secrets.get("configuration");
        return stored === null
          ? null
          : yield* decodeStoredConfiguration(stored).pipe(Effect.mapError(failed("configuration")));
      });
      const read = Effect.gen(function* () {
        const url = (yield* configuration)?.endpoint ?? null;
        return {
          title: "Model routing",
          blocks: [
            {
              id: "status",
              kind: "text",
              text: url === null ? "Routing is disabled." : `Endpoint: ${url}`,
            },
            {
              id: "configure",
              kind: "form",
              label: "Save routing",
              command: "configure",
              input: {},
              fields: [
                {
                  name: "endpoint",
                  label: "Model endpoint (including /v1)",
                  kind: "text",
                  value: url ?? "",
                  required: true,
                },
                { name: "token", label: "Upstream API key", kind: "password", required: true },
                {
                  name: "gateway-key",
                  label: "Plugin endpoint API key",
                  kind: "password",
                  required: true,
                },
              ],
            },
            {
              id: "controls",
              kind: "actions",
              actions: [{ id: "disable", label: "Disable routing", command: "disable", input: {} }],
            },
          ],
        };
      });
      return {
        changes: Stream.map(SubscriptionRef.changes(count), () => undefined),
        commands: [
          {
            id: "configure",
            title: "Configure routing",
            description: "Set a model endpoint and private API keys.",
            permission: "providers:manage",
            agent: false,
            run: (input) =>
              Effect.gen(function* () {
                const config = yield* decodeConfiguration(input).pipe(
                  Effect.mapError(failed("configuration")),
                );
                const url = yield* Effect.try({
                  try: () => new URL(config.endpoint),
                  catch: failed("endpoint"),
                });
                if (
                  !["http:", "https:"].includes(url.protocol) ||
                  url.username ||
                  url.password ||
                  url.search ||
                  url.hash ||
                  !config.token ||
                  !config["gateway-key"]
                )
                  return yield* new PluginError({ operation: "endpoint", cause: null });
                const encoded = yield* encodeConfiguration({
                  ...config,
                  endpoint: url.href.replace(/\/$/, ""),
                }).pipe(Effect.mapError(failed("configuration")));
                yield* host.secrets.set("configuration", encoded);
                return null;
              }),
          },
          {
            id: "disable",
            title: "Disable routing",
            description: "Stop routing newly launched agents through this plugin.",
            permission: "providers:manage",
            agent: true,
            run: () =>
              Effect.gen(function* () {
                yield* host.secrets.remove("configuration");
                return null;
              }),
          },
          {
            id: "status",
            title: "Routing status",
            description: "Read routing status and request count without credentials.",
            permission: "diagnostics:read",
            agent: true,
            run: () =>
              Effect.gen(function* () {
                return {
                  enabled: (yield* configuration) !== null,
                  requests: yield* SubscriptionRef.get(count),
                };
              }),
          },
        ],
        views: [
          {
            id: "settings",
            title: "Model routing",
            location: "settings",
            permission: "providers:manage",
            read: () => read,
          },
          {
            id: "usage",
            title: "Model routing",
            location: "usage",
            permission: "diagnostics:read",
            read: () =>
              Effect.gen(function* () {
                return {
                  title: "Model routing",
                  blocks: [
                    {
                      id: "requests",
                      kind: "text",
                      text: `${yield* SubscriptionRef.get(count)} model requests handled by this environment.`,
                    },
                  ],
                };
              }),
          },
        ],
        prepareLaunch: (launch) =>
          Effect.gen(function* () {
            const configured = yield* configuration;
            if (configured === null) return launch;
            if (!["codex", "claudeAgent", "opencode"].includes(launch.provider)) return launch;
            const url = `${yield* host.httpBaseUrl}/v1`;
            const token = configured["gateway-key"];
            if (launch.provider === "codex")
              return {
                ...launch,
                environment: { ...launch.environment, T3_ROUTING_KEY: token },
                args: [
                  ...launch.args,
                  "-c",
                  'model_provider="t3-plugin"',
                  "-c",
                  'model_providers.t3-plugin.name="T3 plugin"',
                  "-c",
                  `model_providers.t3-plugin.base_url=${JSON.stringify(url)}`,
                  "-c",
                  'model_providers.t3-plugin.env_key="T3_ROUTING_KEY"',
                  "-c",
                  'model_providers.t3-plugin.wire_api="responses"',
                ],
              };
            if (launch.provider === "claudeAgent")
              return {
                ...launch,
                environment: {
                  ...launch.environment,
                  ANTHROPIC_BASE_URL: url.replace(/\/v1$/, ""),
                  ANTHROPIC_AUTH_TOKEN: token,
                  ANTHROPIC_API_KEY: "",
                },
              };
            if (launch.provider === "opencode") {
              const existing = yield* Effect.try({
                try: () => JSON.parse(launch.environment.OPENCODE_CONFIG_CONTENT || "{}"),
                catch: failed("opencode-config"),
              });
              return {
                ...launch,
                environment: {
                  ...launch.environment,
                  OPENCODE_CONFIG_CONTENT: JSON.stringify({
                    ...existing,
                    provider: {
                      ...existing.provider,
                      openai: {
                        ...existing.provider?.openai,
                        options: {
                          ...existing.provider?.openai?.options,
                          baseURL: url,
                          apiKey: token,
                        },
                      },
                    },
                  }),
                },
              };
            }
            return launch;
          }),
        handleHttp: (request) =>
          Effect.gen(function* () {
            const config = yield* configuration;
            const key = config?.["gateway-key"];
            if (!key || request.headers.get("authorization") !== `Bearer ${key}`)
              return new Response(null, { status: 401 });
            const url = config?.endpoint;
            if (!url) return new Response(null, { status: 503 });
            const incoming = new URL(request.url);
            const suffix = incoming.pathname
              .slice(host.httpBasePath.length)
              .replace(/^\/v1(?=\/)/, "");
            if (!/^\/(models|responses|chat\/completions|messages)(\/.*)?$/.test(suffix))
              return new Response(null, { status: 404 });
            const token = config.token;
            yield* SubscriptionRef.update(count, (n) => n + 1);
            const headers = new Headers(request.headers);
            headers.delete("host");
            headers.delete("cookie");
            headers.delete("x-api-key");
            headers.set("authorization", `Bearer ${token}`);
            return yield* Effect.tryPromise({
              try: (signal) =>
                fetch(`${url}${suffix}${incoming.search}`, {
                  method: request.method,
                  headers,
                  body: request.body,
                  duplex: "half",
                  redirect: "error",
                  signal: AbortSignal.any([signal, request.signal]),
                }),
              catch: failed("forward"),
            });
          }),
      };
    }),
};
