import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PluginCatalog, PluginManageInput } from "@t3tools/contracts";
import { useContext, useRef, useState } from "react";
import { TextInput, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { MaterialButton } from "../../components/MaterialButton";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

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
  const running = useRef(false);
  const run = async (input: PluginManageInput) => {
    if (running.current || !allowed) return;
    running.current = true;
    setBusy(true);
    try {
      const result = await manage({ environmentId, input });
      registry.refresh(serverEnvironment.pluginCatalog({ environmentId, input: {} }));
      if (result._tag === "Success" && input.operation === "install") setRepository("");
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return (
    <View className="gap-4">
      <Text>
        Install from a GitHub or GitLab repository. Plugins run trusted code on this environment.
        Updates are checked daily and installed when you choose Update.
      </Text>
      <TextInput
        accessibilityLabel="Plugin repository URL"
        placeholder="https://github.com/owner/plugin"
        value={repository}
        onChangeText={setRepository}
        editable={!busy && allowed}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        className="min-h-12 rounded-lg border border-border px-3 text-foreground"
      />
      <MaterialButton
        label={busy ? "Working…" : "Install plugin"}
        disabled={!allowed || busy || !repository.trim()}
        onPress={() => void run({ operation: "install", repository })}
      />
      <MaterialButton
        label="Check for updates"
        disabled={!allowed || busy}
        onPress={() => void run({ operation: "check" })}
      />
      {catalog.plugins.length === 0 && <Text>No plugins installed.</Text>}
      {catalog.plugins.map((plugin) => (
        <View key={plugin.id} className="gap-2 rounded-xl border border-border p-3">
          <Text className="font-t3-medium text-foreground">
            {plugin.name} {plugin.source?.tag ?? plugin.version} · {plugin.status}
            {plugin.failure ? ` (${plugin.failure})` : ""}
          </Text>
          {plugin.source && (
            <>
              <Text selectable>{plugin.source.repository}</Text>
              <Text>
                {plugin.source.checkFailed
                  ? "Update check failed. Try again when the repository is reachable."
                  : `Last checked ${new Date(plugin.source.checkedAt).toLocaleString()}`}
              </Text>
            </>
          )}
          {plugin.source && plugin.source.latestCommit !== plugin.source.commit && (
            <MaterialButton
              label={`Update to ${plugin.source.latestTag}`}
              disabled={!allowed || busy}
              onPress={() => void run({ operation: "update", pluginId: plugin.id })}
            />
          )}
          <MaterialButton
            label={plugin.status === "disabled" ? "Enable" : "Disable"}
            disabled={!allowed || busy}
            onPress={() =>
              void run({
                operation: "set-enabled",
                pluginId: plugin.id,
                enabled: plugin.status === "disabled",
              })
            }
          />
          {(plugin.status === "stopped" || plugin.status === "failed") && (
            <MaterialButton
              label="Retry plugin"
              disabled={!allowed || busy}
              onPress={() => void run({ operation: "restart", pluginId: plugin.id })}
            />
          )}
          <RestartLimit
            pluginId={plugin.id}
            key={`${plugin.id}:${plugin.restartLimit ?? 5}`}
            limit={plugin.restartLimit ?? 5}
            disabled={!allowed || busy}
            run={run}
          />
          {plugin.status === "stopped" && (
            <Text>
              Stopped after {plugin.restartAttempts ?? plugin.restartLimit ?? 5} failed attempts.
              Retry explicitly to start again.
            </Text>
          )}
          <MaterialButton
            label="Remove"
            tone="danger"
            disabled={!allowed || busy}
            onPress={() => void run({ operation: "remove", pluginId: plugin.id })}
          />
        </View>
      ))}
      {catalog.plugins.length > 0 && (
        <Text>
          Remove clears saved settings, data, and credentials. Manually registered source folders
          are kept.
        </Text>
      )}
    </View>
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
    <View className="gap-2">
      <Text>Restart attempt limit</Text>
      <TextInput
        accessibilityLabel="Restart attempt limit"
        keyboardType="number-pad"
        value={value}
        editable={!disabled}
        onChangeText={setValue}
        className="min-h-12 rounded-lg border border-border px-3 text-foreground"
      />
      <MaterialButton
        label="Save limit"
        disabled={
          disabled ||
          !Number.isInteger(attempts) ||
          attempts < 1 ||
          attempts > 100 ||
          attempts === limit
        }
        onPress={() => void run({ operation: "set-restart-limit", pluginId, attempts })}
      />
    </View>
  );
}
