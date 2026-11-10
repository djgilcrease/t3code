import { describe, expect, it } from "vite-plus/test";
import {
  pluginActionDestinations,
  pluginDestinationLabel,
  pluginStatusActionInput,
  runPluginAction,
  pluginFormDefaults,
  pluginSettingsPages,
  pluginFormInput,
  pluginLink,
  pluginSecretResult,
  type PluginForm,
} from "./plugins.ts";

const form: PluginForm = {
  id: "configure",
  kind: "form",
  label: "Save",
  command: "save",
  input: { account: "one" },
  fields: [
    { name: "token", label: "Token", kind: "password", value: "must-not-prefill", required: true },
    { name: "idle", label: "Idle minutes", kind: "number", value: 12 },
    { name: "enabled", label: "Enabled", kind: "boolean", value: true },
    {
      name: "strategy",
      label: "Strategy",
      kind: "select",
      value: "round-robin",
      options: [{ label: "Round robin", value: "round-robin" }],
    },
  ],
};
describe("portable plugin forms", () => {
  it("never prefills a password and preserves typed defaults", () => {
    expect(pluginFormDefaults(form)).toEqual({
      token: "",
      idle: 12,
      enabled: true,
      strategy: "round-robin",
    });
  });
  it("merges form values into the command payload using portable types", () => {
    expect(
      pluginFormInput(form, {
        token: "private",
        idle: "25",
        enabled: true,
        strategy: "round-robin",
      }),
    ).toEqual({
      account: "one",
      token: "private",
      idle: 25,
      enabled: true,
      strategy: "round-robin",
    });
  });
  it("rejects missing required fields, non-finite numbers, and unknown choices", () => {
    const defaults = pluginFormDefaults(form);
    expect(pluginFormInput(form, defaults)).toBeNull();
    expect(pluginFormInput(form, { ...defaults, token: "key", idle: "Infinity" })).toBeNull();
    expect(pluginFormInput(form, { ...defaults, token: "key", strategy: "unexpected" })).toBeNull();
  });
  it("accepts web sign-in links and rejects executable, relative, and credential-bearing URLs", () => {
    expect(pluginLink("https://provider.example/signin?state=one")).toBe(
      "https://provider.example/signin?state=one",
    );
    expect(pluginLink("http://localhost:3000/callback")).toBe("http://localhost:3000/callback");
    expect(pluginLink("javascript:alert(1)")).toBeNull();
    expect(pluginLink("file:///etc/passwd")).toBeNull();
    expect(pluginLink("/relative")).toBeNull();
    expect(pluginLink("https://token:secret@provider.example/")).toBeNull();
  });
});

it("allows an optional select to remain empty", () => {
  const optional: PluginForm = {
    ...form,
    fields: [
      { name: "region", label: "Region", kind: "select", options: [{ label: "US", value: "us" }] },
    ],
  };
  expect(pluginFormInput(optional, { region: "" })).toEqual({ account: "one" });
});

it("recognizes only bounded explicit secret feedback", () => {
  expect(pluginSecretResult({ $t3: "secret", label: "API key", value: "private" })).toEqual({
    $t3: "secret",
    label: "API key",
    value: "private",
  });
  expect(pluginSecretResult({ value: "private" })).toBeNull();
  expect(
    pluginSecretResult({ $t3: "secret", label: "API key", value: "x".repeat(20_000) }),
  ).toBeNull();
});

it("removes extension navigation when the last contributing page is disabled, removed, or withdrawn", () => {
  const plugin = {
    id: "example",
    name: "Example",
    version: "1.0.0",
    status: "active" as const,
    commands: [],
    views: [
      {
        id: "settings",
        title: "Example settings",
        location: "settings-page" as const,
        permission: "settings:write" as const,
      },
    ],
  };
  expect(pluginSettingsPages({ configurationError: false, plugins: [plugin] })).toEqual([
    { pluginId: "example", viewId: "settings", title: "Example settings" },
  ]);
  expect(
    pluginSettingsPages({
      configurationError: false,
      plugins: [{ ...plugin, status: "disabled" }],
    }),
  ).toEqual([]);
  expect(pluginSettingsPages({ configurationError: false, plugins: [] })).toEqual([]);
  expect(
    pluginSettingsPages({
      configurationError: false,
      plugins: [{ ...plugin, views: [{ ...plugin.views[0]!, location: "usage" }] }],
    }),
  ).toEqual([]);
});

