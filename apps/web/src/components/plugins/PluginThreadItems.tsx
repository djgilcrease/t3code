import { useAtomValue } from "@effect/atom-react";
import {
  pluginActionDestinations,
  pluginDestinationLabel,
  pluginThreadDetailsViews,
  type PluginStatus,
} from "@t3tools/client-runtime/plugins";
import {
  EnvironmentId,
  ThreadId,
  type PluginCatalog,
  type PluginStatusAction,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useId, useState } from "react";

import { cn } from "../../lib/utils";
import { useEnvironmentMachines, useEnvironments } from "../../state/environments";
import { pluginCatalogsAtom } from "../../state/plugins";
import { serverEnvironment } from "../../state/server";
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
  DialogTrigger,
} from "../ui/dialog";
import { Label } from "../ui/label";
import {
  closePluginAction,
  openPluginAction,
  startPluginAction,
  usePluginActionRun,
  type PluginActionRun,
} from "./pluginActionRun";
import { PLUGIN_TONE_DOT_CLASS } from "./PluginStatusDots";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

import { PluginPanels } from "./PluginPanels";
import { Popover, PopoverTrigger, PopoverPopup } from "../ui/popover";

type Entry = PluginCatalog["plugins"][number];

/** Plugin status items and actions for the thread details machine row. */
export function PluginThreadItems({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const catalogs = useAtomValue(pluginCatalogsAtom);
  const views = catalogs.flatMap(({ environmentId: sourceId, catalog }) =>
    catalog ? pluginThreadDetailsViews(catalog).map((view) => ({ ...view, sourceId })) : [],
  );
  const panels = catalogs
    .filter((row) => row.environmentId === environmentId)
    .flatMap(
      (row) =>
        row.catalog?.plugins
          .filter((p) => p.status === "active")
          .flatMap((plugin) =>
            plugin.views
              .filter((v) => v.location === "thread-panel")
              .map((view) => ({ plugin, view })),
          ) ?? [],
    );
  if (views.length === 0 && panels.length === 0) return null;
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-1 px-2.5 pb-1 empty:hidden"
      data-plugin-thread-items
    >
      {panels.map(({ plugin, view }) =>
        view.presentation === "dialog" ? (
          <Dialog key={`${plugin.id}:${view.id}`}>
            <DialogTrigger render={<Button variant="ghost" size="sm" />}>
              {view.title}
            </DialogTrigger>
            <DialogPopup variant="wide">
              <DialogHeader>
                <DialogTitle>{view.title}</DialogTitle>
              </DialogHeader>
              <DialogPanel>
                <PluginPanels
                  key={threadId}
                  environmentId={environmentId}
                  pluginId={plugin.id}
                  viewId={view.id}
                  location="thread-panel"
                  context={{ threadId }}
                />
              </DialogPanel>
            </DialogPopup>
          </Dialog>
        ) : (
          <Popover key={`${plugin.id}:${view.id}`}>
            <PopoverTrigger render={<Button variant="ghost" size="sm" />}>
              {view.title}
            </PopoverTrigger>
            <PopoverPopup>
              <div className="max-h-[75vh] w-96 max-w-[85vw] overflow-auto">
                <PluginPanels
                  key={threadId}
                  environmentId={environmentId}
                  pluginId={plugin.id}
                  viewId={view.id}
                  location="thread-panel"
                  context={{ threadId }}
                />
              </div>
            </PopoverPopup>
          </Popover>
        ),
      )}
      {views.map(({ plugin, viewId, sourceId }) => (
        <PluginThreadView
          key={`${sourceId}:${plugin.id}:${viewId}`}
          environmentId={sourceId}
          targetEnvironmentId={environmentId}
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
  targetEnvironmentId,
  threadId,
  plugin,
  viewId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  targetEnvironmentId: EnvironmentId;
  plugin: Entry;
  viewId: string;
}) {
  const result = useAtomValue(
    serverEnvironment.pluginView({ environmentId, input: { pluginId: plugin.id, viewId } }),
  );
  const view = Option.getOrNull(AsyncResult.value(result));
  const busy = usePluginActionRun((state) => state.run?.phase === "running");
  return view?.blocks.map((block) =>
    block.kind === "status" && (block.environmentId ?? environmentId) === targetEnvironmentId ? (
      <PluginStatusItem
        key={block.id}
        block={block}
        environmentId={environmentId}
        plugin={plugin}
        busy={busy}
        onPress={(action) => openPluginAction({ environmentId, threadId, plugin, action })}
      />
    ) : null,
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
  const catalogs = useAtomValue(pluginCatalogsAtom);
  const allowed = useAtomValue(
    serverEnvironment.executePluginCommand.permissionAtom(environmentId, {
      pluginId: plugin.id,
      commandId: action.command,
      permission: command?.permission ?? "environment:maintain",
      input: action.input,
    }),
  );
  // An action that needs another machine has nothing to offer when none is connected.
  if (
    action.environment !== undefined &&
    pluginActionDestinations(catalogs, environmentId, plugin.id).length === 0
  )
    return null;
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

/** Mounted once at the app root, so a result outlives the thread view that started it. */
export function PluginActionDialogHost() {
  const run = usePluginActionRun((state) => state.run);
  return run?.dialog ? <PluginStatusActionDialog run={run} /> : null;
}

function PluginStatusActionDialog({ run }: { run: PluginActionRun }) {
  const { environmentId, plugin } = run;
  const onClose = closePluginAction;
  const onStart = startPluginAction;
  const id = useId();
  const navigate = useNavigate();
  const catalogs = useAtomValue(pluginCatalogsAtom);
  const { environments } = useEnvironments();
  const machines = useEnvironmentMachines();
  const picker = run.action.environment;
  const named = (id: EnvironmentId) => {
    const found = environments.find((environment) => environment.environmentId === id);
    return { label: found?.label ?? id, displayUrl: found?.displayUrl ?? null };
  };
  const targets = picker ? pluginActionDestinations(catalogs, environmentId, plugin.id) : [];
  const destinations = targets.map((target) => ({
    environmentId: target.environmentId,
    label: pluginDestinationLabel(named(target.environmentId), [
      named(environmentId).label,
      ...targets
        .filter((other) => other.environmentId !== target.environmentId)
        .map((other) => named(other.environmentId).label),
    ]),
    machine: machines.get(target.environmentId) ?? "server",
  }));
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
