import { PluginsWsRpcGroup, WS_METHODS, type AuthEnvironmentScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import * as PluginManager from "./PluginManager.ts";
import * as PluginRegistry from "./PluginRegistry.ts";

const group = PluginsWsRpcGroup.middleware(RpcInstrumentation);

/** Captures the authenticated grant; command permissions are checked again by the registry. */
export const layer = (scopes: readonly AuthEnvironmentScope[]) =>
  group.toLayer(
    Effect.gen(function* () {
      const plugins = yield* PluginRegistry.PluginRegistry;
      const manager = yield* PluginManager.PluginManager;
      return group.of({
        [WS_METHODS.pluginsList]: () => plugins.list(scopes),
        [WS_METHODS.pluginsReadView]: (input) => plugins.readView(input, scopes),
        [WS_METHODS.pluginsExecute]: (input) => plugins.execute(input, scopes),
        [WS_METHODS.pluginsSubscribe]: () => plugins.changes,
        [WS_METHODS.pluginsManage]: (input) => manager.manage(input, scopes),
      });
    }),
  );
