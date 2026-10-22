import * as Schema from "effect/Schema";
import type { PluginLaunch } from "@t3tools/contracts";

export const PluginMessage = Schema.Struct({
  kind: Schema.Literals(["call", "reply", "host-call", "host-reply", "changed"]),
  id: Schema.Int,
  method: Schema.String,
  ok: Schema.Boolean,
  payload: Schema.Json,
});
export type PluginMessage = typeof PluginMessage.Type;
export const decodePluginMessage = Schema.decodeUnknownSync(Schema.fromJsonString(PluginMessage));
export const MAX_PLUGIN_MESSAGE_BYTES = 1024 * 1024;

const WireLaunch = Schema.Struct({
  provider: Schema.String,
  purpose: Schema.Literals(["agent", "text-generation", "managed-server"]),
  cwd: Schema.optionalKey(Schema.String),
  args: Schema.Array(Schema.String),
  environment: Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Null])),
});
const decodeLaunch = Schema.decodeUnknownSync(WireLaunch);

// JSON drops undefined properties. Null explicitly carries environment deletion
// across the process boundary, while the public API retains Node's convention.
export function encodePluginLaunch(launch: PluginLaunch): Schema.Json {
  return {
    ...launch,
    environment: Object.fromEntries(
      Object.entries(launch.environment).map(([key, value]) => [key, value ?? null]),
    ),
  };
}
export function decodePluginLaunch(value: Schema.Json): PluginLaunch {
  const launch = decodeLaunch(value);
  return {
    ...launch,
    environment: Object.fromEntries(
      Object.entries(launch.environment).map(([key, value]) => [key, value ?? undefined]),
    ),
  };
}
