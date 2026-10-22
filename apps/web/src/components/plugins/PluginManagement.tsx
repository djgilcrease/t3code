import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PluginCatalog, PluginManageInput } from "@t3tools/contracts";
import { useContext, useRef, useState } from "react";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function PluginManagement({
  environmentId,
  catalog,
}: {
  environmentId: EnvironmentId;
  catalog: PluginCatalog;
}) {
  const registry = useContext(RegistryContext);
  const manage = useAtomCommand(serverEnvironment.managePlugins);
  const allowed = useAtomValue(serverEnvironment.managePlugins.permissionAtom(environmentId));
  const [repository, setRepository] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = useRef(false);
  const run = async (input: PluginManageInput) => {
    if (running.current || !allowed) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await manage({ environmentId, input });
      registry.refresh(serverEnvironment.pluginCatalog({ environmentId, input: {} }));
      if (result._tag === "Success" && input.operation === "install") setRepository("");
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(
          failure instanceof Error ? failure.message : "The plugin operation failed. Try again.",
        );
      }
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Install a plugin from a GitHub or GitLab repository. Plugins run trusted code on this
        environment. Updates are checked daily and installed when you choose Update.
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void run({ operation: "install", repository });
        }}
      >
        <label className="min-w-48 flex-1 space-y-1 text-sm">
          <span>Repository URL</span>
          <Input
            type="url"
            placeholder="https://github.com/owner/plugin"
            value={repository}
            disabled={!allowed || busy}
            required
            onChange={(event) => setRepository(event.target.value)}
          />
        </label>
        <Button type="submit" size="sm" disabled={!allowed || busy || !repository.trim()}>
          {busy ? "Working…" : "Install plugin"}
        </Button>
      </form>
      <Button
        size="sm"
        variant="outline"
        disabled={!allowed || busy}
        onClick={() => void run({ operation: "check" })}
      >
        Check for updates
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {catalog.plugins.length === 0 && (
        <p className="text-sm text-muted-foreground">No plugins installed.</p>
      )}
      {catalog.plugins.map((plugin) => (
        <div key={plugin.id} className="space-y-2 rounded-lg border p-3">
          <p className="text-sm font-medium">
            {plugin.name} {plugin.source?.tag ?? plugin.version} · {plugin.status}
            {plugin.failure ? ` (${plugin.failure})` : ""}
          </p>
          {plugin.source && (
            <>
              <p className="break-all text-xs text-muted-foreground">{plugin.source.repository}</p>
              <p className="text-xs text-muted-foreground">
                {plugin.source.checkFailed
                  ? "Update check failed. Try again when the repository is reachable."
                  : `Last checked ${new Date(plugin.source.checkedAt).toLocaleString()}`}
              </p>
            </>
          )}
          <div className="flex flex-wrap gap-2">
            {plugin.source && plugin.source.latestCommit !== plugin.source.commit && (
              <Button
                size="sm"
                disabled={!allowed || busy}
                onClick={() => void run({ operation: "update", pluginId: plugin.id })}
              >
                Update to {plugin.source.latestTag}
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={!allowed || busy}
              onClick={() =>
                void run({
                  operation: "set-enabled",
                  pluginId: plugin.id,
                  enabled: plugin.status === "disabled",
                })
              }
            >
              {plugin.status === "disabled" ? "Enable" : "Disable"}
            </Button>
            {(plugin.status === "stopped" || plugin.status === "failed") && (
              <Button
                size="sm"
                variant="outline"
                disabled={!allowed || busy}
                onClick={() => void run({ operation: "restart", pluginId: plugin.id })}
              >
                Retry plugin
              </Button>
            )}
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={!allowed || busy}
              onClick={() => void run({ operation: "remove", pluginId: plugin.id })}
            >
              Remove
            </Button>
          </div>
          <RestartLimit
            pluginId={plugin.id}
            key={`${plugin.id}:${plugin.restartLimit ?? 5}`}
            limit={plugin.restartLimit ?? 5}
            disabled={!allowed || busy}
            run={run}
          />
          {plugin.status === "stopped" && (
            <p role="status" className="text-sm">
              Stopped after {plugin.restartAttempts ?? plugin.restartLimit ?? 5} failed attempts.
              Retry explicitly to start again.
            </p>
          )}
        </div>
      ))}
      {catalog.plugins.length > 0 && (
        <p className="text-xs text-muted-foreground">
          Remove clears the plugin's saved settings, data, and credentials. Manually registered
          source folders are kept.
        </p>
      )}
    </div>
  );
}

function RestartLimit({
  pluginId,
  limit,
  disabled,
  run,
}: {
  pluginId: string;
  limit: number;
  disabled: boolean;
  run: (input: PluginManageInput) => Promise<void>;
}) {
  const [value, setValue] = useState(String(limit));
  const attempts = Number(value);
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="space-y-1 text-sm">
        <span>Restart attempt limit</span>
        <Input
          type="number"
          min={1}
          max={100}
          value={value}
          disabled={disabled}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      <Button
        size="sm"
        variant="outline"
        disabled={
          disabled ||
          !Number.isInteger(attempts) ||
          attempts < 1 ||
          attempts > 100 ||
          attempts === limit
        }
        onClick={() => void run({ operation: "set-restart-limit", pluginId, attempts })}
      >
        Save limit
      </Button>
    </div>
  );
}
