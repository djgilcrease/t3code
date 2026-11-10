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
export function pluginNoticeResult(value: unknown): PluginNoticeResult | null {
  return Option.getOrNull(decodeNoticeResult(value));
}
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

const GRAPH_COLORS = ["#0284c7", "#c026d3", "#16a34a", "#ea580c", "#7c3aed", "#0891b2"];

/** Pending parents keep their lane and color until their node is reached. */
export function pluginGraphLayout(
  nodes: readonly { readonly id: string; readonly parents: readonly string[] }[],
) {
  let lanes: { id: string; color: string }[] = [];
  let nextColor = 0;
  let columns = 1;
  const rows = nodes.map((node) => {
    const existing = lanes.findIndex((lane) => lane.id === node.id);
    const column = existing < 0 ? lanes.length : existing;
    const color =
      existing < 0 ? GRAPH_COLORS[nextColor++ % GRAPH_COLORS.length]! : lanes[column]!.color;
    const before = [...lanes];
    if (existing < 0) lanes.push({ id: node.id, color });
    const next = [...lanes];
    next.splice(column, 1);
    node.parents.forEach((id, i) => {
      if (!next.some((lane) => lane.id === id)) {
        const lane = {
          id,
          color: i === 0 ? color : GRAPH_COLORS[nextColor++ % GRAPH_COLORS.length]!,
        };
        if (i === 0) next.splice(Math.min(column, next.length), 0, lane);
        else next.push(lane);
      }
    });
    const edges: { from: number; to: number; start: number; end: number; color: string }[] = [];
    before.forEach((lane, from) => {
      if (lane.id === node.id) edges.push({ from, to: column, start: 0, end: 22, color });
      else
        edges.push({
          from,
          to: next.findIndex((item) => item.id === lane.id),
          start: 0,
          end: 44,
          color: lane.color,
        });
    });
    node.parents.forEach((parent) => {
      const to = next.findIndex((lane) => lane.id === parent);
      edges.push({ from: column, to, start: 22, end: 44, color: next[to]!.color });
    });
    columns = Math.max(columns, before.length, column + 1, next.length);
    lanes = next;
    return {
      id: node.id,
      column,
      color,
      paths: edges.map((edge) => ({
        color: edge.color,
        d: `M ${10 + edge.from * 16} ${edge.start} C ${10 + edge.from * 16} 22 ${10 + edge.to * 16} 22 ${10 + edge.to * 16} ${edge.end}`,
      })),
    };
  });
  return { width: columns * 16 + 4, rows };
}
