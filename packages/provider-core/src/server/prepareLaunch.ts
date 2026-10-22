import type { PluginLaunch, PluginOperationError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/** The environment can prepare a launch without providers importing its plugin host. */
export const PrepareLaunch = Context.Reference<(launch: PluginLaunch) => Effect.Effect<PluginLaunch, PluginOperationError>>(
  "@t3tools/provider-core/server/PrepareLaunch", { defaultValue: () => (launch) => Effect.succeed(launch) },
);
