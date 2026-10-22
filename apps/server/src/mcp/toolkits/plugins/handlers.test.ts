import { expect, it } from "@effect/vitest";
import { EnvironmentId, type AuthEnvironmentScope, type PluginCatalog } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PluginRegistry from "../../../plugins/PluginRegistry.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as Handlers from "./handlers.ts";
import { PluginsToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("plugin-mcp-environment");
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "plugin-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "plugin-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const catalog: PluginCatalog = {
  configurationError: false,
  plugins: [
    {
      id: "example",
      name: "Example",
      version: "1.0.0",
      status: "active",
      views: [],
      commands: [
        {
          id: "status",
          title: "Status",
          description: "Read status",
          permission: "diagnostics:read",
          agent: true,
        },
        {
          id: "configure",
          title: "Configure",
          description: "Private settings",
          permission: "providers:manage",
          agent: false,
        },
      ],
    },
  ],
};
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Json));
const scope = (
  access: "read-only" | "approval-required" | "full-access",
  foreign = false,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: foreign ? EnvironmentId.make("other-environment") : environmentId,
  requestNamespace: "client:plugin-test",
  thread: undefined,
  client: { sessionId: "session", label: "Plugin test", access },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

function call(
  name: string,
  access: "read-only" | "approval-required" | "full-access",
  options: { foreign?: boolean } = {},
) {
  const invoked: Array<{ scopes: readonly AuthEnvironmentScope[]; audience: string | undefined }> =
    [];
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* server.callTool({
      name,
      arguments:
        name === "t3_plugins_list"
          ? {}
          : {
              pluginId: "example",
              commandId: "status",
              input: {},
              permission: "diagnostics:read",
            },
    });
    const output = yield* decode(
      result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
    );
    return { output, invoked };
  }).pipe(
    Effect.provideService(
      McpInvocationContext.McpInvocationContext,
      scope(access, options.foreign),
    ),
    Effect.provideService(McpSchema.McpServerClient, client),
    Effect.provide(
      McpHttpServer.toolkitRegistration(PluginsToolkit, Handlers.layer).pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
        Layer.provide(
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed(environmentId),
          }),
        ),
        Layer.provide(
          Layer.mock(PluginRegistry.PluginRegistry)({
            list: () => Effect.succeed(catalog),
            execute: (_, scopes, audience) =>
              Effect.sync(() => {
                invoked.push({ scopes, audience });
                return { ready: true };
              }),
          }),
        ),
      ),
    ),
  );
}

it.effect("lists only explicitly agent-enabled commands", () =>
  Effect.gen(function* () {
    const { output } = yield* call("t3_plugins_list", "read-only");
    expect(output).toMatchObject({ plugins: [{ commands: [catalog.plugins[0]?.commands[0]] }] });
  }),
);
it.effect("read tools use only read scopes and enforce the read-only audience", () =>
  Effect.gen(function* () {
    const { output, invoked } = yield* call("t3_plugin_read", "read-only");
    expect(output).toEqual({ ready: true });
    expect(invoked).toHaveLength(1);
    expect(invoked[0]?.audience).toBe("agent-read");
    expect(invoked[0]?.scopes.every((permission) => permission.endsWith(":read"))).toBe(true);
  }),
);
it.effect.each(["read-only", "approval-required"] as const)(
  "denies environment writes from a %s client before invoking a plugin",
  (access) =>
    Effect.gen(function* () {
      const { output, invoked } = yield* call("t3_plugin_run", access);
      expect(output).toMatchObject({ code: "capability_denied" });
      expect(invoked).toEqual([]);
    }),
);
it.effect("allows writes from a full-access caller", () =>
  Effect.gen(function* () {
    const { output, invoked } = yield* call("t3_plugin_run", "full-access");
    expect(output).toEqual({ ready: true });
    expect(invoked[0]?.audience).toBe("agent");
  }),
);
it.effect("denies credentials belonging to a different environment", () =>
  Effect.gen(function* () {
    const { output, invoked } = yield* call("t3_plugin_run", "full-access", { foreign: true });
    expect(output).toMatchObject({ code: "capability_denied" });
    expect(invoked).toEqual([]);
  }),
);
