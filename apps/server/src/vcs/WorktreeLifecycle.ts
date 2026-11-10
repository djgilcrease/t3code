import type { GitCommandError, PluginLifecycleEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export class WorktreeLifecycle extends Context.Reference<
  (event: PluginLifecycleEvent) => Effect.Effect<void, GitCommandError>
>("t3/vcs/WorktreeLifecycle", { defaultValue: () => () => Effect.void }) {}
