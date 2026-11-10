import { useState } from "react";
import { TextInput, View } from "react-native";
import type { EnvironmentId } from "@t3tools/contracts";
import { pluginDestinationLabel } from "@t3tools/client-runtime/plugins";
import { usePluginInstallation } from "@t3tools/client-runtime/plugin-installation";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { PluginPanels } from "../plugins/PluginPanels";
import { SettingsScreen } from "./components/SettingsScreen";
import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";

export function SettingsPluginsRouteScreen() {
  const { environments } = useEnvironments();
  const machines = environments.map((entry) => ({
    ...entry,
    label: pluginDestinationLabel(
      entry,
      environments
        .filter((other) => other.environmentId !== entry.environmentId)
        .map((other) => other.label),
    ),
  }));
  const [machine, setMachine] = useState<EnvironmentId | null>(null);
  const installation = usePluginInstallation(serverEnvironment, machines);
  const targets = machines.filter((entry) =>
    machine === null ? entry.connection.phase === "connected" : entry.environmentId === machine,
  );
  return (
    <SettingsScreen
      title="Plugins"
      menus={[
        {
          title: "Plugin machines",
          icon: "desktopcomputer",
          items: [
            {
              id: "all",
              title: "All connected machines",
              selected: machine === null,
              onPress: () => setMachine(null),
            },
            ...machines.map((entry) => ({
              id: entry.environmentId,
              title: entry.label,
              selected: machine === entry.environmentId,
              onPress: () => setMachine(entry.environmentId),
            })),
          ],
        },
      ]}
    >
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1"
        contentContainerClassName="gap-4 px-5 py-4"
      >
        <Text>
          Installing plugins on{" "}
          {machine === null
            ? "All connected machines"
            : (machines.find((entry) => entry.environmentId === machine)?.label ??
              "Offline machine")}
        </Text>
        <Text>
          All installs on machines connected when you press Install. Newly connected machines need
          another All install. Reconnect failed machines and retry below. Existing installs keep
          their versions and settings.
        </Text>
        <Text>
          Plugins run trusted code. Each machine verifies its latest stable repository version with
          its own Git credentials. Versions may differ. Data, secrets, settings, and local paths are
          never copied.
        </Text>
        <TextInput
          accessibilityLabel="Plugin repository URL"
          placeholder="https://github.com/owner/plugin"
          value={installation.repository}
          onChangeText={installation.setRepository}
          editable={!installation.busy}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          className="min-h-12 rounded-lg border border-border px-3 text-foreground"
        />
        <Button
          label={
            installation.busy
              ? "Installing…"
              : machine === null
                ? "Install on All"
                : "Install on this machine"
          }
          disabled={installation.busy || !installation.repository.trim() || targets.length === 0}
          onPress={() => void installation.run(targets.map((target) => target.environmentId))}
        />
        {installation.results.map((result) => (
          <View key={result.environmentId} className="gap-2">
            <Text>
              {machines.find((entry) => entry.environmentId === result.environmentId)?.label ??
                result.environmentId}
              : {result.detail}
            </Text>
            {result.state !== "installed" && result.state !== "preserved" && (
              <Button
                label="Retry this machine"
                disabled={installation.busy}
                onPress={() => void installation.run([result.environmentId], true)}
              />
            )}
          </View>
        ))}
        {targets.length === 0 && <Text>No machines connected.</Text>}
        {targets.map((target) => (
          <View key={target.environmentId} className="gap-3">
            <Text className="font-t3-medium text-foreground">{target.label}</Text>
            {target.connection.phase === "connected" ? (
              <PluginPanels environmentId={target.environmentId} location="settings" />
            ) : (
              <Text>Offline. Reconnect to manage plugins.</Text>
            )}
          </View>
        ))}
      </ScreenScrollView>
    </SettingsScreen>
  );
}
