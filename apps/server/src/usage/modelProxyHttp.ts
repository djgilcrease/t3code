import { MODEL_PROXY_PATH } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as ModelProxy from "./ModelProxy.ts";

/** Model requests use proxy keys; account management stays on authenticated T3 RPCs. */
export const layer = HttpRouter.add(
  "*",
  `${MODEL_PROXY_PATH}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const proxy = yield* ModelProxy.ModelProxy;
    return yield* proxy.forward({
      path: request.url.slice(MODEL_PROXY_PATH.length),
      method: request.method,
      apiKey:
        request.headers.authorization?.replace(/^Bearer\s+/iu, "") ??
        request.headers["x-api-key"] ??
        request.headers["x-goog-api-key"] ??
        "",
      headers: request.headers,
      payload: request.method === "POST" ? yield* request.json : {},
    });
  }).pipe(
    Effect.catchTags({
      ModelProxyError: (error) =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { error: { message: error.message, type: error.operation } },
            {
              status:
                error.operation === "unauthorized"
                  ? 401
                  : error.operation === "disabled"
                    ? 503
                    : error.operation === "noAccounts"
                      ? 429
                      : error.operation === "unsupported"
                        ? 400
                        : 502,
            },
          ),
        ),
      HttpServerError: () =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            { error: { message: "Invalid JSON request body.", type: "invalid_request_error" } },
            { status: 400 },
          ),
        ),
    }),
  ),
);
