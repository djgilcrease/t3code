# T3 Code plugin SDK

A plugin lives in its own repository. It exports a versioned manifest and an
Effect-based `activate(context)` function, and runs in a supervised process on
the owning T3 environment. Feature code imports this SDK and `effect`, never T3
server internals. API version **1** uses Effect **4.1.2**.

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
          location: "settings-page",
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
  Hosts advertising `command-invocation-context` pass a second `run` argument with
  `audience` (`client` or `agent`) and, for thread MCP calls, the authenticated
  `environmentId`, `projectId`, and `threadId`. Treat agent-supplied input as
  untrusted: scoped commands must require this context and reject missing identity.
  Outside MCP clients and peer plugin calls have no project identity. Client
  commands can select an explicit project under their normal environment grants.
- **Views** return data rendered by host components on web, desktop, and mobile.
  Version 1 provides text, HTTP links, actions, forms, tables, and status items. Use
  `settings-page` for a standalone Extensions page and `usage` for a Usage panel.
  The Extensions navigation group disappears when its last active contributor
  is disabled or removed. Use stable block, action, row, and field IDs. Never put
  credentials in views, defaults, labels, or results. Password fields never
  prefill server values.
- **Thread details** views use the `thread-details` location and hold only
  `status` blocks: an optional `tone`, `label`, and `detail`, plus at most three
  actions. T3 draws them beside the machine name in a thread's details, and a
  toned item also tints a dot on that environment's thread rows. The view is
  read once per environment, not per thread. A pressed action receives the
  thread as `threadId` in its input. An action can ask first: `confirm` shows
  text before it runs, and `environment: { name, label }` asks for another
  connected environment that runs the same plugin and sends its id under
  `name`. Such an action is hidden while no other connected environment runs
  the plugin. Return `{ $t3: "notice", tone, text, thread? }` to end with a message
  and, with `thread`, an **Open thread** button. A failed command shows only a
  generic error, so report user-facing failures as a `danger` notice. Require
  the `thread-details` capability.
- **Portable collections** require `portable-collections`. `thread-panel` views open
  from thread information with `{ threadId }`; `project-settings` views receive
  `{ projectId }` on the owning environment. A `collection` block contains stable
  item IDs, labels, search text and context input; selecting an item rereads its
  view with that input. Optional `queryField` delegates search to the plugin by
  sending the query under that context field. Keep the whole view below 256 KiB.
  Forms support `multiline` and `image` fields. Image selection carries a raster
  data URL, bounded to 64 KiB of bytes, and `image` blocks render bounded raster
  data URLs without fetching a remote origin. Feature serialization, persistence,
  identity, and sync policy remain the plugin's responsibility.
- **Relayed steps** let a `thread-details` action continue on another
  environment. Return `{ $t3: "relay", environmentId?, command, input, status? }`
  and the client calls that command of the same plugin next, on the named
  connected environment or on the one that answered. Each step is an ordinary
  command: its permission is checked where it runs, and it keeps the 30-second
  and 256 KiB limits, so move large data in chunks and long work in a
  background fiber the next step waits on. Two environments that cannot reach
  each other can exchange data this way. A relayed step does not refresh views;
  the last result does. The chain stops if the user closes the dialog or the
  client goes away, so leave the source unchanged until the final step.
- **Panel navigation** commands can return `{ $t3: "view", view }` to replace
  the calling portable panel with another bounded `PluginView`. Return actions
  for back/next navigation explicitly. State stays in that mounted client,
  so two clients can explore independently. Refresh returns to the entry view.
  A `code` block (`id`, `kind: "code"`, `text`) displays bounded preformatted
  plain text without HTML or syntax execution. Require
  `portable-view-navigation` before using either addition.
- **Launch hooks** transform a provider's purpose, arguments, and environment in
  configuration order. Return new values. An undefined environment value means
  deletion. Codex agents and text generation, Claude agents and text generation,
  and managed OpenCode servers are integrated. Claude's SDK agent path accepts
  only environment overrides; the SDK owns its arguments. A failed hook fails
  the launch. Disabled plugins no longer participate; stopped hooks fail closed.
- **MCP servers** are resolved with `mcpServers({ provider, instanceId,
  projectDirectory, cwd })` before a thread's provider session is attached. Names
  must start with `<plugin-id>-`; T3's built-in endpoint is reserved. Return
  normalized stdio (`command`, `args`, `environment`), HTTP, or SSE (`url`,
  `headers`) definitions. The host translates them into native session settings,
  preserving provider configuration files. Never use process-wide launch flags
  for project-scoped MCP settings: Codex can share one process across projects.
  Changes apply to new sessions; running sessions retain their snapshot. Check
  `context.capabilities` for `provider-mcp-servers` before relying on this hook.
  Pi and external OpenCode servers are unsupported; Codex and Muse reject SSE,
  and ACP agents must advertise remote transport support.
