import {
  AuthStandardClientScopes,
  OrchestratorMcpFailure,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PluginRegistry from "../../../plugins/PluginRegistry.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { assertLiveCaller, readCaller, unavailable } from "../../threadAccess.ts";
import { PluginsToolkit } from "./tools.ts";

const readScopes: readonly AuthEnvironmentScope[] = AuthStandardClientScopes.filter((scope) =>
  scope.endsWith(":read"),
);
const access = Effect.gen(function* () {
  const caller = yield* readCaller();
  yield* assertLiveCaller(caller);
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const environmentId = yield* environment.getEnvironmentId;
  if (environmentId !== caller.scope.environmentId)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential belongs to another environment.",
    });
  const plugins = yield* PluginRegistry.PluginRegistry;
  return {
    plugins,
    context: {
      environmentId,
      ...(caller.caller ? { projectId: caller.caller.projectId, threadId: caller.caller.id } : {}),
    },
  };
});
export const layer = McpToolAccess.toLayer(PluginsToolkit, {
  t3_plugins_list: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const { plugins } = yield* access;
      const catalog = yield* plugins.list(AuthStandardClientScopes);
      return {
        ...catalog,
        plugins: catalog.plugins.map((plugin) => ({
          ...plugin,
          commands: plugin.commands.filter((command) => command.agent),
        })),
      };
    }),
  ),
  t3_plugin_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { plugins, context } = yield* access;
      return yield* plugins
        .execute(input, readScopes, "agent-read", context)
        .pipe(Effect.mapError(unavailable));
    }),
  ),
  t3_plugin_run: McpToolAccess.writesEnvironment((input, check) =>
    Effect.gen(function* () {
      const { plugins, context } = yield* access;
      yield* check;
      return yield* plugins
        .execute(input, AuthStandardClientScopes, "agent", context)
        .pipe(Effect.mapError(unavailable));
    }),
  ),
});
