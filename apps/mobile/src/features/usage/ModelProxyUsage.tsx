import type { EnvironmentId } from "@t3tools/contracts";
import { remainingPercent, formatResetsIn } from "@t3tools/shared/usageLimits";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

export function ModelProxyUsage({
  environmentId,
  label,
  now,
}: {
  environmentId: EnvironmentId;
  label: string;
  now: number;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.modelProxyStatus({ environmentId, input: {} }),
  );
  const command = useAtomCommand(serverEnvironment.manageModelProxy);
  const [showEmails, setShowEmails] = useState(false);
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState(false);
  const state = query.data;
  if (!state?.client.configured || (state.accounts.length === 0 && !state.error)) return null;
  const providers = [...new Set(state.accounts.map((account) => account.provider))];
  return (
    <View className="gap-5 rounded-xl border border-border p-4">
      <Text className="text-xl font-semibold">T3 Proxy · {label}</Text>
      <Text className="text-foreground-muted">{state.accounts.length} accounts</Text>
      <View className="flex-row flex-wrap gap-4">
        <Pressable accessibilityRole="button" onPress={() => setShowEmails(!showEmails)}>
          <Text>{showEmails ? "Hide emails" : "Show emails"}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          disabled={busy}
          onPress={() => {
            setBusy(true);
            void command({ environmentId, input: { action: "refresh" } })
              .then(() => query.refresh())
              .finally(() => setBusy(false));
          }}
        >
          <Text>{busy ? "Refreshing…" : "Refresh quotas"}</Text>
        </Pressable>
      </View>
      <View className="flex-row flex-wrap gap-4">
        {["all", ...providers].map((provider) => (
          <Pressable
            key={provider}
            accessibilityRole="button"
            accessibilityState={{ selected: filter === provider }}
            onPress={() => setFilter(provider)}
          >
            <Text className={filter === provider ? "font-semibold" : "text-foreground-muted"}>
              {provider === "all" ? "All" : provider}
            </Text>
          </Pressable>
        ))}
      </View>
      {state.accounts
        .filter((account) => filter === "all" || account.provider === filter)
        .map((account) => (
          <View key={account.id} className="gap-3 border-t border-border pt-4">
            <Text>
              {showEmails
                ? (account.email ?? account.name)
                : `${account.provider} · ${account.id.slice(0, 8)}`}
            </Text>
            <Text className="text-sm text-foreground-muted">
              {account.status} · {account.activeSessions ?? 0} active sessions
            </Text>
            {account.usageLimits?.windows.map((window) => {
              const remaining = remainingPercent(window);
              return (
                <View key={window.id} className="gap-2">
                  <View className="flex-row justify-between">
                    <Text className="text-sm">{window.label}</Text>
                    <Text className="text-sm">{remaining}% left</Text>
                  </View>
                  <View
                    accessibilityLabel={`${window.label}: ${remaining}% remaining`}
                    className="h-1.5 overflow-hidden rounded-full bg-subtle-strong"
                  >
                    <View
                      className={
                        remaining < 20
                          ? "h-full bg-danger-foreground"
                          : remaining < 60
                            ? "h-full bg-warning-foreground"
                            : "h-full bg-primary"
                      }
                      style={{ width: `${remaining}%` }}
                    />
                  </View>
                  <Text className="text-xs text-foreground-muted">
                    {formatResetsIn(window, now) ?? "No reset reported"}
                  </Text>
                </View>
              );
            })}
            {(!account.usageLimits?.windows.length || account.usageLimits.unavailable) && (
              <Text className="text-sm text-foreground-muted">
                {account.usageLimits?.unavailable?.message ?? "Quota unavailable"}
              </Text>
            )}
          </View>
        ))}
      {state.error && <Text className="text-danger-foreground">{state.error}</Text>}
    </View>
  );
}
