import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import type * as Stream from "effect/Stream";

export const PLUGIN_API_VERSION = 1;
export const PluginId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/));
export const PluginLocalId = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,63}$/));
const Label = Schema.String.check(Schema.isMaxLength(200));
const Text = Schema.String.check(Schema.isMaxLength(16_384));
export const PluginInput = Schema.Record(Schema.String, Schema.Json);
export type PluginInput = typeof PluginInput.Type;
export const PluginPermission = Schema.Literals([
  "orchestration:read",
  "orchestration:operate",
  "settings:write",
  "providers:manage",
  "environment:maintain",
  "diagnostics:read",
  "filesystem:read",
  "filesystem:write",
  "terminal:read",
  "terminal:operate",
  "source-control:write",
  "review:write",
  "access:read",
  "access:write",
  "relay:read",
  "relay:write",
  "preview:operate",
]);
export type PluginPermission = typeof PluginPermission.Type;
export const PluginManifest = Schema.Struct({
  apiVersion: Schema.Literal(PLUGIN_API_VERSION),
  id: PluginId,
  name: Label,
  version: Label,
  description: Schema.optionalKey(Text),
});
export type PluginManifest = typeof PluginManifest.Type;

export const PluginAction = Schema.Struct({
  id: PluginLocalId,
  label: Label,
  command: PluginLocalId,
  input: PluginInput,
});
export type PluginAction = typeof PluginAction.Type;
export const PluginField = Schema.Struct({
  name: PluginLocalId,
  label: Label,
  kind: Schema.Literals(["text", "password", "number", "boolean", "select"]),
  value: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number, Schema.Boolean])),
  options: Schema.optionalKey(
    Schema.Array(Schema.Struct({ label: Label, value: Label })).check(Schema.isMaxLength(100)),
  ),
  required: Schema.optionalKey(Schema.Boolean),
});
export const PluginBlock = Schema.Union([
  Schema.Struct({ id: PluginLocalId, kind: Schema.Literal("text"), text: Text }),
  Schema.Struct({ id: PluginLocalId, kind: Schema.Literal("link"), label: Label, url: Text }),
  Schema.Struct({
    id: PluginLocalId,
    kind: Schema.Literal("actions"),
    actions: Schema.Array(PluginAction).check(Schema.isMaxLength(20)),
  }),
  Schema.Struct({
    id: PluginLocalId,
    kind: Schema.Literal("form"),
    label: Label,
    command: PluginLocalId,
    fields: Schema.Array(PluginField).check(Schema.isMaxLength(40)),
    input: PluginInput,
  }),
  Schema.Struct({
    id: PluginLocalId,
    kind: Schema.Literal("table"),
    columns: Schema.Array(Label).check(Schema.isMaxLength(20)),
    rows: Schema.Array(
      Schema.Struct({
        id: Label,
        cells: Schema.Array(Text).check(Schema.isMaxLength(20)),
        actions: Schema.Array(PluginAction).check(Schema.isMaxLength(20)),
      }),
    ).check(Schema.isMaxLength(500)),
  }),
]);
export type PluginBlock = typeof PluginBlock.Type;
const unique = <A>(values: readonly A[]) => new Set(values).size === values.length;
export const PluginView = Schema.Struct({
  title: Label,
  blocks: Schema.Array(PluginBlock).check(Schema.isMaxLength(100)),
}).check(
  Schema.makeFilter(
    (view) =>
      unique(view.blocks.map((block) => block.id)) &&
      view.blocks.every((block) => {
        if (block.kind === "form")
          return (
            unique(block.fields.map((field) => field.name)) &&
            block.fields.every((field) =>
              unique(field.options?.map((option) => option.value) ?? []),
            )
          );
        if (block.kind === "actions") return unique(block.actions.map((action) => action.id));
        if (block.kind === "table")
          return (
            unique(block.columns) &&
            unique(block.rows.map((row) => row.id)) &&
            block.rows.every(
              (row) =>
                row.cells.length === block.columns.length &&
                unique(row.actions.map((action) => action.id)),
            )
          );
        return true;
      }),
  ),
);
export type PluginView = typeof PluginView.Type;
export const PluginViewDescriptor = Schema.Struct({
  id: PluginLocalId,
  title: Label,
  location: Schema.Literals(["settings", "usage"]),
  permission: PluginPermission,
});
export type PluginViewDescriptor = typeof PluginViewDescriptor.Type;
export const PluginCommandDescriptor = Schema.Struct({
  id: PluginLocalId,
  title: Label,
  description: Text,
  permission: PluginPermission,
  /** Agent access is opt-in; secret-bearing commands should leave this false. */
  agent: Schema.Boolean,
});
export type PluginCommandDescriptor = typeof PluginCommandDescriptor.Type;

/** An explicit command may disclose a secret temporarily; never return this from a view. */
export const PluginSecretResult = Schema.Struct({
  $t3: Schema.Literal("secret"),
  label: Label,
  value: Text,
});
export type PluginSecretResult = typeof PluginSecretResult.Type;

export class PluginError extends Schema.TaggedError<PluginError>()("PluginError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message() {
    return `Plugin operation failed (${this.operation}).`;
  }
}

/** Only T3-owned launches pass through this hook. Terminal shells are unaffected. */
export interface PluginLaunch {
  readonly provider: string;
  readonly purpose: "agent" | "text-generation" | "managed-server";
  readonly cwd?: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
}
export interface PluginContext {
  readonly id: string;
  readonly dataDirectory: string;
  /** Relative URL on the owning environment; never a baked-in localhost origin. */
  readonly httpBasePath: string;
  /** Resolved when the environment is listening; evaluate inside handlers, not activation. */
  readonly httpBaseUrl: Effect.Effect<string, PluginError>;
  readonly secrets: {
    readonly get: (key: string) => Effect.Effect<string | null, PluginError>;
    readonly set: (key: string, value: string) => Effect.Effect<void, PluginError>;
    readonly remove: (key: string) => Effect.Effect<void, PluginError>;
  };
}
export interface PluginContributions {
  /** Emit after background state changes; clients refetch mounted views, without polling. */
  readonly changes?: Stream.Stream<void, PluginError>;
  readonly commands?: readonly (PluginCommandDescriptor & {
    /** Decode and validate feature-specific input inside the handler. */
    readonly run: (input: PluginInput) => Effect.Effect<Schema.Json, PluginError>;
  })[];
  readonly views?: readonly (PluginViewDescriptor & {
    readonly read: () => Effect.Effect<PluginView, PluginError>;
  })[];
  readonly prepareLaunch?: (launch: PluginLaunch) => Effect.Effect<PluginLaunch, PluginError>;
  /**
   * Routes below httpBasePath. Own authentication explicitly (API key, PKCE/state,
   * webhook signatures); this endpoint deliberately has no T3 browser session.
   * Request and response streams stay streaming and carry cancellation.
   */
  readonly handleHttp?: (request: Request) => Effect.Effect<Response, PluginError>;
}
export interface T3Plugin extends PluginManifest {
  /** Acquire resources with Effect scopes; the host closes them on shutdown/failure. */
  readonly activate: (
    context: PluginContext,
  ) => Effect.Effect<PluginContributions, PluginError, Scope.Scope>;
}
