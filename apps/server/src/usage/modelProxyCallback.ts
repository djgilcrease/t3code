// @effect-diagnostics nodeBuiltinImport:off - The OAuth redirect is a loopback HTTP listener.
import * as NodeHttp from "node:http";
import { ModelProxyError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

/** A scoped receiver for browser sign-in on the server machine; remote clients can paste URLs. */
export const receiveProxyCallback = Effect.fn("receiveProxyCallback")(function* (
  redirectUri: string,
  state: string,
) {
  const redirect = new URL(redirectUri);
  const callback = Promise.withResolvers<string>();
  const server = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        new Promise<NodeHttp.Server>((resolve, reject) => {
          const server = NodeHttp.createServer((request, response) => {
            const url = new URL(request.url ?? "/", redirect);
            if (
              request.method !== "GET" ||
              url.pathname !== redirect.pathname ||
              url.searchParams.get("state") !== state
            ) {
              response.writeHead(400).end("This sign-in callback is not valid.");
              return;
            }
            callback.resolve(url.toString());
            response
              .writeHead(200, {
                "Content-Type": "text/plain; charset=utf-8",
                "Cache-Control": "no-store",
              })
              .end("Sign-in received. Return to T3 Code to check your account.");
          });
          server.once("error", reject);
          server.listen(Number(redirect.port), "localhost", () => {
            server.off("error", reject);
            resolve(server);
          });
        }),
      catch: () => new ModelProxyError({ operation: "callback" }),
    }),
    (server) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
  );
  // Keep the acquired listener alive until a callback or scope cancellation.
  void server;
  return yield* Effect.tryPromise({
    try: () => callback.promise,
    catch: () => new ModelProxyError({ operation: "callback" }),
  });
});
