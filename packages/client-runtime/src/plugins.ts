import type {
  PluginBlock,
  PluginInput,
  PluginCatalog,
  PluginStatusAction,
} from "@t3tools/contracts";
import {
  PluginEnvironmentLaunchResult,
  PluginNoticeResult,
  PluginRelayResult,
  PluginSecretResult,
  PluginViewResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";

const decodeEnvironmentLaunchResult = Schema.decodeUnknownOption(PluginEnvironmentLaunchResult);
export function pluginEnvironmentLaunchResult(value: unknown) {
  return Option.getOrNull(decodeEnvironmentLaunchResult(value));
}

const decodeSecretResult = Schema.decodeUnknownOption(PluginSecretResult);
export function pluginSecretResult(value: unknown): PluginSecretResult | null {
  return Option.getOrNull(decodeSecretResult(value));
}

const decodeViewResult = Schema.decodeUnknownOption(PluginViewResult);
export function pluginViewResult(value: unknown): PluginViewResult | null {
  return Option.getOrNull(decodeViewResult(value));
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

export function pluginSettingsPages(catalog: PluginCatalog) {
  return catalog.plugins
    .filter((plugin) => plugin.status === "active")
    .flatMap((plugin) =>
      plugin.views
        .filter((view) => view.location === "settings-page")
        .map((view) => ({
          pluginId: plugin.id,
          viewId: view.id,
          title: view.title,
        })),
    );
}

export type PluginStatus = Extract<PluginBlock, { readonly kind: "status" }>;

export function pluginThreadDetailsViews(catalog: PluginCatalog) {
  return catalog.plugins
    .filter((plugin) => plugin.status === "active")
    .flatMap((plugin) =>
      plugin.views
        .filter((view) => view.location === "thread-details")
        .map((view) => ({ plugin, viewId: view.id })),
    );
}

/** The thread is added last, so a plugin's own input cannot name another thread. */
export function pluginStatusActionInput(
  action: PluginStatusAction,
  threadId: string,
  destination: string | null,
): PluginInput {
  return {
    ...action.input,
    ...(action.environment && destination !== null
      ? { [action.environment.name]: destination }
      : {}),
    threadId,
  };
}

/** An environment picker offers only other environments that run the same plugin. */
export function pluginActionDestinations<
  Target extends { readonly environmentId: string; readonly catalog: PluginCatalog | null },
>(targets: readonly Target[], sourceEnvironmentId: string, pluginId: string): readonly Target[] {
  return targets.filter(
    (target) =>
      target.environmentId !== sourceEnvironmentId &&
      target.catalog?.plugins.some(
        (plugin) => plugin.id === pluginId && plugin.status === "active",
      ) === true,
  );
}

/**
 * Two machines can share a name, such as two servers on one host. A destination whose name
 * matches the current machine or another destination shows its address as well.
 */
export function pluginDestinationLabel(
  target: { readonly label: string; readonly displayUrl: string | null },
  otherLabels: readonly string[],
): string {
  return target.displayUrl !== null && otherLabels.includes(target.label)
    ? `${target.label} (${target.displayUrl})`
    : target.label;
}

export interface PluginActionStep {
  readonly environmentId: string;
  readonly commandId: string;
  readonly input: PluginInput;
}
export type PluginActionReply =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly message: string | null };

const decodeNoticeResult = Schema.decodeUnknownOption(PluginNoticeResult);
const failed = (message: string | null): PluginNoticeResult => ({
  $t3: "notice",
  tone: "danger",
  text: message ?? "The plugin command failed. Try again.",
});

const decodeRelayResult = Schema.decodeUnknownOption(PluginRelayResult);
/** Enough for a large carried transfer; a plugin that never finishes still stops. */
const MAX_PLUGIN_RELAY_STEPS = 5_000;

/**
 * Runs a status action to its end, carrying each relayed step to the environment it names.
 * Null means it finished with nothing to show, or was cancelled.
 */
export async function runPluginAction(options: {
  readonly start: PluginActionStep;
  readonly execute: (step: PluginActionStep) => Promise<PluginActionReply>;
  readonly onStatus?: (status: string) => void;
  readonly signal?: AbortSignal;
}): Promise<PluginNoticeResult | null> {
  let step = options.start;
  for (let count = 0; count < MAX_PLUGIN_RELAY_STEPS; count++) {
    if (options.signal?.aborted) return null;
    const reply = await options.execute(step);
    if (!reply.ok) return failed(reply.message);
    const relay = Option.getOrNull(decodeRelayResult(reply.value));
    if (relay === null) return Option.getOrNull(decodeNoticeResult(reply.value));
    if (relay.status !== undefined) options.onStatus?.(relay.status);
    step = {
      environmentId: relay.environmentId ?? step.environmentId,
      commandId: relay.command,
      input: relay.input,
    };
  }
  return failed("The plugin did not finish. Try again.");
}
