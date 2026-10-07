import { modelProxyServerUrl } from "@t3tools/client-runtime/connection";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  ModelProxyProvider,
  type ModelProxyManageInput,
  type ModelProxySnapshot,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Alert, Linking, TextInput, View } from "react-native";
import * as Clipboard from "expo-clipboard";
import { AppText as Text } from "../../components/AppText";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsActionRow } from "./components/SettingsActionRow";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";

export function SettingsModelProxyRouteScreen() {
  const { selectedTargets, availableTargets } = useSettingsEnvironmentFilter();
  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="T3 Proxy" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScreenScrollView
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="gap-6 px-5 pt-4 pb-12"
        >
          {selectedTargets.map((target) => (
            <ProxySettings key={target.environmentId} target={target} peers={availableTargets} />
          ))}
          {selectedTargets.length === 0 && <Text>Select a connected environment.</Text>}
        </ScreenScrollView>
      </SettingsScreen>
    </>
  );
}

function ProxySettings({
  target,
  peers,
}: {
  target: SettingsTarget;
  peers: readonly SettingsTarget[];
}) {
  const environmentId = target.environmentId;
  const query = useEnvironmentQuery(
    serverEnvironment.modelProxyStatus({ environmentId, input: {} }),
  );
  const command = useAtomCommand(serverEnvironment.manageModelProxy, { reportFailure: false });
  const [latest, setLatest] = useState<{ value: ModelProxySnapshot; at: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [choosingClient, setChoosingClient] = useState(false);
  const [choosingStrategy, setChoosingStrategy] = useState(false);
  const [url, setUrl] = useState("");
  const [key, setKey] = useState("");
  const [callback, setCallback] = useState("");
  const [stickyMinutes, setStickyMinutes] = useState<string | null>(null);
  const [importName, setImportName] = useState("account.json");
  const [importCredential, setImportCredential] = useState("");
  const [importing, setImporting] = useState(false);
  const [flow, setFlow] = useState<ModelProxySnapshot["oauth"]>();
  const state = latest && latest.at >= query.dataUpdatedAt ? latest.value : query.data;
  const checkLogin = useEffectEvent(() => {
    if (flow?.status === "wait")
      void run({ action: "authStatus", provider: flow.provider, state: flow.state }, true);
  });
  useEffect(() => {
    if (flow?.status !== "wait") return;
    const timer = setInterval(checkLogin, 5_000);
    return () => clearInterval(timer);
  }, [flow?.state, flow?.status]);
  async function run(input: ModelProxyManageInput, silent = false) {
    if (busyRef.current) return null;
    busyRef.current = true;
    setBusy(true);
    try {
      const result = await command({ environmentId, input });
      if (result._tag !== "Success") {
        if (!silent) Alert.alert("T3 Proxy", String(squashAtomCommandFailure(result)));
        return null;
      }
      const { apiKey: _key, oauth: _oauth, ...snapshot } = result.value;
      setLatest({ value: snapshot, at: Date.now() });
      query.refresh();
      if (result.value.oauth) setFlow(result.value.oauth);
      return result.value;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  if (!state) return <Text>{query.error ?? "Loading T3 Proxy…"}</Text>;
  return (
    <View className="gap-6">
      <SettingsSection
        title={`${target.label} · ${state.enabled ? "Server" : state.client.configured ? "Client" : "Disabled"}`}
      >
        <Text className="p-4 text-foreground-muted">
          Only new Codex, Claude, and T3-managed OpenCode sessions launched by T3 use this proxy.
          Your terminal CLI configuration stays untouched.
        </Text>
        <SettingsActionRow
          icon="checkmark.circle"
          label="Disabled"
          disabled={busy}
          onPress={() => {
            setChoosingClient(false);
            void run({ action: "stop" });
          }}
        />
        <SettingsActionRow
          icon="server.rack"
          label="Server"
          disabled={busy}
          onPress={() => {
            setChoosingClient(false);
            void run({ action: "start" });
          }}
        />
        <SettingsActionRow
          icon="link"
          label="Client · choose a server"
          disabled={busy}
          onPress={() => setChoosingClient(true)}
        />
        {state.client.url && (
          <Text className="p-4 text-foreground-muted">Using {state.client.url}</Text>
        )}
        {state.error && <Text className="p-4 text-danger-foreground">{state.error}</Text>}
      </SettingsSection>
      {(choosingClient || (state.client.configured && !state.client.local)) && (
        <SettingsSection title="Proxy server">
          {peers
            .filter((peer) => peer.environmentId !== environmentId)
            .map((peer) => (
              <ProxyPeer
                key={peer.environmentId}
                peer={peer}
                disabled={busy}
                onConnect={async (url, apiKey) => {
                  if (await run({ action: "configureClient", url, apiKey }))
                    setChoosingClient(false);
                }}
              />
            ))}
          <View className="gap-3 p-4">
            <Text>Or enter a reachable T3 Proxy endpoint and API key.</Text>
            <TextInput
              accessibilityLabel="Proxy server URL"
              className="rounded-lg border border-border p-3 text-foreground"
              autoCapitalize="none"
              value={url}
              onChangeText={setUrl}
              placeholder="https://machine:3773/api/model-proxy"
            />
            <TextInput
              accessibilityLabel="Proxy API key"
              className="rounded-lg border border-border p-3 text-foreground"
              secureTextEntry
              value={key}
              onChangeText={setKey}
              autoCapitalize="none"
            />
          </View>
          <SettingsActionRow
            icon="link"
            label="Connect"
            disabled={busy || !url.trim() || !key.trim()}
            onPress={() =>
              void run({ action: "configureClient", url: url.trim(), apiKey: key.trim() }).then(
                (value) => {
                  if (value) {
                    setKey("");
                    setChoosingClient(false);
                  }
                },
              )
            }
          />
        </SettingsSection>
      )}
      {state.enabled && (
        <SettingsSection title={`Accounts · ${state.accounts.length}`}>
          <Text className="p-4 text-foreground-muted">Endpoint: {state.endpointPath}</Text>
          <SettingsActionRow
            icon="doc.on.doc"
            label="Copy proxy API key"
            disabled={busy}
            onPress={() =>
              void run({ action: "revealKey" }).then((value) => {
                if (value?.apiKey) void Clipboard.setStringAsync(value.apiKey);
              })
            }
          />
          <SettingsActionRow
            icon="arrow.clockwise"
            label="Rotate proxy API key"
            disabled={busy}
            onPress={() =>
              Alert.alert("Rotate API key?", "Reconnect clients that use the old key.", [
                { text: "Cancel", style: "cancel" },
                { text: "Rotate", onPress: () => void run({ action: "rotateKey" }) },
              ])
            }
          />
          <SettingsActionRow
            icon="doc.on.doc"
            label="Import credential JSON"
            disabled={busy}
            onPress={() => setImporting(!importing)}
          />
          {importing && (
            <View className="gap-3 p-4">
              <TextInput
                accessibilityLabel="Credential filename"
                className="rounded-lg border border-border p-3 text-foreground"
                autoCapitalize="none"
                autoCorrect={false}
                value={importName}
                onChangeText={setImportName}
              />
              <TextInput
                accessibilityLabel="Credential JSON"
                className="rounded-lg border border-border p-3 text-foreground"
                multiline
                autoCapitalize="none"
                autoCorrect={false}
                value={importCredential}
                onChangeText={setImportCredential}
              />
              <SettingsActionRow
                icon="checkmark"
                label="Import account"
                disabled={busy || !importCredential.trim()}
                onPress={() => {
                  try {
                    const credential: unknown = JSON.parse(importCredential);
                    if (
                      credential === null ||
                      typeof credential !== "object" ||
                      Array.isArray(credential)
                    )
                      throw new Error();
                    void run({
                      action: "importAccount",
                      name: importName,
                      credential: credential as Record<string, unknown>,
                    }).then((value) => {
                      if (value) {
                        setImportCredential("");
                        setImporting(false);
                      }
                    });
                  } catch {
                    Alert.alert("Invalid credential", "Paste a JSON credential object.");
                  }
                }}
              />
            </View>
          )}
          <SettingsActionRow
            icon="arrow.clockwise"
            label="Refresh quotas"
            disabled={busy}
            onPress={() => void run({ action: "refresh" })}
          />
          <SettingsActionRow
            icon="arrow.triangle.branch"
            label={`Account selection: ${state.strategy === "closest-reset" ? "Closest to Reset" : state.strategy === "round-robin" ? "Round-Robin" : "Least Active Sessions"}`}
            disabled={busy}
            onPress={() => setChoosingStrategy((value) => !value)}
          />
          {choosingStrategy && (
            <View>
              <Text className="p-4 text-foreground-muted">
                Choose how new sessions are assigned. Active sessions keep their account.
              </Text>
              {(["closest-reset", "round-robin", "least-active-sessions"] as const).map(
                (strategy) => (
                  <SettingsActionRow
                    key={strategy}
                    icon={state.strategy === strategy ? "checkmark.circle" : "circle"}
                    label={
                      strategy === "closest-reset"
                        ? "Closest to Reset"
                        : strategy === "round-robin"
                          ? "Round-Robin"
                          : "Least Active Sessions"
                    }
                    disabled={busy}
                    onPress={() =>
                      void run({ action: "setStrategy", strategy }).then((value) => {
                        if (value) setChoosingStrategy(false);
                      })
                    }
                  />
                ),
              )}
              <SettingsActionRow
                icon="xmark"
                label="Cancel"
                disabled={busy}
                onPress={() => setChoosingStrategy(false)}
              />
            </View>
          )}
          <View className="gap-3 p-4">
            <Text>Sticky session idle time (minutes)</Text>
            <Text className="text-foreground-muted">
              Keep the account after the last request finishes. Default: 12 minutes. Requests in
              progress stay bound.
            </Text>
            <TextInput
              accessibilityLabel="Sticky session idle minutes"
              className="rounded-lg border border-border p-3 text-foreground"
              keyboardType="number-pad"
              value={stickyMinutes ?? String(state.stickyIdleMinutes)}
              onChangeText={setStickyMinutes}
            />
            <SettingsActionRow
              icon="checkmark"
              label="Save idle time"
              disabled={
                busy ||
                !Number.isInteger(Number(stickyMinutes)) ||
                Number(stickyMinutes) < 1 ||
                Number(stickyMinutes) > 1440 ||
                Number(stickyMinutes) === state.stickyIdleMinutes
              }
              onPress={() =>
                void run({ action: "setStickyIdleMinutes", minutes: Number(stickyMinutes) }).then(
                  (value) => {
                    if (value) setStickyMinutes(null);
                  },
                )
              }
            />
          </View>
          {ModelProxyProvider.literals.map((provider) => (
            <SettingsActionRow
              key={provider}
              icon="person.crop.circle"
              label={`Sign in to ${provider}`}
              disabled={busy || flow?.status === "wait"}
              onPress={() => {
                setCallback("");
                void run({ action: "authStart", provider });
              }}
            />
          ))}
          {flow?.status === "wait" && (
            <>
              <SettingsActionRow
                icon="arrow.up.right"
                label="Open sign-in"
                onPress={() => void Linking.openURL(flow.url)}
              />
              <SettingsActionRow
                icon="checkmark"
                label="Check device sign-in"
                disabled={busy}
                onPress={() =>
                  void run({ action: "authStatus", provider: flow.provider, state: flow.state })
                }
              />
              <View className="gap-3 p-4">
                <Text className="text-foreground-muted">
                  After approval, paste the full callback URL, even if localhost fails to load.
                </Text>
                <TextInput
                  accessibilityLabel="OAuth callback URL"
                  className="rounded-lg border border-border p-3 text-foreground"
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={callback}
                  onChangeText={setCallback}
                />
              </View>
              <SettingsActionRow
                icon="checkmark"
                label="Complete sign-in"
                disabled={busy || !callback.trim()}
                onPress={() =>
                  void run({
                    action: "authComplete",
                    provider: flow.provider,
                    state: flow.state,
                    redirectUrl: callback.trim(),
                  }).then((value) => {
                    if (value) setCallback("");
                  })
                }
              />
              <SettingsActionRow
                icon="xmark"
                label="Cancel sign-in"
                disabled={busy}
                onPress={() =>
                  void run({ action: "authCancel", state: flow.state }).then((value) => {
                    if (value) setFlow(undefined);
                  })
                }
              />
            </>
          )}
          {flow?.status === "ok" && <Text className="p-4">Account connected.</Text>}
          {flow?.status === "error" && (
            <Text className="p-4 text-danger-foreground">
              Sign-in expired or was declined. Start again.
            </Text>
          )}
          {state.accounts.map((account) => (
            <View key={account.id}>
              <Text className="px-4 pt-4">
                {account.email ?? account.name} · {account.status}
              </Text>
              <SettingsActionRow
                icon="checkmark.circle"
                label={account.disabled ? "Enable account" : "Disable account"}
                disabled={busy}
                onPress={() =>
                  void run({
                    action: "setAccountEnabled",
                    name: account.name,
                    enabled: account.disabled,
                  })
                }
              />
              <SettingsActionRow
                icon="trash"
                label="Remove account"
                tone="danger"
                disabled={busy}
                onPress={() =>
                  Alert.alert("Remove account?", account.email ?? account.name, [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Remove",
                      style: "destructive",
                      onPress: () => void run({ action: "removeAccount", name: account.name }),
                    },
                  ])
                }
              />
            </View>
          ))}
        </SettingsSection>
      )}
    </View>
  );
}

function ProxyPeer({
  peer,
  disabled,
  onConnect,
}: {
  peer: SettingsTarget;
  disabled: boolean;
  onConnect: (url: string, key: string) => Promise<void>;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.modelProxyStatus({ environmentId: peer.environmentId, input: {} }),
  );
  const command = useAtomCommand(serverEnvironment.manageModelProxy);
  const [busy, setBusy] = useState(false);
  const url = modelProxyServerUrl(peer);
  return (
    <>
      <Text className="px-4 pt-4 text-foreground-muted">
        {query.data?.enabled
          ? (url ?? "Enter a directly reachable address.")
          : "Enable Server mode on this machine first."}
      </Text>
      <SettingsActionRow
        icon="server.rack"
        label={`Use ${peer.label}`}
        disabled={disabled || busy || !url || !query.data?.enabled}
        onPress={() => {
          if (!url) return;
          setBusy(true);
          void command({ environmentId: peer.environmentId, input: { action: "revealKey" } })
            .then(async (result) => {
              if (result._tag === "Success" && result.value.apiKey)
                await onConnect(url, result.value.apiKey);
            })
            .finally(() => setBusy(false));
        }}
      />
    </>
  );
}
