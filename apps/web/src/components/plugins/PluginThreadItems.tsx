import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  pluginActionDestinations,
  pluginStatusActionInput,
  pluginThreadDetailsViews,
  runPluginAction,
  type PluginActionReply,
  type PluginActionStep,
  type PluginStatus,
} from "@t3tools/client-runtime/plugins";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  ThreadId,
  type PluginCatalog,
  type PluginNoticeResult,
  type PluginStatusAction,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useContext, useId, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { useEnvironmentMachines, useEnvironments } from "../../state/environments";
import { pluginCatalogsAtom } from "../../state/plugins";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import { EnvironmentMachineIcon } from "../EnvironmentMachineIcon";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { PLUGIN_TONE_DOT_CLASS } from "./PluginStatusDots";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type Entry = PluginCatalog["plugins"][number];

interface Run {
  readonly action: PluginStatusAction;
  readonly phase: "ask" | "running" | "done";
  readonly notice: PluginNoticeResult | null;
  /** Progress reported by a relayed step. */
  readonly status: string | null;
  /** A plain action runs in place; its dialog opens only if it has something to say. */
  readonly dialog: boolean;
}

/** Plugin status items and actions for the thread details machine row. */
export function PluginThreadItems({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const result = useAtomValue(serverEnvironment.pluginCatalog({ environmentId, input: {} }));
  const catalog = Option.getOrNull(AsyncResult.value(result));
  const views = catalog ? pluginThreadDetailsViews(catalog) : [];
  if (views.length === 0) return null;
  return (
    <div
      className="flex shrink-0 flex-wrap items-center justify-end gap-1 pe-1.5"
      data-plugin-thread-items
    >
      {views.map(({ plugin, viewId }) => (
        <PluginThreadView
          key={`${plugin.id}:${viewId}`}
          environmentId={environmentId}
          threadId={threadId}
          plugin={plugin}
          viewId={viewId}
        />
      ))}
    </div>
  );
}

function PluginThreadView({
  environmentId,
  threadId,
  plugin,
  viewId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  plugin: Entry;
  viewId: string;
}) {
  const result = useAtomValue(
    serverEnvironment.pluginView({ environmentId, input: { pluginId: plugin.id, viewId } }),
  );
  const view = Option.getOrNull(AsyncResult.value(result));
  const registry = useContext(RegistryContext);
  const execute = useAtomCommand(serverEnvironment.executePluginCommand, { reportFailure: false });
  const [run, setRun] = useState<Run | null>(null);
  const cancel = useRef<AbortController | null>(null);

  const executeStep = async (step: PluginActionStep): Promise<PluginActionReply> => {
    const target = EnvironmentId.make(step.environmentId);
    const entry =
      target === environmentId
        ? plugin
        : registry
            .get(pluginCatalogsAtom)
            .find((row) => row.environmentId === target)
            ?.catalog?.plugins.find((candidate) => candidate.id === plugin.id);
    const command = entry?.commands.find((candidate) => candidate.id === step.commandId);
    if (!command)
      return { ok: false, message: `${plugin.name} cannot run this step on that environment.` };
    const outcome = await execute({
      environmentId: target,
      input: {
        pluginId: plugin.id,
        commandId: command.id,
        permission: command.permission,
        input: step.input,
      },
    });
    if (outcome._tag === "Success") return { ok: true, value: outcome.value };
    if (isAtomCommandInterrupted(outcome)) return { ok: false, message: "Cancelled." };
    const failure = squashAtomCommandFailure(outcome);
    return { ok: false, message: failure instanceof Error ? failure.message : null };
  };
  const start = (
    action: PluginStatusAction,
    destination: EnvironmentId | null,
    dialog: boolean,
  ) => {
    setRun({ action, phase: "running", notice: null, status: null, dialog });
    const controller = new AbortController();
    cancel.current = controller;
    void runPluginAction({
      start: {
        environmentId,
        commandId: action.command,
        input: pluginStatusActionInput(action, threadId, destination),
      },
      execute: executeStep,
      signal: controller.signal,
      onStatus: (status) =>
        setRun((current) => (current?.phase === "running" ? { ...current, status } : current)),
    }).then((notice) =>
      setRun(
        notice === null ? null : { action, phase: "done", notice, status: null, dialog: true },
      ),
    );
  };
  const press = (action: PluginStatusAction) => {
    if (action.confirm !== undefined || action.environment !== undefined)
      setRun({ action, phase: "ask", notice: null, status: null, dialog: true });
    else start(action, null, false);
  };

  return (
    <>
      {view?.blocks.map((block) =>
        block.kind === "status" ? (
          <PluginStatusItem
            key={block.id}
            block={block}
            environmentId={environmentId}
            plugin={plugin}
            busy={run?.phase === "running"}
            onPress={press}
          />
        ) : null,
      )}
      {run?.dialog ? (
        <PluginStatusActionDialog
          environmentId={environmentId}
          plugin={plugin}
          run={run}
          onStart={(destination) => start(run.action, destination, true)}
          onClose={() => {
            // Stops carrying further steps; a plugin leaves its source untouched until the end.
            cancel.current?.abort();
            setRun(null);
          }}
        />
      ) : null}
    </>
  );
}

function PluginStatusItem({
  block,
  environmentId,
  plugin,
  busy,
  onPress,
}: {
  block: PluginStatus;
  environmentId: EnvironmentId;
  plugin: Entry;
  busy: boolean;
  onPress: (action: PluginStatusAction) => void;
}) {
  const label =
    block.label === undefined ? null : (
      <span className="inline-flex min-w-0 items-center gap-1.5 px-1 text-muted-foreground text-xs">
        {block.tone ? (
          <span
            aria-hidden
            className={cn("size-1.5 shrink-0 rounded-full", PLUGIN_TONE_DOT_CLASS[block.tone])}
          />
        ) : null}
        <span className="truncate">{block.label}</span>
      </span>
    );
  return (
    <>
      {label !== null && block.detail !== undefined ? (
        <Tooltip>
          <TooltipTrigger render={label} />
          <TooltipPopup side="top">{block.detail}</TooltipPopup>
        </Tooltip>
      ) : (
        label
      )}
      {block.actions.map((action) => (
        <PluginStatusActionButton
          key={action.id}
          action={action}
          environmentId={environmentId}
          plugin={plugin}
          busy={busy}
          onPress={onPress}
        />
      ))}
    </>
  );
}

function PluginStatusActionButton({
  action,
  environmentId,
  plugin,
  busy,
  onPress,
}: {
  action: PluginStatusAction;
  environmentId: EnvironmentId;
  plugin: Entry;
  busy: boolean;
  onPress: (action: PluginStatusAction) => void;
}) {
  const command = plugin.commands.find((candidate) => candidate.id === action.command);
  const allowed = useAtomValue(
    serverEnvironment.executePluginCommand.permissionAtom(environmentId, {
      pluginId: plugin.id,
      commandId: action.command,
      permission: command?.permission ?? "environment:maintain",
      input: action.input,
    }),
  );
  return (
    <ThreadDetailsControl
      size="xs"
      variant="ghost"
      part="meta"
      disabled={!command || !allowed || busy}
      onClick={() => onPress(action)}
    >
      {action.label}
    </ThreadDetailsControl>
  );
}

function PluginStatusActionDialog({
  environmentId,
  plugin,
  run,
  onStart,
  onClose,
}: {
  environmentId: EnvironmentId;
  plugin: Entry;
  run: Run;
  onStart: (destination: EnvironmentId | null) => void;
  onClose: () => void;
}) {
  const id = useId();
  const navigate = useNavigate();
  const catalogs = useAtomValue(pluginCatalogsAtom);
  const { environments } = useEnvironments();
  const machines = useEnvironmentMachines();
  const picker = run.action.environment;
  const destinations = picker
    ? pluginActionDestinations(catalogs, environmentId, plugin.id).map((target) => ({
        environmentId: target.environmentId,
        label:
          environments.find((environment) => environment.environmentId === target.environmentId)
            ?.label ?? target.environmentId,
        machine: machines.get(target.environmentId) ?? "server",
      }))
    : [];
  const [chosen, setChosen] = useState<EnvironmentId | null>(null);
  const destination =
    destinations.find((target) => target.environmentId === chosen) ?? destinations[0] ?? null;
  const blocked = picker !== undefined && destination === null;
  const title = run.action.label.replace(/(…|\.\.\.)$/u, "");
  const thread = run.notice?.thread;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup>
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (run.phase === "ask" && !blocked) onStart(destination?.environmentId ?? null);
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            {run.phase === "ask" && run.action.confirm ? (
              <p className="whitespace-pre-wrap text-muted-foreground text-sm">
                {run.action.confirm}
              </p>
            ) : null}
            {run.phase === "ask" && picker ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${id}-destination`}>{picker.label}</Label>
                {destination ? (
                  <Select
                    value={destination.environmentId}
                    onValueChange={(value) => {
                      if (value) setChosen(value);
                    }}
                    items={destinations.map((target) => ({
                      value: target.environmentId,
                      label: target.label,
                    }))}
                  >
                    <SelectTrigger id={`${id}-destination`} size="sm">
                      <EnvironmentMachineIcon kind={destination.machine} className="size-3.5" />
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup>
                      {destinations.map((target) => (
                        <SelectItem key={target.environmentId} value={target.environmentId}>
                          <span className="inline-flex items-center gap-1.5">
                            <EnvironmentMachineIcon kind={target.machine} className="size-3" />
                            {target.label}
                          </span>
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                ) : (
                  <p id={`${id}-destination`} className="text-sm">
                    No other connected environment has {plugin.name} installed.
                  </p>
                )}
              </div>
            ) : null}
            {run.phase === "running" ? (
              <p role="status" className="text-muted-foreground text-sm">
                {run.status ?? "Working…"}
              </p>
            ) : null}
            {run.notice ? (
              <p
                role={run.notice.tone === "danger" ? "alert" : "status"}
                className={cn(
                  "whitespace-pre-wrap text-sm",
                  run.notice.tone === "danger" && "text-destructive",
                )}
              >
                {run.notice.text}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {run.phase === "done" ? "Close" : "Cancel"}
            </Button>
            {run.phase !== "done" ? (
              <Button type="submit" disabled={blocked || run.phase === "running"}>
                {run.phase === "running" ? "Working…" : title}
              </Button>
            ) : thread ? (
              <Button
                type="button"
                onClick={() => {
                  onClose();
                  void navigate({
                    to: "/$environmentId/$threadId",
                    params: {
                      environmentId: EnvironmentId.make(thread.environmentId),
                      threadId: ThreadId.make(thread.threadId),
                    },
                  });
                }}
              >
                Open thread
              </Button>
            ) : null}
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
