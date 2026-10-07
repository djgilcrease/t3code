import { describe, expect, it } from "@effect/vitest";
import {
  ModelProxyBalancer,
  proxySessionId,
  proxyNextReset,
  proxyModelQuota,
  proxyQuotaExhausted,
} from "./modelProxyBalancer.ts";

const candidates = [
  { id: "a", nextReset: 20_000 },
  { id: "b", nextReset: 10_000 },
  { id: "c", nextReset: Infinity },
];
const input = {
  provider: "codex",
  session: "session",
  candidates,
  strategy: "round-robin" as const,
  now: 0,
  idleMs: 12 * 60_000,
};

describe("T3 Proxy session balancing", () => {
  it("round-robins new sessions and keeps successive turns sticky", () => {
    const balancer = new ModelProxyBalancer();
    const first = balancer.acquire(input)!;
    first.finish(0, true);
    const second = balancer.acquire({ ...input, session: "other" })!;
    second.finish(0, true);
    const repeated = balancer.acquire({ ...input, now: 100 })!;
    expect([first.accountId, second.accountId, repeated.accountId]).toEqual(["a", "b", "a"]);
    expect(balancer.activeSessions("a")).toBe(1);
  });
  it("expires after idle time, resetting the timer when a request finishes", () => {
    const balancer = new ModelProxyBalancer();
    const first = balancer.acquire(input)!;
    first.finish(30_000, true);
    const repeated = balancer.acquire({ ...input, now: 30_000 + input.idleMs - 1 })!;
    expect(repeated.accountId).toBe("a");
    repeated.finish(800_000, true);
    const expired = balancer.acquire({ ...input, now: 800_000 + input.idleMs })!;
    expect(expired.accountId).toBe("b");
    expect(balancer.activeSessions("a")).toBe(0);
  });
  it("keeps long requests active beyond the idle deadline", () => {
    const balancer = new ModelProxyBalancer();
    const streaming = balancer.acquire(input)!;
    const repeated = balancer.acquire({ ...input, now: input.idleMs * 3 })!;
    expect(repeated.accountId).toBe(streaming.accountId);
    expect(balancer.activeSessions("a")).toBe(1);
    streaming.finish(input.idleMs * 3, true);
    repeated.finish(input.idleMs * 3, true);
    balancer.prune(input.idleMs * 4 - 1, input.idleMs);
    expect(balancer.activeSessions("a")).toBe(1);
    balancer.prune(input.idleMs * 4, input.idleMs);
    expect(balancer.activeSessions("a")).toBe(0);
  });
  it("prefers the closest known reset, retaining existing session bindings", () => {
    const balancer = new ModelProxyBalancer();
    const first = balancer.acquire({ ...input, strategy: "closest-reset" })!;
    first.finish(0, true);
    expect(first.accountId).toBe("b");
    const reversed = candidates.map((account) => ({
      ...account,
      nextReset: account.id === "a" ? 1000 : Infinity,
    }));
    expect(
      balancer.acquire({ ...input, candidates: reversed, strategy: "closest-reset" })?.accountId,
    ).toBe("b");
    expect(
      balancer.acquire({
        ...input,
        candidates: reversed,
        session: "new",
        strategy: "closest-reset",
      })?.accountId,
    ).toBe("a");
  });
  it("counts idle-but-live sessions rather than turns for least-active selection", () => {
    const balancer = new ModelProxyBalancer();
    const busy = balancer.acquire({ ...input, candidates: [candidates[0]!] })!;
    busy.finish(0, true);
    const least = balancer.acquire({
      ...input,
      session: "new",
      strategy: "least-active-sessions",
    })!;
    expect(least.accountId).toBe("b");
    least.finish(0, true);
    const next = balancer.acquire({
      ...input,
      session: "third",
      strategy: "least-active-sessions",
    })!;
    expect(next.accountId).toBe("c");
    expect(
      balancer.acquire({
        ...input,
        session: "expired",
        now: input.idleMs,
        strategy: "least-active-sessions",
      })?.accountId,
    ).toBe("a");
  });
  it("reserves before I/O so concurrent sessions and concurrent turns are assigned correctly", () => {
    const balancer = new ModelProxyBalancer();
    const first = balancer.acquire({ ...input, strategy: "least-active-sessions" })!;
    const same = balancer.acquire({ ...input, strategy: "least-active-sessions" })!;
    const other = balancer.acquire({
      ...input,
      session: "other",
      strategy: "least-active-sessions",
    })!;
    expect([first.accountId, same.accountId, other.accountId]).toEqual(["a", "a", "b"]);
    expect(balancer.activeSessions("a")).toBe(1);
    first.finish(0, true);
    first.finish(0, true);
    same.finish(0, true);
    balancer.prune(input.idleMs, input.idleMs);
    expect(balancer.activeSessions("a")).toBe(0);
  });
  it("fails over a sticky session and drops bindings for disabled or removed accounts", () => {
    const balancer = new ModelProxyBalancer();
    const first = balancer.acquire(input)!;
    first.finish(0, true);
    balancer.invalidate("a");
    const next = balancer.acquire({ ...input, candidates: candidates.slice(1) })!;
    next.finish(0, true);
    expect(next.accountId).toBe("b");
    expect(balancer.acquire(input)?.accountId).toBe("b");
    expect(balancer.activeSessions("a")).toBe(0);
  });
  it("does not pin requests without a session or failed reservations", () => {
    const balancer = new ModelProxyBalancer();
    const first = balancer.acquire({ ...input, session: null })!;
    first.finish(0, true);
    expect(balancer.activeSessions("a")).toBe(0);
    const failed = balancer.acquire(input)!;
    failed.finish(0, false);
    expect(balancer.activeSessions(failed.accountId)).toBe(0);
    expect(balancer.acquire(input)?.accountId).toBe("c");
  });
  it("isolates the same session identifier between providers and clears bindings on stop", () => {
    const balancer = new ModelProxyBalancer();
    const codex = balancer.acquire(input)!;
    codex.finish(0, true);
    const claude = balancer.acquire({
      ...input,
      provider: "claude",
      candidates: [{ id: "claude", nextReset: Infinity }],
    })!;
    expect(claude.accountId).toBe("claude");
    balancer.clear();
    expect(balancer.activeSessions("a")).toBe(0);
    expect(balancer.activeSessions("claude")).toBe(0);
  });
});

