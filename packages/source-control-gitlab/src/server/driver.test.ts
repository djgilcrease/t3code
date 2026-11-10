import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GitLabCli from "./GitLabCli.ts";
import { makeReadApi } from "./driver.ts";

it.effect("reads a bounded API path using the project's cwd and selected GitLab host", () => {
  const calls: Parameters<GitLabCli.GitLabCli["Service"]["execute"]>[0][] = [];
  return Effect.gen(function* () {
    const read = yield* makeReadApi;
    const input = {
      host: "gitlab.example",
      path: "projects/team%2Fapp/issues?state=opened",
      cwd: "/projects/app",
    };
    expect(yield* read(input)).toBe("[]");
    expect(calls).toEqual([
      {
        cwd: input.cwd,
        host: input.host,
        args: ["api", "--method", "GET", "--hostname", input.host, input.path],
        maxOutputBytes: 128 * 1024,
      },
    ]);
  }).pipe(
    Effect.provide(
      Layer.mock(GitLabCli.GitLabCli)({
        execute: (input) => {
          calls.push(input);
          return Effect.succeed({
            exitCode: ChildProcessSpawner.ExitCode(0),
            stdout: "[]",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          });
        },
      }),
    ),
  );
});
