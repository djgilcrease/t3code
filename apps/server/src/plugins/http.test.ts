import { afterEach, expect, it } from "vite-plus/test";
import { PluginOperationError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import * as PluginRegistry from "./PluginRegistry.ts";
import * as PluginHttp from "./http.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});
const fixture = (handleHttp: PluginRegistry.PluginRegistry["Service"]["handleHttp"]) => {
  const server = HttpRouter.toWebHandler(
    PluginHttp.layer.pipe(Layer.provide(Layer.mock(PluginRegistry.PluginRegistry)({ handleHttp }))),
    { disableLogger: true },
  );
  disposers.push(server.dispose);
  return server.handler;
};

it("preserves method, path, query, headers, and streaming request/response bodies", async () => {
  let called = 0;
  const handler = fixture((id, request) =>
    Effect.gen(function* () {
      called++;
      expect(id).toBe("example");
      expect(request.method).toBe("POST");
      expect(request.url).toBe("http://t3.test/api/plugins/example/v1/messages?beta=true");
      expect(request.headers.get("authorization")).toBe("Bearer plugin-key");
      const text = yield* Effect.promise(() => request.text());
      expect(text).toBe("prompt");
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: first\n\n"));
            controller.enqueue(new TextEncoder().encode("data: last\n\n"));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    }),
  );
  const response = await handler(
    new Request("http://t3.test/api/plugins/example/v1/messages?beta=true", {
      method: "POST",
      headers: { authorization: "Bearer plugin-key" },
      body: "prompt",
    }),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/event-stream");
  expect(await response.text()).toBe("data: first\n\ndata: last\n\n");
  expect(called).toBe(1);
});

it("keeps plugin authentication responses and hides internal failures", async () => {
  const denied = fixture(() => Effect.succeed(new Response(null, { status: 401 })));
  expect((await denied(new Request("http://t3.test/api/plugins/example/models"))).status).toBe(401);
  const broken = fixture(() =>
    Effect.fail(
      new PluginOperationError({ pluginId: "example", operation: "http", cause: "private-token" }),
    ),
  );
  const response = await broken(new Request("http://t3.test/api/plugins/example/models"));
  expect(response.status).toBe(502);
  expect(await response.text()).not.toContain("private-token");
});

it("does not capture unrelated core routes", async () => {
  let called = false;
  const handler = fixture(() =>
    Effect.sync(() => {
      called = true;
      return new Response();
    }),
  );
  expect((await handler(new Request("http://t3.test/api/auth/session"))).status).toBe(404);
  expect(called).toBe(false);
});
