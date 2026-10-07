import {
  ModelProxySnapshot,
  ModelProxyStrategy,
  ModelProxyStickyIdleMinutes,
  ModelProxyProvider,
  OrchestratorMcpFailure,
  TrimmedNonEmptyString,
  ModelProxyAccountName,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ModelProxy from "../../../usage/ModelProxy.ts";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

const shared = {
  success: ModelProxySnapshot,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    ModelProxy.ModelProxy,
    Environment.ServerEnvironment,
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
};
const read = Tool.make("t3_proxy_status", {
  ...shared,
  description:
    "Read this machine's T3 Proxy mode, enabled accounts, and quotas. Does not expose credentials.",
}).annotate(Tool.Readonly, true);
const manage = Tool.make("t3_proxy_manage", {
  ...shared,
  description:
    "Manage this machine's native T3 Proxy. Requires a live full-access/default caller. Account sign-in returns a URL for the user; do not sign in on their behalf. Client setup and keys are managed in Settings.",
  parameters: Schema.Struct({
    input: Schema.Union([
      Schema.Struct({ action: Schema.Literals(["start", "stop", "refresh", "disconnectClient"]) }),
      Schema.Struct({ action: Schema.Literal("setStrategy"), strategy: ModelProxyStrategy }),
      Schema.Struct({
        action: Schema.Literal("setStickyIdleMinutes"),
        minutes: ModelProxyStickyIdleMinutes,
      }),
      Schema.Struct({
        action: Schema.Literal("setAccountEnabled"),
        name: TrimmedNonEmptyString,
        enabled: Schema.Boolean,
      }),
      Schema.Struct({
        action: Schema.Literal("removeAccount"),
        name: ModelProxyAccountName,
      }),
      Schema.Struct({ action: Schema.Literal("authStart"), provider: ModelProxyProvider }),
      Schema.Struct({
        action: Schema.Literal("authStatus"),
        provider: ModelProxyProvider,
        state: TrimmedNonEmptyString,
      }),
      Schema.Struct({ action: Schema.Literal("authCancel"), state: TrimmedNonEmptyString }),
    ]),
  }),
}).annotate(Tool.Destructive, true);
export const ModelProxyToolkit = Toolkit.make(read, manage);
