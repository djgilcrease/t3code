import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as PluginRegistry from "./PluginRegistry.ts";

/** Plugin-owned protocols authenticate themselves; management always uses authenticated RPC. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const plugins = yield* PluginRegistry.PluginRegistry;
    return HttpRouter.add(
      "*",
      "/api/plugins/:pluginId/*",
      Effect.gen(function* () {
        const { params } = yield* HttpRouter.RouteContext;
        const incoming = yield* HttpServerRequest.HttpServerRequest;
        const signal = yield* Effect.abortSignal;
        const request = yield* HttpServerRequest.toWeb(incoming, { signal });
        return yield* plugins.handleHttp(params.pluginId ?? "", request).pipe(
          Effect.map(HttpServerResponse.fromWeb),
          Effect.catchTags({
            PluginOperationError: () => Effect.succeed(HttpServerResponse.empty({ status: 502 })),
          }),
        );
      }).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 400 }))),
    );
  }),
);
