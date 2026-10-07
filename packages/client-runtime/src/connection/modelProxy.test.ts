import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { BearerConnectionProfile } from "./catalog.ts";
import { BearerConnectionTarget } from "./model.ts";
import { modelProxyServerUrl } from "./modelProxy.ts";
import type { EnvironmentPresentation } from "./presentation.ts";

const target = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("peer"),
  connectionId: "peer",
  label: "Peer",
});
const presentation = (url: string): EnvironmentPresentation => ({
  entry: {
    target,
    enabled: true,
    profile: Option.some(
      new BearerConnectionProfile({
        environmentId: target.environmentId,
        connectionId: target.connectionId,
        label: target.label,
        httpBaseUrl: url,
        wsBaseUrl: url.replace(/^http/u, "ws"),
      }),
    ),
  },
  connection: { phase: "connected", error: null, traceId: null },
  serverConfig: null,
});

describe("T3 Proxy server discovery", () => {
  it("uses a connected remote machine's address", () => {
    expect(modelProxyServerUrl(presentation("https://peer.example.test:3773"))).toBe(
      "https://peer.example.test:3773/api/model-proxy",
    );
  });
  it("does not configure another machine to use the browser's loopback address", () => {
    expect(modelProxyServerUrl(presentation("http://localhost:3773"))).toBeNull();
    expect(modelProxyServerUrl(presentation("http://127.0.0.1:3773"))).toBeNull();
    expect(modelProxyServerUrl(presentation("http://[::1]:3773"))).toBeNull();
  });
  it("rejects an address with embedded credentials", () => {
    expect(modelProxyServerUrl(presentation("https://user:password@peer.test"))).toBeNull();
  });
});