describe("CLI cache identities and usable resets", () => {
  it.each([
    "session-id",
    "session_id",
    "x-opencode-session",
    "x-claude-code-session-id",
    "x-t3-session-id",
  ])("recognizes %s ahead of body hints", (header) => {
    expect(proxySessionId({ [header]: "session" }, { prompt_cache_key: "cache" })).toBe("session");
  });
  it("recognizes Codex cache keys, Claude metadata, and Google session IDs", () => {
    expect(proxySessionId({}, { prompt_cache_key: "codex" })).toBe("codex");
    expect(
      proxySessionId({}, { metadata: { user_id: "user_abc_account_def_session_claude" } }),
    ).toBe("claude");
    expect(proxySessionId({}, { metadata: { user_id: '{"session_id":"claude-json"}' } })).toBe(
      "claude-json",
    );
    expect(proxySessionId({}, { request: { sessionId: "google" } })).toBe("google");
    expect(proxySessionId({}, { input: "Same prompt" })).toBeNull();
  });
  it("ignores exhausted, unknown, and past resets, and separates Google model pools", () => {
    const quota = {
      checkedAt: "2026-10-01T00:00:00Z",
      windows: [
        {
          id: "gemini-a",
          kind: "other" as const,
          label: "A",
          usedPercent: 50,
          resetsAt: "2026-10-01T01:00:00Z",
        },
        {
          id: "gemini-b",
          kind: "other" as const,
          label: "B",
          usedPercent: 100,
          resetsAt: "2026-10-01T00:10:00Z",
        },
      ],
    };
    const now = Date.parse(quota.checkedAt);
    expect(proxyNextReset(quota, now)).toBe(Date.parse("2026-10-01T01:00:00Z"));
    expect(proxyNextReset(undefined, now)).toBe(Infinity);
    expect(proxyNextReset(quota, now + 3600_000)).toBe(Infinity);
    expect(proxyQuotaExhausted(proxyModelQuota(quota, "gemini", "gemini-a"), now)).toBe(false);
    expect(proxyQuotaExhausted(proxyModelQuota(quota, "gemini", "gemini-b"), now)).toBe(true);
    expect(
      proxyQuotaExhausted(
        proxyModelQuota({ ...quota, unavailable: { reason: "probeFailed" } }, "gemini", "gemini-b"),
        now,
      ),
    ).toBe(false);
  });
});
