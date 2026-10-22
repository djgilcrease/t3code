import type { PluginBlock, PluginInput } from "@t3tools/contracts";
import { PluginSecretResult } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

const decodeSecretResult = Schema.decodeUnknownOption(PluginSecretResult);
export function pluginSecretResult(value: unknown): PluginSecretResult | null {
  return Option.getOrNull(decodeSecretResult(value));
}

export type PluginForm = Extract<PluginBlock, { readonly kind: "form" }>;

/** Passwords are never populated from server defaults. */
export function pluginFormDefaults(form: PluginForm): PluginInput {
  return Object.fromEntries(
    form.fields.map((field) => [
      field.name,
      field.kind === "password" ? "" : (field.value ?? (field.kind === "boolean" ? false : "")),
    ]),
  );
}

export function pluginFormInput(form: PluginForm, values: PluginInput): PluginInput | null {
  const input: Record<string, PluginInput[string]> = { ...form.input };
  for (const field of form.fields) {
    const value = values[field.name];
    if (field.required && (value === undefined || value === null || value === "")) return null;
    if (field.kind === "number") {
      if (value === "" || value === undefined) continue;
      const number = Number(value);
      if (!Number.isFinite(number)) return null;
      input[field.name] = number;
    } else if (field.kind === "select") {
      if ((value === undefined || value === "") && !field.required) continue;
      if (!field.options?.some((option) => option.value === value)) return null;
      if (value !== undefined) input[field.name] = value;
    } else if (field.kind === "boolean") {
      input[field.name] = value === true;
    } else {
      input[field.name] = typeof value === "string" ? value : "";
    }
  }
  return input;
}

/** Plugin links may open a sign-in page, never execute a URL scheme in the client. */
export function pluginLink(url: string): string | null {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      !parsed.username &&
      !parsed.password
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}
