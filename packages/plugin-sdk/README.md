# T3 Code plugin SDK

A plugin lives in its own repository. It exports a versioned manifest and an
Effect-based `activate(context)` function, and runs in a supervised process on
the owning T3 environment. Feature code imports this SDK and `effect`, never T3
server internals. API version **1** uses Effect **4.0.1**.

```ts
import type { T3Plugin } from "@t3tools/plugin-sdk";
import * as Effect from "effect/Effect";

export default {
  apiVersion: 1,
  id: "example",
  name: "Example",
  version: "1.0.0",
  activate: () =>
    Effect.succeed({
      commands: [
        {
          id: "status",
          title: "Read status",
          description: "Read the example status.",
          permission: "orchestration:read",
          agent: true,
          run: () => Effect.succeed({ ready: true }),
        },
      ],
      views: [
        {
          id: "settings",
          title: "Example",
          location: "settings",
          permission: "orchestration:read",
          read: () =>
            Effect.succeed({
              title: "Example",
              blocks: [{ id: "status", kind: "text", text: "Ready" }],
            }),
        },
      ],
    }),
} satisfies T3Plugin;
```

## Package and publish

Build a self-contained ESM JavaScript entrypoint, including the SDK, Effect,
and any other JavaScript dependencies. T3 does not run npm, installation hooks,
or build commands. Put this manifest at the repository root:

```json
{
  "apiVersion": 1,
  "id": "example",
  "name": "Example",
  "version": "1.0.0",
  "main": "dist/plugin.mjs"
}
```

Commit the manifest and built entrypoint, then tag that commit `v1.0.0` (or
`1.0.0`). The module's manifest must have the same ID and version. T3 selects the
highest stable `major.minor.patch` tag, resolves annotated tags to their commit,
and verifies the checkout still matches that commit. Prerelease and non-version
tags are ignored. Entrypoints must resolve inside the checkout. Submodules are
not fetched. Prefer pure JavaScript dependencies for portability across hosts.

The [model-routing example](./examples/model-routing/) includes a package
manifest and bundler configuration. Copy it into a separate repository. Install
its authoring dependencies and run `npm run build`, then include `dist/` in the
tagged commit (`git add -f dist` if your ignore rules exclude it). While developing
against this checkout, set its `file:` SDK dependency to the absolute path of
`packages/plugin-sdk` and build the SDK first:

```sh
vp run --filter @t3tools/plugin-sdk build
```

For a published SDK, replace the example's `file:` dependency with the matching
published package version. Users install by pasting the repository URL into
**Settings → Plugins**. No marketplace registration is involved. See the
[installation guide](../../docs/user/plugins.md) for lifecycle and recovery.

For local development, register an absolute entrypoint manually in
`<T3 home>/plugins.json` and restart the environment once:

```json
{ "plugins": [{ "id": "example", "path": "/absolute/path/plugin.mjs", "enabled": true }] }
```

The Settings page can then disable, enable, retry, or remove that plugin. Manual
entries have no repository update checks. Removing them leaves their source
folder in place but clears their T3-managed data and credentials.

## Contribution model

- **Commands** have stable local IDs, descriptions, permissions, and explicit
  agent opt-in. They take a JSON object and return JSON. Validate feature input
  inside the handler. UI actions and MCP tools call the same handler. Leave
  `agent: false` for secret-bearing commands. An explicit write command can
  return `{ $t3: "secret", label: "API key", value: "..." }` to show a masked,
  copyable value for 30 seconds in the calling client. It is never part of a
  view or catalog; agent calls and read commands cannot use this disclosure. The server checks the actual
  descriptor permission, regardless of what the invocation envelope claims.
- **Views** return data rendered by host components on web, desktop, and mobile.
  Version 1 provides text, HTTP links, actions, forms, and tables at `settings`
  and `usage`. Use stable block, action, row, and field IDs. Never put
  credentials in views, defaults, labels, or results. Password fields never
  prefill server values.
- **Launch hooks** transform a provider's purpose, arguments, and environment in
  configuration order. Return new values. An undefined environment value means
  deletion. Codex agents and text generation, Claude agents and text generation,
  and managed OpenCode servers are integrated. Claude's SDK agent path accepts
  only environment overrides; the SDK owns its arguments. A failed hook fails
  the launch. Disabled plugins no longer participate; stopped hooks fail closed.
- **HTTP handlers** use standard streaming `Request` and `Response` objects below
  `/api/plugins/<id>/`. Authenticate API keys, OAuth state/PKCE, or webhook
  signatures yourself. This route has no T3 browser session. Use
  `request.signal` to cancel upstream I/O. The bridge pulls request and response
  bodies in bounded chunks and propagates cancellation.
- **Changes** is an optional Effect stream. Emit after background state changes;
  T3 refreshes mounted plugin views. Commands also invalidate them. Nothing
  mounts in the chat transcript, and clients do not poll plugin views.

`context.dataDirectory` holds ordinary persistent files. `context.secrets`
provides namespaced `get`, `set`, and `remove` operations through T3's secret
store. Secret keys use lowercase letters, digits, and hyphens.
`context.httpBasePath` is the relative namespace. Evaluate the lazy
`context.httpBaseUrl` **inside a handler or launch hook**, after T3 starts
listening, to get its actual local URL and assigned port. It fails during
activation, when there is no listener yet.

Acquire resources with Effect scopes in `activate`. T3 closes the worker's scope
on disable, update, removal, activation failure, or shutdown, and kills a worker
that does not exit. Cleanup must tolerate abrupt termination. Each load and
activation attempt has a 15-second deadline; commands, views, launch hooks, and
HTTP response acquisition have a 30-second deadline. Streaming body lifetimes
have no whole-response deadline. View and command results are limited to
256 KiB; views also have collection limits. IPC messages are limited to 1 MiB.

T3 restarts crashed workers, stops after five failed attempts by default, and
resets the counter after a minute of stable operation. Settings can change the
limit from 1 to 100 or explicitly retry a stopped plugin. Automatic restarts must
return the same manifest and contribution descriptors. Use a new version for
API changes. Each worker has a 256 MiB V8 heap limit; this is not a total RSS or
system resource quota. Errors sent to clients omit their private causes.

Plugins execute trusted code with the host user's OS permissions. Separate
processes contain exits, uncaught exceptions, event loop stalls, and V8 failures;
they do not sandbox malicious code. Plugin code is never imported into the T3
server or client process. The IPC contract carries JSON and streams, leaving
room for a future WASM worker backend without changing client renderers. A WASM
runtime is not included in version 1.

## Model routing and the proxy PR

The standalone example demonstrates private credentials, settings, usage,
authenticated streaming forwarding, provider launch overrides, and MCP status.
It routes to an existing model service. It does not implement account pools,
OAuth login, quota probes, balancing, sticky sessions, or protocol translation.

Those parts of [PR #16677](https://github.com/pingdotgg/t3code/pull/16677) can live
inside a separate plugin: activation owns account services and background work;
secrets hold tokens; commands manage accounts; views expose quota tables; HTTP
handlers own model protocols; launch hooks route supported CLIs through them.
No proxy-specific RPC, settings page, or MCP registration belongs in core.

The finite portable UI and host hooks keep the compatibility boundary small.
New generic primitives or lifecycle hooks require an SDK change and client
support. Arbitrary React bundles, replacement provider adapters, and internal
orchestration access are outside version 1. Add explicit versioned APIs when a
real plugin needs them, rather than exposing internal classes permanently.