describe("thread details actions", () => {
  const action = {
    id: "move",
    label: "Move",
    command: "move",
    input: { threadId: "another-thread", keep: 1 },
    environment: { name: "destination", label: "Move to" },
  };
  const active = { id: "rehome", name: "Rehome", version: "1.0.0", commands: [], views: [] };
  const catalog = (status: "active" | "disabled") => ({
    configurationError: false,
    plugins: [{ ...active, status }],
  });

  it("names the pressed thread even when the plugin's own input names another", () => {
    expect(pluginStatusActionInput(action, "pressed-thread", "env-b")).toEqual({
      keep: 1,
      destination: "env-b",
      threadId: "pressed-thread",
    });
  });
  it("offers only other environments where the plugin is running", () => {
    expect(
      pluginActionDestinations(
        [
          { environmentId: "source", catalog: catalog("active") },
          { environmentId: "running", catalog: catalog("active") },
          { environmentId: "disabled", catalog: catalog("disabled") },
          { environmentId: "loading", catalog: null },
        ],
        "source",
        "rehome",
      ).map((target) => target.environmentId),
    ).toEqual(["running"]);
  });
  it("shows a destination's address only when its name alone would be ambiguous", () => {
    const server = { label: "system76-pc", displayUrl: "http://localhost:16126" };
    expect(pluginDestinationLabel(server, ["macbook"])).toBe("system76-pc");
    expect(pluginDestinationLabel(server, ["system76-pc"])).toBe(
      "system76-pc (http://localhost:16126)",
    );
    expect(pluginDestinationLabel({ ...server, displayUrl: null }, ["system76-pc"])).toBe(
      "system76-pc",
    );
  });
  it("turns a failed command into a notice and passes a plugin's notice through", async () => {
    const start = { environmentId: "source", commandId: "move", input: {} };
    expect(
      await runPluginAction({ start, execute: async () => ({ ok: false, message: null }) }),
    ).toMatchObject({ tone: "danger" });
    const notice = { $t3: "notice", tone: "success", text: "Moved." };
    expect(
      await runPluginAction({ start, execute: async () => ({ ok: true, value: notice }) }),
    ).toEqual(notice);
    expect(
      await runPluginAction({ start, execute: async () => ({ ok: true, value: { any: 1 } }) }),
    ).toBeNull();
  });
  it("carries relayed steps between environments until the plugin ends or the user cancels", async () => {
    const start = { environmentId: "source", commandId: "move", input: {} };
    const steps: Array<string> = [];
    const statuses: Array<string> = [];
    const execute = async (step: typeof start) => {
      steps.push(`${step.environmentId}:${step.commandId}`);
      const value =
        step.commandId === "move"
          ? { $t3: "relay", environmentId: "destination", command: "accept", input: { n: 1 } }
          : step.commandId === "accept"
            ? { $t3: "relay", command: "import", input: {}, status: "Copying work" }
            : { $t3: "notice", tone: "success", text: "Moved." };
      return { ok: true as const, value };
    };
    expect(
      await runPluginAction({ start, execute, onStatus: (status) => statuses.push(status) }),
    ).toMatchObject({ text: "Moved." });
    // A step without an environment stays where the previous one ran.
    expect(steps).toEqual(["source:move", "destination:accept", "destination:import"]);
    expect(statuses).toEqual(["Copying work"]);

    const controller = new AbortController();
    steps.length = 0;
    const cancelled = await runPluginAction({
      start,
      signal: controller.signal,
      execute: async (step) => {
        controller.abort();
        return execute(step);
      },
    });
    expect(cancelled).toBeNull();
    expect(steps).toEqual(["source:move"]);
  });
});
