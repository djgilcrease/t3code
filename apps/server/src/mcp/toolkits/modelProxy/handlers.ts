import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ModelProxy from "../../../usage/ModelProxy.ts";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { ModelProxyToolkit } from "./tools.ts";

const access = Effect.gen(function* () {
  const caller = yield* readCaller();
  const environment = yield* Environment.ServerEnvironment;
  if ((yield* environment.getDescriptor).environmentId !== caller.scope.environmentId)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential belongs to another environment.",
    });
  return yield* ModelProxy.ModelProxy;
});
const failure = () =>
  new OrchestratorMcpFailure({
    code: "provider_unavailable",
    message: "The T3 Proxy request failed. Check proxy settings on this machine.",
  });
export const layer = McpToolAccess.toLayer(ModelProxyToolkit, {
  t3_proxy_status: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      return yield* (yield* access).manage({ action: "status" }).pipe(Effect.mapError(failure));
    }),
  ),
  t3_proxy_manage: McpToolAccess.writesEnvironment(({ input }, check) =>
    Effect.gen(function* () {
      const proxy = yield* access;
      yield* check;
      return yield* proxy.manage(input).pipe(Effect.mapError(failure));
    }),
  ),
});
