import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";
import {
  PluginCommandDescriptor,
  PluginId,
  PluginInput,
  PluginLocalId,
  PluginViewDescriptor,
  PluginPermission,
} from "@t3tools/plugin-sdk";

export * from "@t3tools/plugin-sdk";

export const PluginSource = Schema.Struct({
  repository: Schema.String,
  tag: Schema.String,
  commit: Schema.String,
  checkedAt: Schema.Number,
  latestTag: Schema.String,
  latestCommit: Schema.String,
  checkFailed: Schema.Boolean,
});
export type PluginSource = typeof PluginSource.Type;
export const PluginRestartLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }));
export const PluginRuntimeHealth = Schema.Struct({
  status: Schema.Literals(["active", "restarting", "stopped"]),
  attempts: Schema.Int,
  limit: PluginRestartLimit,
});

export const PluginCatalogEntry = Schema.Struct({
  id: PluginId,
  name: Schema.String,
  version: Schema.String,
  status: Schema.Literals(["active", "disabled", "failed", "restarting", "stopped"]),
  restartAttempts: Schema.optionalKey(Schema.Int),
  restartLimit: Schema.optionalKey(PluginRestartLimit),
  failure: Schema.optionalKey(
    Schema.Literals(["module", "manifest", "activation", "contributions", "storage"]),
  ),
  source: Schema.optionalKey(PluginSource),
  commands: Schema.Array(PluginCommandDescriptor),
  views: Schema.Array(PluginViewDescriptor),
});
export const PluginCatalog = Schema.Struct({
  configurationError: Schema.Boolean,
  plugins: Schema.Array(PluginCatalogEntry),
});
export type PluginCatalog = typeof PluginCatalog.Type;
export const PluginViewInput = Schema.Struct({ pluginId: PluginId, viewId: PluginLocalId });
export const PluginCommandInput = Schema.Struct({
  pluginId: PluginId,
  commandId: PluginLocalId,
  input: PluginInput,
  // The client uses the catalog value for consent. The server checks the actual command too.
  permission: PluginPermission,
});
export type PluginCommandInput = typeof PluginCommandInput.Type;
export type PluginViewInput = typeof PluginViewInput.Type;
export const PluginManageInput = Schema.Union([
  Schema.Struct({ operation: Schema.Literal("install"), repository: Schema.String }),
  Schema.Struct({ operation: Schema.Literal("check") }),
  Schema.Struct({ operation: Schema.Literal("update"), pluginId: PluginId }),
  Schema.Struct({ operation: Schema.Literal("remove"), pluginId: PluginId }),
  Schema.Struct({
    operation: Schema.Literal("set-enabled"),
    pluginId: PluginId,
    enabled: Schema.Boolean,
  }),
  Schema.Struct({ operation: Schema.Literal("restart"), pluginId: PluginId }),
  Schema.Struct({
    operation: Schema.Literal("set-restart-limit"),
    pluginId: PluginId,
    attempts: PluginRestartLimit,
  }),
]);
export type PluginManageInput = typeof PluginManageInput.Type;
// Plugin failures can contain credentials in any property. Keep the local
// cause for diagnostics, but encode only null across the RPC boundary.
const PrivateCause = Schema.Null.pipe(
  Schema.decodeTo(Schema.Unknown, {
    decode: SchemaGetter.transform(() => null),
    encode: SchemaGetter.transform(() => null),
  }),
);
export class PluginOperationError extends Schema.TaggedError<PluginOperationError>()(
  "PluginOperationError",
  {
    pluginId: Schema.String,
    operation: Schema.String,
    cause: PrivateCause,
  },
) {
  override get message() {
    return `Plugin ${this.pluginId} could not complete ${this.operation}.`;
  }
}
export class PluginRequestError extends Schema.TaggedError<PluginRequestError>()(
  "PluginRequestError",
  {
    pluginId: PluginId,
    reason: Schema.Literals([
      "unavailable",
      "unknown-contribution",
      "agent-access-disabled",
      "already-installed",
      "not-managed",
      "secret-access-disabled",
    ]),
  },
) {
  override get message() {
    return `The requested plugin capability is unavailable (${this.reason}).`;
  }
}
