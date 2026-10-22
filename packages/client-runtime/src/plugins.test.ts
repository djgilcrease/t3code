import { describe, expect, it } from "vite-plus/test";
import {
  pluginFormDefaults,
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
