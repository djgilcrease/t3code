import type { ModelProxyStrategy, ServerProviderUsageLimits } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { object, unprefixProxyModel, ProxyPayload } from "./modelProxyProtocols.ts";

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(ProxyPayload));

/** Native CLI identifiers survive changing prompts and compaction; never identify by prompt text. */
export function proxySessionId(
  headers: Readonly<Record<string, string | undefined>>,
  payload: ProxyPayload,
): string | null {
  for (const name of [
    "x-t3-session-id",
    "x-opencode-session",
    "x-opencode-session-id",
    "x-session-affinity",
    "session-id",
    "session_id",
    "x-session-id",
    "x-client-session-id",
    "x-claude-code-session-id",
    "x-grok-conv-id",
    "x-http-session-id",
  ]) {
    const value = headers[name]?.trim();
    if (value) return value;
  }
  const metadata = object(payload.metadata);
  const userId = metadata.user_id;
  if (typeof userId === "string") {
    const nested = decodeJson(userId);
    if (nested._tag === "Some" && typeof nested.value.session_id === "string")
      return nested.value.session_id || null;
    const legacy = /_session_(.+)$/u.exec(userId)?.[1];
    if (legacy) return legacy;
  }
  for (const value of [
    payload.session_id,
    metadata.session_id,
    object(payload.conversation).id,
    payload.prompt_cache_key,
    object(payload.request).sessionId,
    payload.sessionId,
  ]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** Prefer the nearest future reset with usable allowance; unknown resets rank last. */
export function proxyNextReset(limits: ServerProviderUsageLimits | undefined, now: number): number {
  const resets = (limits?.windows ?? []).flatMap((window) => {
    if (!window.resetsAt || window.usedPercent >= 100) return [];
    const reset = Date.parse(window.resetsAt);
    return Number.isFinite(reset) && reset > now ? [reset] : [];
  });
  return resets.length ? Math.min(...resets) : Infinity;
}

/** Google reports independent model pools; another model's quota must not affect selection. */
export function proxyModelQuota(
  limits: ServerProviderUsageLimits | undefined,
  provider: string,
  model: string,
): ServerProviderUsageLimits | undefined {
  if (!limits || limits.unavailable) return undefined;
  if (provider !== "gemini" && provider !== "antigravity") return limits;
  return {
    ...limits,
    windows: limits.windows.filter((window) => window.id === unprefixProxyModel(model)),
  };
}

export function proxyQuotaExhausted(limits: ServerProviderUsageLimits | undefined, now: number) {
  return (limits?.windows ?? []).some(
    (window) =>
      window.usedPercent >= 100 && (!window.resetsAt || Date.parse(window.resetsAt) > now),
  );
}

interface Binding {
  readonly key: string | null;
  readonly accountId: string;
  lastUsedAt: number;
  inFlight: number;
}
interface Candidate {
  readonly id: string;
  readonly nextReset: number;
}

/** Bind before I/O so concurrent new sessions see one another's reservations. */
export class ModelProxyBalancer {
  private readonly sessions = new Map<string, Binding>();
  private readonly live = new Set<Binding>();
  private readonly counts = new Map<string, number>();
  private readonly cursors = new Map<string, string>();

  prune(now: number, idleMs: number) {
    for (const binding of this.live) {
      if (binding.inFlight === 0 && now - binding.lastUsedAt >= idleMs) this.remove(binding);
    }
  }
  clear() {
    this.sessions.clear();
    this.live.clear();
    this.counts.clear();
    this.cursors.clear();
  }
  invalidate(accountId: string) {
    for (const binding of this.live) {
      if (binding.accountId === accountId) this.remove(binding);
    }
  }
  activeSessions(accountId: string) {
    return this.counts.get(accountId) ?? 0;
  }
  private remove(binding: Binding) {
    if (binding.key && this.sessions.get(binding.key) === binding)
      this.sessions.delete(binding.key);
    if (!this.live.delete(binding)) return;
    const count = this.activeSessions(binding.accountId) - 1;
    if (count > 0) this.counts.set(binding.accountId, count);
    else this.counts.delete(binding.accountId);
  }

  acquire(input: {
    readonly provider: string;
    readonly session: string | null;
    readonly candidates: readonly Candidate[];
    readonly strategy: ModelProxyStrategy;
    readonly now: number;
    readonly idleMs: number;
  }) {
    this.prune(input.now, input.idleMs);
    const key = input.session ? `${input.provider}:${input.session}` : null;
    let binding = key ? this.sessions.get(key) : undefined;
    if (binding && !input.candidates.some((account) => account.id === binding?.accountId)) {
      this.remove(binding);
      binding = undefined;
    }
    if (!binding) {
      const lastId = this.cursors.get(input.provider);
      const lastIndex = input.candidates.findIndex((account) => account.id === lastId);
      const start = (lastIndex + 1) % Math.max(1, input.candidates.length);
      const rotated = [...input.candidates.slice(start), ...input.candidates.slice(0, start)];
      const counts = new Map(
        rotated.map((account) => [account.id, this.activeSessions(account.id)]),
      );
      const ranked = rotated.toSorted((a, b) => {
        if (input.strategy === "closest-reset") {
          if (a.nextReset === b.nextReset) return 0;
          return a.nextReset < b.nextReset ? -1 : 1;
        }
        if (input.strategy === "least-active-sessions")
          return counts.get(a.id)! - counts.get(b.id)!;
        return 0;
      });
      const selected = ranked[0];
      if (!selected) return null;
      this.cursors.set(input.provider, selected.id);
      binding = { key, accountId: selected.id, lastUsedAt: input.now, inFlight: 0 };
      this.live.add(binding);
      this.counts.set(selected.id, this.activeSessions(selected.id) + 1);
      if (key) this.sessions.set(key, binding);
    }
    binding.inFlight++;
    binding.lastUsedAt = input.now;
    const reserved = binding;
    let finished = false;
    return {
      accountId: reserved.accountId,
      finish: (now: number, success: boolean) => {
        if (finished) return;
        finished = true;
        reserved.inFlight--;
        reserved.lastUsedAt = now;
        if (!success || !key) {
          if (key && this.sessions.get(key) === reserved) this.sessions.delete(key);
          if (reserved.inFlight === 0) this.remove(reserved);
        } else if (this.sessions.get(key) !== reserved && reserved.inFlight === 0) {
          this.remove(reserved);
        }
      },
    };
  }
}
