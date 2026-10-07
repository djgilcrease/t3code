import { modelProxyServerUrls } from "@t3tools/client-runtime/connection";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  ModelProxyProvider,
  type EnvironmentId,
  type ModelProxyManageInput,
  type ModelProxySnapshot,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { ensureLocalApi } from "../../localApi";
import { useEnvironments, type EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const PROXY_PROVIDER_LABELS: Record<ModelProxyProvider, string> = {
  codex: "Codex",
  claude: "Claude",
  gemini: "Gemini",
  antigravity: "Antigravity",
  kimi: "Kimi",
  xai: "xAI",
};

/** Each mutation targets the selected machine; credentials never enter client storage. */
export function ModelProxySettings({ environmentId }: { environmentId: EnvironmentId }) {
  const query = useEnvironmentQuery(
    serverEnvironment.modelProxyStatus({ environmentId, input: {} }),
  );
  const command = useAtomCommand(serverEnvironment.manageModelProxy, { reportFailure: false });
  const { environments } = useEnvironments();
  const [latest, setLatest] = useState<{ value: ModelProxySnapshot; at: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [choosingClient, setChoosingClient] = useState(false);
  const [url, setUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [callback, setCallback] = useState("");
  const [stickyMinutes, setStickyMinutes] = useState<string | null>(null);
  const [flow, setFlow] = useState<ModelProxySnapshot["oauth"]>();
  const state = latest && latest.at >= query.dataUpdatedAt ? latest.value : query.data;
  const checkLogin = useEffectEvent(() => {
    if (flow?.status === "wait")
      void run({ action: "authStatus", provider: flow.provider, state: flow.state });
  });
  useEffect(() => {
    if (flow?.status !== "wait") return;
    const timer = setInterval(checkLogin, 5_000);
    return () => clearInterval(timer);
  }, [flow?.state, flow?.status]);
  async function run(input: ModelProxyManageInput) {
    if (busyRef.current) return null;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await command({ environmentId, input });
      if (result._tag !== "Success") {
        setError(String(squashAtomCommandFailure(result)));
        return null;
      }
      // Secrets and transient OAuth state stay out of the visible snapshot.
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
  if (!state)
    return (
      <SettingsPageContainer>
        <p role="status">{query.error ?? "Loading T3 Proxy…"}</p>
      </SettingsPageContainer>
    );
  // oxlint-disable-next-line t3code/no-rpc-permission-bypass -- Snapshot client is proxy configuration; commands use serverEnvironment.
  const proxyClient = state.client;
  const mode = state.enabled ? "server" : proxyClient.configured ? "client" : "disabled";
  return (
    <SettingsPageContainer>
      <SettingsSection title="T3 Proxy" id="t3-proxy">
        <SettingsRow
          title="Mode"
          description="Server owns your accounts. Client routes T3's agents through another machine."
          control={
            <div className="flex gap-2">
              {(["disabled", "server", "client"] as const).map((choice) => (
                <Button
                  key={choice}
                  size="sm"
                  variant={
                    (choosingClient ? choice === "client" : mode === choice) ? "default" : "outline"
                  }
                  disabled={busy}
                  aria-pressed={choosingClient ? choice === "client" : mode === choice}
                  onClick={() => {
                    setChoosingClient(choice === "client");
                    if (choice !== "client")
                      void run({ action: choice === "server" ? "start" : "stop" });
                  }}
                >
                  {choice === "disabled" ? "Disabled" : choice === "server" ? "Server" : "Client"}
                </Button>
              ))}
            </div>
          }
        />
        <SettingsRow
          title="CLI routing"
          description="New Codex, Claude, and T3-managed OpenCode sessions launched by T3 use the configured proxy. Existing sessions keep their settings. Your terminal's CLI configuration stays untouched."
          status={
            proxyClient.configured
              ? proxyClient.local
                ? "Using this machine"
                : `Using ${proxyClient.url}`
              : "Proxy routing is disabled"
          }
        />
        {state.enabled && (
          <>
            <SettingsRow
              title="Account selection"
              description="Choose an account for new sessions. Active sessions stay on their assigned account to preserve prompt caching."
              control={
                <Select
                  value={state.strategy}
                  disabled={busy}
                  onValueChange={(strategy) => {
                    if (
                      strategy === "round-robin" ||
                      strategy === "closest-reset" ||
                      strategy === "least-active-sessions"
                    )
                      void run({ action: "setStrategy", strategy });
                  }}
                >
                  <SelectTrigger size="sm">
                    <SelectValue>
                      {state.strategy === "round-robin"
                        ? "Round-Robin"
                        : state.strategy === "closest-reset"
                          ? "Closest to Reset"
                          : "Least Active Sessions"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="closest-reset">Closest to Reset</SelectItem>
                    <SelectItem value="round-robin">Round-Robin</SelectItem>
                    <SelectItem value="least-active-sessions">Least Active Sessions</SelectItem>
                  </SelectPopup>
                </Select>
              }
            />
            <SettingsRow
              title="Sticky session idle time"
              description="Keep a session on the same account for this many minutes after its last request finishes. Requests in progress keep their binding. Default: 12 minutes."
              control={
                <div className="flex items-center gap-2">
                  <Input
                    aria-label="Sticky session idle minutes"
                    type="number"
                    min={1}
                    max={1440}
                    step={1}
                    value={stickyMinutes ?? String(state.stickyIdleMinutes)}
                    onChange={(event) => setStickyMinutes(event.target.value)}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      busy ||
                      !Number.isInteger(Number(stickyMinutes)) ||
                      Number(stickyMinutes) < 1 ||
                      Number(stickyMinutes) > 1440 ||
                      Number(stickyMinutes) === state.stickyIdleMinutes
                    }
                    onClick={() =>
                      void run({
                        action: "setStickyIdleMinutes",
                        minutes: Number(stickyMinutes),
                      }).then((value) => {
                        if (value) setStickyMinutes(null);
                      })
                    }
                  >
                    Save
                  </Button>
                </div>
              }
            />
            <SettingsRow
              title="API access"
              description={`Endpoint: ${state.endpointPath}. Other T3 machines obtain the key when you select this server.`}
              control={
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void run({ action: "revealKey" }).then((value) => {
                        if (value?.apiKey) void writeTextToClipboard(value.apiKey);
                      })
                    }
                  >
                    Copy API key
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      if (
                        window.confirm(
                          "Rotate the proxy key? Reconnect clients that use the old key.",
                        )
                      )
                        void run({ action: "rotateKey" });
                    }}
                  >
                    Rotate key
                  </Button>
                </div>
              }
            />
          </>
        )}
      </SettingsSection>
      {(choosingClient || mode === "client") && (
        <SettingsSection title="Proxy server">
          {environments
            .filter(
              (peer) =>
                peer.environmentId !== environmentId && peer.connection.phase === "connected",
            )
            .map((peer) => (
              <ConnectedProxyServer
                key={peer.environmentId}
                peer={peer}
                busy={busy}
                onConnect={async (url, key, fallbackUrls) => {
                  const value = await run({
                    action: "configureClient",
                    url,
                    apiKey: key,
                    fallbackUrls,
                  });
                  if (value) setChoosingClient(false);
                }}
              />
            ))}
          <SettingsRow
            title="Server address"
            description="For a machine without a reachable LAN or tailnet address, enter its T3 Proxy endpoint and API key."
          >
            <div className="grid gap-2 py-3">
              <Input
                aria-label="Proxy server URL"
                placeholder="https://machine:3773/api/model-proxy"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
              <Input
                aria-label="Proxy API key"
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
              />
              <div>
                <Button
                  size="sm"
                  disabled={busy || !url.trim() || !apiKey.trim()}
                  onClick={() =>
                    void run({
                      action: "configureClient",
                      url: url.trim(),
                      apiKey: apiKey.trim(),
                    }).then((value) => {
                      if (value) {
                        setApiKey("");
                        setChoosingClient(false);
                      }
                    })
                  }
                >
                  Connect
                </Button>
              </div>
            </div>
          </SettingsRow>
        </SettingsSection>
      )}
      {state.enabled && (
        <SettingsSection
          title={`Accounts · ${state.accounts.length}`}
          headerAction={
            <Button
              size="xs"
              variant="outline"
              disabled={busy}
              onClick={() => void run({ action: "refresh" })}
            >
              Refresh quotas
            </Button>
          }
        >
          <SettingsRow
            title="Add an OAuth account"
            description="Sign in again to add another account for the same provider."
            control={
              <div className="flex flex-wrap gap-2">
                {ModelProxyProvider.literals.map((provider) => (
                  <Button
                    key={provider}
                    size="sm"
                    variant="outline"
                    disabled={busy || flow?.status === "wait"}
                    onClick={() => {
                      setCallback("");
                      void run({ action: "authStart", provider });
                    }}
                  >
                    {PROXY_PROVIDER_LABELS[provider]}
                  </Button>
                ))}
              </div>
            }
          />
          {flow && flow.status === "wait" && (
            <SettingsRow
              title={`Sign in to ${PROXY_PROVIDER_LABELS[flow.provider]}`}
              description="Open the sign-in page. After approval, paste the complete callback URL here, even if localhost fails to load. For a device login, check sign-in instead."
            >
              <div className="space-y-3 py-3">
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void ensureLocalApi().shell.openExternal(flow.url)}
                  >
                    Open sign-in
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void writeTextToClipboard(flow.url)}
                  >
                    Copy link
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void run({ action: "authStatus", provider: flow.provider, state: flow.state })
                    }
                  >
                    Check sign-in
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void run({ action: "authCancel", state: flow.state }).then((value) => {
                        if (value) setFlow(undefined);
                      })
                    }
                  >
                    Cancel
                  </Button>
                </div>
                <Input
                  aria-label="OAuth callback URL"
                  autoComplete="off"
                  placeholder="Paste full callback URL"
                  value={callback}
                  onChange={(event) => setCallback(event.target.value)}
                />
                <Button
                  size="sm"
                  disabled={busy || !callback.trim()}
                  onClick={() =>
                    void run({
                      action: "authComplete",
                      provider: flow.provider,
                      state: flow.state,
                      redirectUrl: callback.trim(),
                    }).then((value) => {
                      if (value) setCallback("");
                    })
                  }
                >
                  Complete sign-in
                </Button>
              </div>
            </SettingsRow>
          )}
          {flow?.status === "ok" && (
            <p className="p-4 text-sm" role="status">
              Account connected.
            </p>
          )}
          {flow?.status === "error" && (
            <p className="p-4 text-sm text-destructive" role="alert">
              Sign-in expired or was declined. Start again.
            </p>
          )}
          {state.accounts.map((account) => (
            <SettingsRow
              key={account.id}
              title={account.email ?? account.name}
              description={`${account.provider} · ${account.status}`}
              control={
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      void run({
                        action: "setAccountEnabled",
                        name: account.name,
                        enabled: account.disabled,
                      })
                    }
                  >
                    {account.disabled ? "Enable" : "Disable"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm(`Remove ${account.email ?? account.name} from T3 Proxy?`))
                        void run({ action: "removeAccount", name: account.name });
                    }}
                  >
                    Remove
                  </Button>
                </div>
              }
            />
          ))}
          <SettingsRow
            title="Import credentials"
            description="Import an existing CLI Proxy API JSON credential file."
            control={
              <Input
                type="file"
                accept=".json,application/json"
                aria-label="Import proxy credentials"
                disabled={busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  void file
                    .text()
                    .then((text) => {
                      const credential: unknown = JSON.parse(text);
                      if (
                        credential === null ||
                        typeof credential !== "object" ||
                        Array.isArray(credential)
                      )
                        throw new Error("Expected a credential object");
                      return run({
                        action: "importAccount",
                        name: file.name,
                        credential: credential as Record<string, unknown>,
                      });
                    })
                    .catch(() => setError("Could not read this credential file."));
                  event.target.value = "";
                }}
              />
            }
          />
        </SettingsSection>
      )}
      {(error ?? state.error ?? query.error) && (
        <p className="text-sm text-destructive" role="alert">
          {error ?? state.error ?? query.error}
        </p>
      )}
    </SettingsPageContainer>
  );
}

function ConnectedProxyServer({
  peer,
  busy,
  onConnect,
}: {
  peer: EnvironmentPresentation;
  busy: boolean;
  onConnect: (url: string, key: string, fallbackUrls: string[]) => Promise<void>;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.modelProxyStatus({ environmentId: peer.environmentId, input: {} }),
  );
  const command = useAtomCommand(serverEnvironment.manageModelProxy);
  const [connecting, setConnecting] = useState(false);
  const [url, ...fallbackUrls] = modelProxyServerUrls(peer);
  return (
    <SettingsRow
      title={peer.label}
      description={
        query.error ??
        (!query.data
          ? "Checking proxy…"
          : query.data.enabled
            ? (url ?? "Enter a reachable address below.")
            : "Enable Server mode on this machine first.")
      }
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={busy || connecting || !url || !query.data?.enabled}
          onClick={() => {
            if (!url) return;
            setConnecting(true);
            void command({ environmentId: peer.environmentId, input: { action: "revealKey" } })
              .then(async (result) => {
                if (result._tag === "Success" && result.value.apiKey)
                  await onConnect(url, result.value.apiKey, fallbackUrls);
              })
              .finally(() => setConnecting(false));
          }}
        >
          Use this server
        </Button>
      }
    />
  );
}
