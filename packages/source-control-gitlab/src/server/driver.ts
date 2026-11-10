import { SourceControlProviderError } from "@t3tools/contracts";
import {
  defineSourceControlDriver,
  withOwnServices,
} from "@t3tools/source-control-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { definition } from "../shared/definition.ts";

import * as GitLabCli from "./GitLabCli.ts";
import * as GitLabPullRequestCli from "./GitLabPullRequestCli.ts";
import * as GitLabPullRequestProvider from "./GitLabPullRequestProvider.ts";
import * as GitLabSourceControlProvider from "./GitLabSourceControlProvider.ts";

const services = GitLabPullRequestCli.layer.pipe(Layer.provideMerge(GitLabCli.layer));

export const makeReadApi = Effect.gen(function* () {
  const cli = yield* GitLabCli.GitLabCli;
  return Effect.fn("GitLabDriver.readApi")(function* (input: {
    readonly host: string;
    readonly path: string;
    readonly cwd: string;
  }) {
    const response = yield* cli.execute({
      cwd: input.cwd,
      host: input.host,
      args: ["api", "--method", "GET", "--hostname", input.host, input.path],
      maxOutputBytes: 128 * 1024,
    });
    if (response.stdoutTruncated || response.stdoutInvalidUtf8)
      return yield* new SourceControlProviderError({
        provider: definition.kind,
        cwd: input.cwd,
        operation: "plugin-read",
        detail: "Invalid API response",
      });
    return response.stdout;
  });
});

const makeInstance = Effect.all({
  readApi: makeReadApi,
  sourceControl: GitLabSourceControlProvider.make,
  discovery: Effect.succeed(GitLabSourceControlProvider.discovery),
  pullRequests: GitLabPullRequestProvider.make,
});

export const driver = defineSourceControlDriver({
  kind: definition.kind,
  definition,
  make: withOwnServices(makeInstance, services),
});
