import { useAtomValue } from "@effect/atom-react";
import {
  pluginActionDestinations,
  pluginDestinationLabel,
  pluginStatusActionInput,
  pluginThreadDetailsViews,
  runPluginAction,
  type PluginActionReply,
  type PluginActionStep,
} from "@t3tools/client-runtime/plugins";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  EnvironmentId,
  type PluginCatalog,
  type PluginStatusAction,
  type PluginTone,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { View } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { ListRow } from "../../components/ui/ListRow";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { ListSection } from "../../components/ui/ListSection";
import { appAtomRegistry } from "../../state/atom-registry";
import { useEnvironments } from "../../state/environments";
import { pluginCatalogsAtom, pluginStatusByEnvironmentAtom } from "../../state/plugins";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOpenLinkedThread } from "../threads/useOpenLinkedThread";

type Entry = PluginCatalog["plugins"][number];

const PLUGIN_TONE_DOT_CLASS: Record<PluginTone, string> = {
  success: "bg-emerald-500",
  warning: "bg-warning-foreground",
  danger: "bg-danger-foreground",
  muted: "bg-foreground-muted",
};

/** One shared atom feeds every thread row, so a row costs a subscription and no request. */
export function PluginStatusDots({ environmentId }: { environmentId: EnvironmentId }) {
  const statuses = useAtomValue(pluginStatusByEnvironmentAtom).get(environmentId);
  if (statuses === undefined) return null;
  return (
    <View className="flex-row items-center gap-0.5">
      {statuses.map((status) => (
        <View
          key={status.key}
          className={`size-1.5 rounded-full ${PLUGIN_TONE_DOT_CLASS[status.tone]}`}
        />
      ))}
    </View>
  );
}

interface Run {
  readonly action: PluginStatusAction;
  readonly phase: "ask" | "running";
  /** Progress reported by a relayed step. */
  readonly status: string | null;
}

/** Plugin status items and actions for a thread, under its machine's name. */
export function PluginThreadRows({
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
  const { environments } = useEnvironments();
  if (views.length === 0) return null;
  return (
    <ListSection
      title={
        environments.find((environment) => environment.environmentId === environmentId)?.label ??
        "This machine"
      }
    >
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
    </ListSection>
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
  const execute = useAtomCommand(serverEnvironment.executePluginCommand, { reportFailure: false });
  const openThread = useOpenLinkedThread();
  const [run, setRun] = useState<Run | null>(null);
  const busy = run?.phase === "running";

  const executeStep = async (step: PluginActionStep): Promise<PluginActionReply> => {
    const target = EnvironmentId.make(step.environmentId);
    const entry =
      target === environmentId
        ? plugin
        : appAtomRegistry
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
  const start = (action: PluginStatusAction, destination: EnvironmentId | null) => {
    setRun({ action, phase: "running", status: null });
    void runPluginAction({
      start: {
        environmentId,
        commandId: action.command,
        input: pluginStatusActionInput(action, threadId, destination),
      },
      execute: executeStep,
      onStatus: (status) =>
        setRun((current) => (current?.phase === "running" ? { ...current, status } : current)),
    }).then((notice) => {
      setRun(null);
      if (notice === null) return;
      // An alert outlives this sheet, which closes when the action archives its own thread.
      const target = notice.thread;
      Dialog.alert(
        action.label.replace(/(…|\.\.\.)$/u, ""),
        notice.text,
        target
          ? [
              { text: "Close", style: "cancel" },
              { text: "Open thread", onPress: () => openThread(target) },
            ]
          : [{ text: "OK" }],
      );
    });
  };
  const confirmThenStart = (action: PluginStatusAction, destination: EnvironmentId | null) => {
    if (action.confirm === undefined) start(action, destination);
    else
      Dialog.confirm({
        title: action.label.replace(/(…|\.\.\.)$/u, ""),
        message: action.confirm,
        confirmText: "Continue",
        onConfirm: () => start(action, destination),
        onCancel: () => setRun(null),
      });
  };
  const press = (action: PluginStatusAction) => {
    if (action.environment !== undefined) setRun({ action, phase: "ask", status: null });
    else confirmThenStart(action, null);
  };

  return (
    <>
      {view?.blocks.map((block) =>
        block.kind === "status" &&
        (block.environmentId ?? environmentId) === targetEnvironmentId ? (
          <View key={block.id}>
            {block.label !== undefined ? (
              <View className="bg-grouped-card">
                <ListRowLayout
                  label={block.label}
                  {...(block.detail !== undefined ? { description: block.detail } : {})}
                  {...(block.tone
                    ? {
                        leading: (
                          <View
                            className={`size-2 rounded-full ${PLUGIN_TONE_DOT_CLASS[block.tone]}`}
                          />
                        ),
                      }
                    : {})}
                />
              </View>
            ) : null}
            {block.actions.map((action) => (
              <ActionRow
                key={action.id}
                action={action}
                environmentId={environmentId}
                plugin={plugin}
                busy={busy}
                working={busy && run?.action.id === action.id ? (run.status ?? "Working…") : null}
                onPress={press}
              />
            ))}
          </View>
        ) : null,
      )}
      {run?.phase === "ask" && run.action.environment ? (
        <Destinations
          environmentId={environmentId}
          plugin={plugin}
          label={run.action.environment.label}
          onPick={(destination) => confirmThenStart(run.action, destination)}
          onCancel={() => setRun(null)}
        />
      ) : null}
    </>
  );
}

function ActionRow({
  action,
  environmentId,
  plugin,
  busy,
  working,
  onPress,
}: {
  action: PluginStatusAction;
  environmentId: EnvironmentId;
  plugin: Entry;
  busy: boolean;
  working: string | null;
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
    <ListRow
      icon="arrow.right.circle"
      label={action.label}
      {...(working !== null ? { description: working } : {})}
      disabled={!command || !allowed || busy}
      onPress={() => onPress(action)}
    />
  );
}

function Destinations({
  environmentId,
  plugin,
  label,
  onPick,
  onCancel,
}: {
  environmentId: EnvironmentId;
  plugin: Entry;
  label: string;
  onPick: (destination: EnvironmentId) => void;
  onCancel: () => void;
}) {
  const catalogs = useAtomValue(pluginCatalogsAtom);
  const { environments } = useEnvironments();
  const destinations = pluginActionDestinations(catalogs, environmentId, plugin.id);
  const named = (id: EnvironmentId) => {
    const found = environments.find((environment) => environment.environmentId === id);
    return { label: found?.label ?? id, displayUrl: found?.displayUrl ?? null };
  };
  return (
    <View>
      {destinations.length === 0 ? (
        <View className="bg-grouped-card">
          <ListRowLayout
            label={`No other connected environment has ${plugin.name} installed.`}
            disabled
          />
        </View>
      ) : (
        destinations.map((target) => (
          <ListRow
            key={target.environmentId}
            icon="laptopcomputer"
            label={pluginDestinationLabel(named(target.environmentId), [
              named(environmentId).label,
              ...destinations
                .filter((other) => other.environmentId !== target.environmentId)
                .map((other) => named(other.environmentId).label),
            ])}
            description={label}
            onPress={() => onPick(target.environmentId)}
          />
        ))
      )}
      <ListRow icon="xmark" label="Cancel" onPress={onCancel} />
    </View>
  );
}
