# Plugins

Plugins add capabilities to one T3 Code environment. Web, desktop, and mobile
clients use the plugins installed on the environment they are connected to.

## Install and manage plugins

Open **Settings → Plugins**, select the environment, and paste a GitHub or GitLab
HTTPS repository URL. T3 installs the highest stable version tag, such as
`v1.10.0`. The repository must be packaged for T3 plugins; an arbitrary source
repository cannot be installed. Git must be available on the environment.
Self-hosted GitLab URLs and subgroup repositories work too. Private repositories
use the environment's existing Git credentials; do not put tokens in the URL.

T3 checks installed repositories for updates once a day while the environment
is running. Use **Check for updates** to check sooner. Updates are installed
only when you choose **Update**. If the new version cannot start, T3 restores
the previous plugin version. Plugin-owned data migrations are not rolled back.

You can disable, enable, retry, update, or remove a plugin without restarting T3.
Disabling keeps its settings and data. **Remove clears the plugin's saved data
and credentials**, along with its installed package. A manually registered
source folder is kept. There is no marketplace or central plugin account.

Plugin settings appear on the Plugins page. Plugins can also contribute panels
to **Usage → Limits**. The selected environment determines which machine owns
the plugin, its credentials, and its data.

## Failures and recovery

Each plugin runs in its own process. A plugin process exiting or throwing an
uncaught error does not terminate T3's server process. T3 restarts a failed
plugin, then stops trying after **five failed attempts**. You can change the
attempt limit for each plugin in Settings. After a minute of stable operation,
the failure counter resets. During that server session, a stopped plugin
requires an explicit retry, re-enable, or update before it runs again.

A failed routing plugin blocks launches that would use it rather than silently
bypassing the route. Existing provider sessions may need to be restarted after
changing routing settings.

Install code you trust. Process separation contains ordinary crashes and event
loop stalls; it is not an operating system security sandbox. JavaScript plugins
run with the environment's access to files, processes, and the network.

If T3 reports that `plugins.json` is malformed, correct that file in the
environment's T3 home and restart the server. Plugin management leaves the
malformed file intact so its previous configuration can be recovered.

## Remote connections and agents

Plugin settings and commands use the authenticated environment connection,
including remote and relay connections. The environment checks each command's
permission when it runs. Agents can discover and call commands the plugin
explicitly exposes. Commands that change the environment require full access;
read commands are also available to read-only callers.

A plugin may serve its own HTTP protocol, such as a model endpoint or OAuth
callback, below `/api/plugins/<id>/`. Those endpoints use the plugin's own
authentication. A relay connection does not publish them automatically. Follow
the plugin author's instructions for remote consumers.

Provider launch hooks currently cover T3-owned Codex and Claude agents and text
generation, plus T3-managed OpenCode servers. Terminal launches, external
OpenCode servers, Cursor, Grok, Antigravity, and arbitrary ACP runtimes have no
plugin launch integration yet.

For authoring, see the [plugin SDK](../../packages/plugin-sdk/README.md).