- **HTTP handlers** use standard streaming `Request` and `Response` objects below
  `/api/plugins/<id>/`. Authenticate API keys, OAuth state/PKCE, or webhook
  signatures yourself. This route has no T3 browser session. Use
  `request.signal` to cancel upstream I/O. The bridge pulls request and response
  bodies in bounded chunks and propagates cancellation.
- **Worktree lifecycle** uses `onLifecycle` for `worktree.created`,
  `worktree.removing`, and `worktree.removed` on the owning environment.
  Return `{ error: "safe user-facing detail" }` to block removal; it is posted
  in the owning thread and unsettles it without launching a provider. Cleanup
  precedes Git's destructive clean/removal. Created/removed callbacks are
  observers: failures retain the creation result or cannot undo deletion.
  A setup plugin must also reject `prepareLaunch` while its managed checkout
  is not ready. Keep cleanup state outside the worktree and make scripts
  idempotent across interruption. `lifecycleTimeoutMs` defaults to 30 seconds,
  with a 30-minute maximum. Require the `worktree-lifecycle` capability.
- **Supervised processes** use `context.runProcess` with command/args, cwd,
  environment overrides, and a bounded timeout. The host cancels owned process
  trees on worker exit and limits buffered output and concurrent jobs. Require
  `supervised-processes`; direct unmanaged child processes cannot receive these
  guarantees. Never return raw secret-bearing script output in lifecycle errors.
- **Thread portability** uses `context.threads` to copy a thread to another
  environment that runs the same plugin. `describe` reads a thread's title,
  repository identity, directory, branch, and whether it is running or has
  subagent threads. `export` stops a running turn while holding its queue,
  commits the working tree to a snapshot ref (tracked changes and untracked
  files Git does not ignore; its parent is `HEAD`), and writes the conversation
  to a file in your data directory. `projects` finds this environment's clones
  of a repository. `import` creates a thread from that file in a new worktree of
  a local branch you prepared; its first turn starts a new provider session and
  is handed the copied history. `archive` notes in the source thread where the
  work continues, then archives it. The conversation file is the host's own
  versioned format: carry it as bytes. Moving Git objects between the two
  repositories is the plugin's job. A failure's `cause` is an `Error` whose
  message is safe to show the user. Nothing here reaches other threads' turns,
  events, or provider sessions. Require `thread-portability`.
- **Other plugins** are reached through `context.plugins`. `list` returns the
  other active plugins with the commands they expose to agents; `run` calls one
  with `{ pluginId, commandId, input }` and returns its JSON result. A plugin
  calls as an agent would: only `agent: true` commands, never a secret result,
  and each call keeps the 30-second and 256 KiB limits. Check `list` first to
  use a plugin only when it is installed. A refusal's `cause` is an `Error`
  whose message is `unavailable`, `unknown-contribution`,
  `agent-access-disabled`, `secret-access-disabled`, or `failed`. Report your
  own user-facing failures in the JSON result, because a failed command tells
  its caller nothing more. Require `plugin-commands`.
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
activation attempt has a 15-second deadline; commands, views, MCP resolution, launch hooks, and
HTTP response acquisition have a 30-second deadline. `httpResponseTimeoutMs` can
extend response acquisition to at most 65 minutes for long RPCs; check for the
`http-response-timeout` context capability. Caller cancellation still aborts the
request, and ordinary commands and views keep their 30-second watchdog. Streaming body lifetimes
have no whole-response deadline. View, command, and MCP contribution results are limited to
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

## Headless environment controllers

`context.activity` reads committed thread activity, including subagents and pending
background work. It excludes connection presence. Check for `environment-activity`
in `context.capabilities` before depending on it.

A plugin owning external resources can implement `beforeRemove`. The host awaits
this bounded hook before disabling or removing the plugin; failure retains its
configuration, data and credentials. Keep the hook short: refuse while cleanup
runs in the background, rather than blocking removal on a long provider call.

A controller that operates a guest through MCP can issue a token on that guest
with `t3 auth mcp issue --access full-access --token-only --base-dir <home>`.
These tokens last 30 days and are restricted to MCP. Ordinary bearer sessions
issued with `auth session issue` cannot access MCP. Revoke either token with
`auth session revoke <session-id>`.

## Ordered graph views

The `portable-graphs` capability adds bounded `graph` blocks: `label` and up to
100 ordered `nodes`, each with `id`, later `parents` (or ids beyond this page),
`label`, `detail`, `annotation`, `badges`, and an ordinary permission-checked
`action`. Nodes and parent ids are unique, ordered child before parent, and the
union is limited to 200 ids. The host owns lane layout and static SVG rendering;
plugins provide data, never SVG or client code. Edges leaving the window continue
at its bottom. Each page lays out independently.

A `thread-panel` descriptor can request `presentation: "dialog"` for a larger
view opened from the thread info bar. Other panels keep their default popover
presentation. Both receive the owning thread as `threadId` in `read` input;
resolve its directory through `context.threads.describe` on that environment.
