import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as PluginPackages from "./PluginPackages.ts";

const sha = "a".repeat(40);
const older = "b".repeat(40);
it("selects the highest stable semantic version and peels annotated tags", () => {
  expect(
    PluginPackages.newestPluginTag(
      [
        `${older}\trefs/tags/v1.9.0`,
        `${older}\trefs/tags/v1.10.0`,
        `${sha}\trefs/tags/v1.10.0^{}`,
        `${older}\trefs/tags/v2.0.0-beta.1`,
        `${older}\trefs/tags/latest`,
        `${older}\trefs/tags/v01.0.0`,
        `${older}\trefs/tags/1.8.0`,
      ].join("\n"),
    ),
  ).toEqual({ tag: "v1.10.0", commit: sha });
  expect(PluginPackages.newestPluginTag(`${sha}\trefs/heads/main`)).toBeNull();
});
it("accepts GitHub, nested GitLab, and self-hosted HTTPS repositories without shell or credential syntax", () => {
  expect(PluginPackages.normalizePluginRepository("https://github.com/team/plugin/ ")).toBe(
    "https://github.com/team/plugin.git",
  );
  expect(
    PluginPackages.normalizePluginRepository("https://gitlab.example:8443/team/group/plugin.git"),
  ).toBe("https://gitlab.example:8443/team/group/plugin.git");
  for (const value of [
    "file:///tmp/plugin",
    "ext::sh -c true",
    "ssh://git@github.com/team/plugin",
    "https://token@github.com/team/plugin",
    "https://github.com/team/plugin/tree/main",
    "https://gitlab.com/team/plugin?token=secret",
    "https://gitlab.com/team/plugin#tag",
    "https://gitlab.com/team/$(touch marker)",
  ]) {
    expect(PluginPackages.normalizePluginRepository(value)).toBeNull();
  }
});

function fixture<A, E, R>(
  use: (
    temp: string,
    calls: ProcessRunner.ProcessRunInput[],
  ) => Effect.Effect<A, E, R | PluginPackages.PluginPackages>,
  options: { main?: string; tagMoved?: boolean; version?: string; symlink?: boolean } = {},
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "t3-plugin-packages-" });
      const calls: ProcessRunner.ProcessRunInput[] = [];
      const runner = Layer.succeed(ProcessRunner.ProcessRunner, {
        run: (input) =>
          Effect.gen(function* () {
            calls.push(input);
            let stdout = "";
            if (input.args.includes("ls-remote"))
              stdout = `${older}\trefs/tags/v1.9.0\n${sha}\trefs/tags/v1.10.0`;
            else if (input.args.includes("clone")) {
              const checkout = input.args.at(-1)!;
              yield* fs.makeDirectory(`${checkout}/dist`, { recursive: true });
              yield* fs.writeFileString(
                `${checkout}/t3-plugin.json`,
                JSON.stringify({
                  apiVersion: 1,
                  id: "example",
                  name: "Example",
                  version: options.version ?? "1.10.0",
                  main: options.main ?? "dist/plugin.mjs",
                }),
              );
              yield* fs.writeFileString(`${checkout}/dist/plugin.mjs`, "export default {};");
              yield* fs.writeFileString(
                `${checkout}/package.json`,
                JSON.stringify({ scripts: { postinstall: `touch ${temp}/script-ran` } }),
              );
              if (options.symlink) {
                yield* fs.writeFileString(`${temp}/outside.mjs`, "export default {};");
                yield* fs.symlink(`${temp}/outside.mjs`, `${checkout}/outside.mjs`);
              }
            } else if (input.args.includes("rev-parse")) stdout = options.tagMoved ? older : sha;
            else return yield* Effect.die(`Unexpected command: ${input.command}`);
            return {
              stdout,
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            };
          }).pipe(Effect.orDie),
      });
      return yield* use(temp, calls).pipe(
        Effect.provide(
          PluginPackages.layer.pipe(
            Layer.provide(runner),
            Layer.provide(ServerConfig.layerTest(temp, temp)),
          ),
        ),
      );
    }),
  ).pipe(Effect.provide(NodeServices.layer));
}

it.effect(
  "stages the selected tag, verifies its commit, and installs without executing package scripts",
  () =>
    fixture((temp, calls) =>
      Effect.gen(function* () {
        const packages = yield* PluginPackages.PluginPackages;
        const fs = yield* FileSystem.FileSystem;
        const installed = yield* packages.prepare("https://github.com/team/plugin");
        expect(installed).toMatchObject({
          id: "example",
          enabled: true,
          path: `${temp}/plugin-packages/example/${sha}/dist/plugin.mjs`,
          source: {
            repository: "https://github.com/team/plugin.git",
            tag: "v1.10.0",
            commit: sha,
            latestCommit: sha,
          },
        });
        expect(yield* fs.exists(installed.path)).toBe(true);
        expect(yield* fs.exists(`${temp}/script-ran`)).toBe(false);
        expect(calls).toHaveLength(3);
        expect(
          calls.every(
            (call) =>
              call.command === "git" &&
              call.env?.GIT_TERMINAL_PROMPT === "0" &&
              call.args.includes("protocol.ext.allow=never"),
          ),
        ).toBe(true);
        expect(calls[1]?.args).toContain("--no-recurse-submodules");
        expect(calls[1]?.args.slice(-4)).toEqual([
          "v1.10.0",
          "--",
          "https://github.com/team/plugin.git",
          expect.any(String),
        ]);
        expect(
          (yield* fs.readDirectory(`${temp}/plugin-packages`)).some((name) =>
            name.startsWith("staging-"),
          ),
        ).toBe(false);
        yield* packages.remove(installed.id);
        expect(yield* fs.exists(installed.path)).toBe(false);
      }),
    ),
);

it.effect("rejects a moved tag and a manifest version that disagrees with its tag", () =>
  Effect.gen(function* () {
    yield* fixture(
      () =>
        Effect.gen(function* () {
          const packages = yield* PluginPackages.PluginPackages;
          expect(
            (yield* packages.prepare("https://github.com/team/plugin").pipe(Effect.flip)).operation,
          ).toBe("tag-moved");
        }),
      { tagMoved: true },
    );
    yield* fixture(
      () =>
        Effect.gen(function* () {
          const packages = yield* PluginPackages.PluginPackages;
          expect(
            (yield* packages.prepare("https://github.com/team/plugin").pipe(Effect.flip)).operation,
          ).toBe("version-mismatch");
        }),
      { version: "1.0.0" },
    );
  }),
);

it.effect("rejects absolute, escaping, and symlinked entrypoints outside the checkout", () =>
  Effect.gen(function* () {
    for (const main of ["/tmp/outside.mjs", "../../outside.mjs", "outside.mjs"])
      yield* fixture(
        () =>
          Effect.gen(function* () {
            const packages = yield* PluginPackages.PluginPackages;
            const result = yield* packages
              .prepare("https://gitlab.com/team/plugin")
              .pipe(Effect.result);
            expect(result._tag).toBe("Failure");
          }),
        { main, symlink: true },
      );
  }),
);
