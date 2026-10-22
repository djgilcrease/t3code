import { PluginManifest, PluginOperationError, type PluginSource } from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import type { PluginConfigurationEntry } from "./pluginConfiguration.ts";

const PackageManifest = Schema.Struct({ ...PluginManifest.fields, main: Schema.String });
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(PackageManifest));
const isOperationError = Schema.is(PluginOperationError);
const VERSION_TAG = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** A URL is a source, never shell text or a Git remote-helper expression. */
export function normalizePluginRepository(input: string): string | null {
  try {
    const url = new URL(input.trim());
    const parts = url.pathname
      .replace(/\/$/, "")
      .replace(/\.git$/, "")
      .split("/")
      .filter(Boolean);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      parts.length < 2 ||
      parts.some((part) => !/^[a-zA-Z0-9_.-]+$/.test(part) || part === "." || part === "..") ||
      (url.hostname === "github.com" && parts.length !== 2)
    )
      return null;
    return `https://${url.host}/${parts.join("/")}.git`;
  } catch {
    return null;
  }
}

/** Prefer peeled commits for annotated tags; compare release versions numerically. */
export function newestPluginTag(output: string): { tag: string; commit: string } | null {
  const tags = new Map<string, { commit: string; peeled: boolean }>();
  for (const line of output.split("\n")) {
    const match = /^([a-f0-9]{40}|[a-f0-9]{64})\s+refs\/tags\/(.+?)(\^\{\})?$/.exec(line.trim());
    if (!match) continue;
    const [, commit, tag, peeled] = match;
    if (!commit || !tag || !VERSION_TAG.test(tag)) continue;
    if (peeled || !tags.get(tag)?.peeled) tags.set(tag, { commit, peeled: !!peeled });
  }
  const tag = [...tags.keys()].sort((a, b) => compareSemverVersions(b, a) || a.localeCompare(b))[0];
  return tag ? { tag, commit: tags.get(tag)!.commit } : null;
}

export class PluginPackages extends Context.Service<
  PluginPackages,
  {
    readonly latest: (
      repository: string,
    ) => Effect.Effect<{ repository: string; tag: string; commit: string }, PluginOperationError>;
    readonly prepare: (
      repository: string,
    ) => Effect.Effect<PluginConfigurationEntry, PluginOperationError>;
    readonly remove: (id: string) => Effect.Effect<void, PluginOperationError>;
  }
>()("t3/plugins/PluginPackages") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const config = yield* ServerConfig.ServerConfig;
  const root = path.join(config.baseDir, "plugin-packages");
  const git = (args: readonly string[]) =>
    runner
      .run({
        command: "git",
        args: [
          "-c",
          "protocol.file.allow=never",
          "-c",
          "protocol.ext.allow=never",
          "-c",
          `core.hooksPath=${path.join(root, "no-hooks")}`,
          ...args,
        ],
        env: { GIT_TERMINAL_PROMPT: "0" },
        timeout: "2 minutes",
        maxOutputBytes: 2 * 1024 * 1024,
      })
      .pipe(
        Effect.flatMap((result) =>
          result.code === 0
            ? Effect.succeed(result.stdout)
            : Effect.fail(
                new PluginOperationError({
                  pluginId: "packages",
                  operation: "git",
                  cause: result.code,
                }),
              ),
        ),
        Effect.mapError((cause) =>
          isOperationError(cause)
            ? cause
            : new PluginOperationError({ pluginId: "packages", operation: "git", cause }),
        ),
      );
  const latest: PluginPackages["Service"]["latest"] = Effect.fn("PluginPackages.latest")(
    function* (input) {
      const repository = normalizePluginRepository(input);
      if (!repository)
        return yield* new PluginOperationError({
          pluginId: "packages",
          operation: "repository-url",
          cause: null,
        });
      const result = newestPluginTag(yield* git(["ls-remote", "--tags", "--", repository]));
      if (!result)
        return yield* new PluginOperationError({
          pluginId: "packages",
          operation: "no-version-tags",
          cause: null,
        });
      return { repository, ...result };
    },
  );
  const prepare: PluginPackages["Service"]["prepare"] = Effect.fn("PluginPackages.prepare")(
    function* (repository) {
      const version = yield* latest(repository);
      return yield* Effect.scoped(
        Effect.gen(function* () {
          yield* fs.makeDirectory(root, { recursive: true });
          const staging = yield* fs.makeTempDirectoryScoped({
            directory: root,
            prefix: "staging-",
          });
          const checkout = path.join(staging, "package");
          yield* git([
            "clone",
            "--depth=1",
            "--single-branch",
            "--no-recurse-submodules",
            "--branch",
            version.tag,
            "--",
            version.repository,
            checkout,
          ]);
          if ((yield* git(["-C", checkout, "rev-parse", "HEAD"])).trim() !== version.commit)
            return yield* new PluginOperationError({
              pluginId: "packages",
              operation: "tag-moved",
              cause: null,
            });
          const manifest = yield* fs
            .readFileString(path.join(checkout, "t3-plugin.json"))
            .pipe(Effect.flatMap(decodeManifest));
          if (manifest.version !== version.tag.replace(/^v/, ""))
            return yield* new PluginOperationError({
              pluginId: manifest.id,
              operation: "version-mismatch",
              cause: null,
            });
          if (path.isAbsolute(manifest.main))
            return yield* new PluginOperationError({
              pluginId: manifest.id,
              operation: "entrypoint",
              cause: null,
            });
          const main = yield* fs.realPath(path.resolve(checkout, manifest.main));
          const relative = path.relative(checkout, main);
          if (
            !relative ||
            relative.startsWith(`..${path.sep}`) ||
            relative === ".." ||
            path.isAbsolute(relative) ||
            !/\.(mjs|js)$/.test(main)
          )
            return yield* new PluginOperationError({
              pluginId: manifest.id,
              operation: "entrypoint",
              cause: null,
            });
          const destination = path.join(root, manifest.id, version.commit);
          yield* fs.makeDirectory(path.dirname(destination), { recursive: true });
          if (!(yield* fs.exists(destination))) yield* fs.rename(checkout, destination);
          const source: PluginSource = {
            ...version,
            checkedAt: yield* Clock.currentTimeMillis,
            latestTag: version.tag,
            latestCommit: version.commit,
            checkFailed: false,
          };
          return { id: manifest.id, enabled: true, path: path.join(destination, relative), source };
        }),
      ).pipe(
        Effect.mapError((cause) =>
          isOperationError(cause)
            ? cause
            : new PluginOperationError({ pluginId: "packages", operation: "prepare", cause }),
        ),
      );
    },
  );
  return PluginPackages.of({
    latest,
    prepare,
    remove: (id) =>
      fs
        .remove(path.join(root, id), { recursive: true, force: true })
        .pipe(
          Effect.mapError(
            (cause) =>
              new PluginOperationError({ pluginId: id, operation: "remove-package", cause }),
          ),
        ),
  });
});
export const layer = Layer.effect(PluginPackages, make);
