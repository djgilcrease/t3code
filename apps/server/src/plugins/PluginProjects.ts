import { PluginError, ProjectId, type PluginProjects } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as BuiltInDrivers from "../sourceControl/builtInDrivers.ts";
import * as PluginRegistry from "./PluginRegistry.ts";

export const layerBinding = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* PluginRegistry.PluginRegistry;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const sources = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
    const drivers = yield* BuiltInDrivers.SourceControlDrivers;
    const resolve = Effect.fn("PluginProjects.resolve")(
      function* (projectId: string) {
        const project = yield* projects.get(ProjectId.make(projectId));
        if (Option.isNone(project))
          return yield* new PluginError({ operation: "project-unavailable", cause: null });
        const handle = yield* sources.resolveHandle({ cwd: project.value.workspaceRoot });
        return {
          project: project.value,
          context: handle.context,
          driver: drivers.find((entry) => entry.driver.kind === handle.provider.kind)?.instance,
        };
      },
      Effect.mapError((cause) => new PluginError({ operation: "project-context", cause })),
    );
    const host: PluginProjects = {
      describe: Effect.fn("PluginProjects.describe")(function* (projectId) {
        const { project, context, driver } = yield* resolve(projectId);
        return {
          projectId,
          directory: project.workspaceRoot,
          provider: context?.provider.kind ?? "unknown",
          remoteUrl: context?.remoteUrl ?? null,
          baseUrl: context?.provider.baseUrl ?? null,
          apiReads: !!driver?.readApi,
        };
      }),
      readSource: Effect.fn("PluginProjects.readSource")(function* (input) {
        // Relative paths cannot replace the credential's origin or normalize outside its API root.
        if (
          !/^[a-zA-Z0-9][a-zA-Z0-9_./%-]*(?:\?[^#]*)?$/.test(input.path) ||
          input.path.includes("\\") ||
          /(^|\/)\.{1,2}(\/|\?|$)/.test(input.path) ||
          /%2e|%5c/i.test(input.path.split("?")[0] ?? "")
        )
          return yield* new PluginError({ operation: "source-path", cause: null });
        const { context, driver, project } = yield* resolve(input.projectId);
        if (!context || !driver?.readApi)
          return yield* new PluginError({ operation: "unsupported-source", cause: null });
        const host = new URL(context.provider.baseUrl).host;
        return yield* driver
          .readApi({ host, path: input.path, cwd: project.workspaceRoot })
          .pipe(Effect.mapError((cause) => new PluginError({ operation: "source-read", cause })));
      }),
    };
    yield* registry.setProjects(host);
  }),
);
