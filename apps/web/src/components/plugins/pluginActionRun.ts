import {
  pluginStatusActionInput,
  runPluginAction,
  type PluginActionReply,
  type PluginActionStep,
} from "@t3tools/client-runtime/plugins";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  type PluginCatalog,
  type PluginNoticeResult,
  type PluginStatusAction,
  type ThreadId,
} from "@t3tools/contracts";
import { create } from "zustand";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { pluginCatalogsAtom } from "../../state/plugins";
import { serverEnvironment } from "../../state/server";

type Entry = PluginCatalog["plugins"][number];

export interface PluginActionRun {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly plugin: Entry;
  readonly action: PluginStatusAction;
  readonly phase: "ask" | "running" | "done";
  readonly notice: PluginNoticeResult | null;
  /** Progress reported by a relayed step. */
  readonly status: string | null;
  /** A plain action runs in place; its dialog opens only if it has something to say. */
  readonly dialog: boolean;
}

/**
 * Lives outside the thread details so an action that archives or moves its own thread can
 * still report how it ended, after that thread's view has closed.
 */
export const usePluginActionRun = create<{ run: PluginActionRun | null }>(() => ({ run: null }));
let cancel: AbortController | null = null;

async function execute(run: PluginActionRun, step: PluginActionStep): Promise<PluginActionReply> {
  const target = EnvironmentId.make(step.environmentId);
  const entry =
    target === run.environmentId
      ? run.plugin
      : appAtomRegistry
          .get(pluginCatalogsAtom)
          .find((row) => row.environmentId === target)
          ?.catalog?.plugins.find((candidate) => candidate.id === run.plugin.id);
  const command = entry?.commands.find((candidate) => candidate.id === step.commandId);
  if (!command)
    return { ok: false, message: `${run.plugin.name} cannot run this step on that environment.` };
  const outcome = await runAtomCommand(
    appAtomRegistry,
    serverEnvironment.executePluginCommand,
    {
      environmentId: target,
      input: {
        pluginId: run.plugin.id,
        commandId: command.id,
        permission: command.permission,
        input: step.input,
      },
    },
    { label: "plugin-thread-action", reportFailure: false },
  );
  if (outcome._tag === "Success") return { ok: true, value: outcome.value };
  if (isAtomCommandInterrupted(outcome)) return { ok: false, message: "Cancelled." };
  const failure = squashAtomCommandFailure(outcome);
  return { ok: false, message: failure instanceof Error ? failure.message : null };
}

export function startPluginAction(destination: EnvironmentId | null) {
  const run = usePluginActionRun.getState().run;
  if (run === null || run.phase === "running") return;
  const running: PluginActionRun = { ...run, phase: "running", notice: null, status: null };
  usePluginActionRun.setState({ run: running });
  const controller = new AbortController();
  cancel = controller;
  const current = () => {
    const now = usePluginActionRun.getState().run;
    return now?.phase === "running" && !controller.signal.aborted ? now : null;
  };
  void runPluginAction({
    start: {
      environmentId: run.environmentId,
      commandId: run.action.command,
      input: pluginStatusActionInput(run.action, run.threadId, destination),
    },
    execute: (step) => execute(running, step),
    signal: controller.signal,
    onStatus: (status) => {
      const now = current();
      if (now) usePluginActionRun.setState({ run: { ...now, status } });
    },
  }).then((notice) => {
    const now = current();
    if (now)
      usePluginActionRun.setState({
        run: notice === null ? null : { ...now, phase: "done", notice, status: null, dialog: true },
      });
  });
}

/** Called when a status action is pressed. One action runs at a time. */
export function openPluginAction(request: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly plugin: Entry;
  readonly action: PluginStatusAction;
}) {
  if (usePluginActionRun.getState().run?.phase === "running") return;
  const asks = request.action.confirm !== undefined || request.action.environment !== undefined;
  usePluginActionRun.setState({
    run: { ...request, phase: "ask", notice: null, status: null, dialog: asks },
  });
  if (!asks) startPluginAction(null);
}

export function closePluginAction() {
  // Stops carrying further steps; a plugin leaves its source untouched until the last one.
  cancel?.abort();
  cancel = null;
  usePluginActionRun.setState({ run: null });
}
