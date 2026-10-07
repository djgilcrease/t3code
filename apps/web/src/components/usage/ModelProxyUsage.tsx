import type { EnvironmentId, ModelProxyAccount } from "@t3tools/contracts";
import { formatResetsIn, remainingPercent } from "@t3tools/shared/usageLimits";
import { useState } from "react";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

/** Added quota detail is mounted only for configured proxies; ordinary limits stay unchanged. */
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
  const [filter, setFilter] = useState("all");
  const [showEmails, setShowEmails] = useState(false);
  const [busy, setBusy] = useState(false);
  const state = query.data;
  if (!state?.client.configured || (state.accounts.length === 0 && !state.error)) return null;
  const providers = [...new Set(state.accounts.map((account) => account.provider))];
  const accounts =
    filter === "all"
      ? state.accounts
      : state.accounts.filter((account) => account.provider === filter);
  return (
    <section className="space-y-5" aria-label={`T3 Proxy quotas on ${label}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">T3 Proxy · {label}</h2>
          <p className="text-xs text-muted-foreground">
            {state.accounts.length} accounts ·{" "}
            {state.accounts.filter((account) => !account.disabled).length} enabled
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setShowEmails(!showEmails)}>
            {showEmails ? "Hide emails" : "Show emails"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void command({ environmentId, input: { action: "refresh" } })
                .then(() => query.refresh())
                .finally(() => setBusy(false));
            }}
          >
            Refresh quotas
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter proxy accounts">
        {["all", ...providers].map((provider) => (
          <Button
            key={provider}
            size="sm"
            variant={filter === provider ? "default" : "outline"}
            onClick={() => setFilter(provider)}
          >
            {provider === "all" ? "All" : provider} ·{" "}
            {provider === "all"
              ? state.accounts.length
              : state.accounts.filter((account) => account.provider === provider).length}
          </Button>
        ))}
      </div>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-px overflow-hidden rounded-xl border border-border bg-border">
        {providers.map((provider) => {
          const pool = state.accounts.filter(
            (account) => account.provider === provider && !account.disabled,
          );
          const windowIds = [
            ...new Set(
              pool.flatMap(
                (account) => account.usageLimits?.windows.map((window) => window.id) ?? [],
              ),
            ),
          ];
          return (
            <div className="space-y-3 bg-background p-5" key={provider}>
              <h3 className="font-medium">
                {provider}{" "}
                <span className="text-xs text-muted-foreground">{pool.length} accounts</span>
              </h3>
              {windowIds.map((id) => {
                const windows = pool.flatMap(
                  (account) =>
                    account.usageLimits?.windows
                      .filter((window) => window.id === id)
                      .map((window) => ({ ...window, accountId: account.id })) ?? [],
                );
                return (
                  <div className="space-y-2" key={id}>
                    <p className="text-xs text-muted-foreground">{windows[0]?.label}</p>
                    <div className="text-3xl font-semibold tabular-nums">
                      {Math.round(
                        windows.reduce((sum, window) => sum + remainingPercent(window), 0),
                      )}
                      %
                      <span className="ml-2 text-sm font-normal text-muted-foreground">
                        of {windows.length * 100}% left
                      </span>
                    </div>
                    <div className="flex gap-1">
                      {windows.map((window) => (
                        <div
                          key={window.accountId}
                          className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted"
                        >
                          <div
                            className={
                              remainingPercent(window) < 20
                                ? "h-full bg-destructive"
                                : remainingPercent(window) < 60
                                  ? "h-full bg-warning"
                                  : "h-full bg-success"
                            }
                            style={{ width: `${remainingPercent(window)}%` }}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
              {windowIds.length === 0 && (
                <p className="text-xs text-muted-foreground">Quota unavailable</p>
              )}
            </div>
          );
        })}
      </div>
      <div className="divide-y divide-border">
        {accounts.map((account) => (
          <ProxyAccountRow key={account.id} account={account} showEmails={showEmails} now={now} />
        ))}
      </div>
      {state.error && (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      )}
    </section>
  );
}

function ProxyAccountRow({
  account,
  showEmails,
  now,
}: {
  account: ModelProxyAccount;
  showEmails: boolean;
  now: number;
}) {
  return (
    <div className="grid gap-4 py-5 md:grid-cols-[minmax(12rem,1fr)_3fr]">
      <div className="min-w-0">
        <p className="truncate font-mono text-sm">
          {showEmails
            ? (account.email ?? account.name)
            : `${account.provider} · ${account.id.slice(0, 8)}`}
        </p>
        <p className="text-xs text-muted-foreground">
          {account.status} · {account.activeSessions ?? 0} active sessions
        </p>
      </div>
      <div className="grid gap-5 sm:grid-cols-3">
        {account.usageLimits?.windows.map((window) => {
          const remaining = remainingPercent(window);
          return (
            <div className="space-y-2" key={window.id}>
              <div className="flex justify-between gap-2 text-xs">
                <span>{window.label}</span>
                <span className="font-semibold tabular-nums">{remaining}% left</span>
              </div>
              <div
                role="meter"
                aria-label={`${window.label} remaining`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={remaining}
                className="h-1.5 overflow-hidden rounded-full bg-muted"
              >
                <div
                  className={
                    remaining < 20
                      ? "h-full bg-destructive"
                      : remaining < 60
                        ? "h-full bg-warning"
                        : "h-full bg-success"
                  }
                  style={{ width: `${remaining}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {formatResetsIn(window, now) ?? "No reset reported"}
              </p>
            </div>
          );
        })}
        {(!account.usageLimits?.windows.length || account.usageLimits.unavailable) && (
          <p className="text-xs text-muted-foreground">
            {account.usageLimits?.unavailable?.message ?? "This provider does not report quota."}
          </p>
        )}
      </div>
    </div>
  );
}
