import { MODEL_PROXY_PATH, type ServerDirectEndpoint } from "@t3tools/contracts";
import { connectionCatalogDisplayUrl, type EnvironmentPresentation } from "./presentation.ts";

/** Addresses reachable by another machine, rather than the browser's localhost. */
export function modelProxyServerUrl(presentation: {
  readonly entry: EnvironmentPresentation["entry"];
  readonly serverConfig: { readonly directEndpoints?: ReadonlyArray<ServerDirectEndpoint> } | null;
}): string | null {
  const endpoints = presentation.serverConfig?.directEndpoints ?? [];
  const candidates = [
    ...endpoints
      .filter((endpoint) => endpoint.kind === "tailnet")
      .map((endpoint) => endpoint.httpBaseUrl),
    ...endpoints
      .filter((endpoint) => endpoint.kind === "lan")
      .map((endpoint) => endpoint.httpBaseUrl),
    connectionCatalogDisplayUrl(presentation.entry),
  ];
  const urls: URL[] = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const url = new URL(candidate);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
        url.username ||
        url.password
      )
        continue;
      urls.push(url);
    } catch {
      /* SSH and relay-only connections need an advertised or manual address. */
    }
  }
  // Discovery must not downgrade an available HTTPS connection to advertised HTTP.
  const selected = urls.find((url) => url.protocol === "https:") ?? urls[0];
  return selected ? `${selected.origin}${MODEL_PROXY_PATH}` : null;
}
