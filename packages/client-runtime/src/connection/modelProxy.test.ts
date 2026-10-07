import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { BearerConnectionProfile } from "./catalog.ts";
import { BearerConnectionTarget } from "./model.ts";
import { modelProxyServerUrls } from "./modelProxy.ts";
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
  it("keeps a connected HTTPS address ahead of advertised HTTP addresses", () => {
    expect(
      modelProxyServerUrls({
        ...presentation("https://peer.example.test:3773"),
        serverConfig: {
          directEndpoints: [
            { kind: "tailnet", httpBaseUrl: "http://100.100.1.2:3773" },
            { kind: "lan", httpBaseUrl: "http://192.168.1.2:3773" },
            { kind: "tailnet", httpBaseUrl: "https://peer.example.test:3773" },
          ],
        },
      }),
    ).toEqual([
      "https://peer.example.test:3773/api/model-proxy",
      "http://100.100.1.2:3773/api/model-proxy",
      "http://192.168.1.2:3773/api/model-proxy",
    ]);
  });
  it("prefers an advertised HTTPS address over HTTP while retaining tailnet HTTP fallback", () => {
    const peer = {
      ...presentation("http://peer.example.test:3773"),
      serverConfig: {
        directEndpoints: [
          { kind: "tailnet" as const, httpBaseUrl: "http://100.100.1.2:3773" },
          { kind: "lan" as const, httpBaseUrl: "https://peer.example.test:3773" },
        ],
      },
    };
    expect(modelProxyServerUrls(peer)).toEqual([
      "https://peer.example.test:3773/api/model-proxy",
      "http://100.100.1.2:3773/api/model-proxy",
      "http://peer.example.test:3773/api/model-proxy",
    ]);
    expect(
      modelProxyServerUrls({
        ...peer,
        serverConfig: { directEndpoints: peer.serverConfig.directEndpoints.slice(0, 1) },
      }),
    ).toEqual([
      "http://100.100.1.2:3773/api/model-proxy",
      "http://peer.example.test:3773/api/model-proxy",
    ]);
  });
  it("filters unusable HTTPS addresses before falling back to a reachable address", () => {
    expect(
      modelProxyServerUrls({
        ...presentation("https://user:password@peer.example.test"),
        serverConfig: {
          directEndpoints: [
            { kind: "lan", httpBaseUrl: "https://localhost:3773" },
            { kind: "tailnet", httpBaseUrl: "http://100.100.1.2:3773" },
          ],
        },
      }),
    ).toEqual(["http://100.100.1.2:3773/api/model-proxy"]);
  });
  it("uses a connected remote machine's address", () => {
    expect(modelProxyServerUrls(presentation("https://peer.example.test:3773"))).toEqual([
      "https://peer.example.test:3773/api/model-proxy",
    ]);
  });
  it("does not configure another machine to use the browser's loopback address", () => {
    expect(modelProxyServerUrls(presentation("http://localhost:3773"))).toEqual([]);
    expect(modelProxyServerUrls(presentation("http://127.0.0.1:3773"))).toEqual([]);
    expect(modelProxyServerUrls(presentation("http://[::1]:3773"))).toEqual([]);
  });
  it("rejects an address with embedded credentials", () => {
    expect(modelProxyServerUrls(presentation("https://user:password@peer.test"))).toEqual([]);
  });
});
