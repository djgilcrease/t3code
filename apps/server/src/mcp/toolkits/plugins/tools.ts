import { PluginCatalog, PluginCommandInput, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as PluginRegistry from "../../../plugins/PluginRegistry.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    PluginRegistry.PluginRegistry,
    ServerEnvironment.ServerEnvironment,
    ThreadManagementService.ThreadManagementService,
    McpInvocationContext.McpInvocationContext,
  ],
};
export const PluginsToolkit = Toolkit.make(
  Tool.make("t3_plugins_list", {
    ...shared,
    success: PluginCatalog,
    description:
      "List this environment's installed plugins and commands explicitly exposed to agents. Use each command's permission in its invocation envelope.",
  }).annotate(Tool.Readonly, true),
  Tool.make("t3_plugin_read", {
    ...shared,
    parameters: PluginCommandInput,
    success: Schema.Json,
    description:
      "Run a plugin command declared with a read permission and explicit agent access. The host checks the actual command permission; passing a read permission cannot invoke a write command.",
  }).annotate(Tool.Readonly, true),
  Tool.make("t3_plugin_run", {
    ...shared,
    parameters: PluginCommandInput,
    success: Schema.Json,
    description:
      "Run an agent-enabled plugin command on this environment. Requires a live full-access/default caller. Read-only commands are also available through t3_plugin_read. Never pass secrets obtained from chat; use the plugin's private sign-in or settings flow.",
  }).annotate(Tool.Destructive, true),
);
