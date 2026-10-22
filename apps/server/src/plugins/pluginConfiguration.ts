import { PluginId, PluginSource, PluginRestartLimit } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const PluginConfigurationEntry = Schema.Struct({
  id: PluginId,
  path: Schema.String,
  enabled: Schema.Boolean,
  restartLimit: Schema.optionalKey(PluginRestartLimit),
  source: Schema.optionalKey(PluginSource),
});
export type PluginConfigurationEntry = typeof PluginConfigurationEntry.Type;
export const PluginConfiguration = Schema.Struct({
  plugins: Schema.Array(PluginConfigurationEntry).check(Schema.isMaxLength(100)),
});
export type PluginConfiguration = typeof PluginConfiguration.Type;
