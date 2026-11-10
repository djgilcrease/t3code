import {
  type EnvironmentThreadShell,
  type PendingSubagentRequest,
  presentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  clientNotificationRevisionId,
  resolveClientNoticeRoute,
  resolvePluginNotificationRoute,
} from "@t3tools/client-runtime/notificationRouting";
import { pluginCatalogsAtom } from "../state/plugins";
import { isShownUnderParent } from "@t3tools/client-runtime/state/threads";
import type { AnyRouter } from "@tanstack/react-router";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import { EnvironmentId, type OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import { monitorHoldsWakeCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Option from "effect/Option";
import type { AtomRegistry } from "effect/reactivity";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
} from "lucide-react";

import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { serverEnvironment } from "../state/server";
import { getClientSettings, subscribeClientSettings } from "../hooks/useSettings";
import { isWindowsPlatform, randomUUID } from "../lib/utils";
import { environmentSummaries } from "../state/presentation";
import { environmentShell } from "../state/shell";
import { environmentThreadShells } from "../state/threads";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  playNotificationSound,
  setNotificationBadge,
  threadNotificationTag,
  unlockNotificationAudio,
} from "../threadNotifications";
import { resolveBackgroundThreadRequest } from "./backgroundThreadAnnouncement";
import { resolveSidebarThreadStatus, type SidebarThreadStatus } from "./Sidebar.logic";
import {
  createThreadNotificationGate,
  type ThreadNotificationKind,
  type ThreadNotificationObservation,
} from "./ThreadNotificationCoordinator.logic";
import { setToastNotificationRouter, toastManager } from "./ui/toast";

interface NotificationState extends ThreadNotificationObservation {
  readonly raw: OrchestrationV2ThreadShell;
  readonly subagentRequest: PendingSubagentRequest | null;
  readonly thread: EnvironmentThreadShell;
  readonly status: SidebarThreadStatus;
}

type ToastId = ReturnType<typeof toastManager.add>;

interface WatchedEnvironment {
  unsubscribe: () => void;
  previous: Map<ThreadId, NotificationState>;
  reconnecting: boolean;
  readonly gate: ReturnType<typeof createThreadNotificationGate<ThreadId>>;
}

/**
 * Turns thread status transitions in every connected environment into sounds, in-app toasts,
 * and desktop notifications, and keeps the dock badge in step with the unread ones.
 */
export function startThreadNotifications(
  registry: AtomRegistry.AtomRegistry,
  router: AnyRouter,
): () => void {
  const deliveredNotices = new Set<string>();
  const pending = new Map<
    string,
    { environmentId: EnvironmentId; threadId: ThreadId; notification: Notification }
  >();
  const watched = new Map<EnvironmentId, WatchedEnvironment>();

  const trackNotification = (
    environmentId: EnvironmentId,
    threadId: ThreadId,
    notification: Notification,
  ) => {
    pending.get(notification.tag)?.notification.close();
    pending.set(notification.tag, { environmentId, threadId, notification });
    setNotificationBadge(pending.size);
  };
  // Toast ids by thread key, so hiding a thread can close its open toasts.
  const openToasts = new Map<string, Array<ToastId>>();
  const forgetToast = (key: string, toastId: ToastId) => {
    const remaining = (openToasts.get(key) ?? []).filter((id) => id !== toastId);
    if (remaining.length === 0) openToasts.delete(key);
    else openToasts.set(key, remaining);
  };
  // A notification shown before the tag filter turned on must not stay on screen. While hiding,
  // one whose thread left the live list (archived) cannot be judged, so it closes too.
  const closeHiddenPending = () => {
    const hidden = registry.get(environmentThreadShells.hiddenThreadKeysAtom);
    const live = registry.get(environmentThreadShells.anyEnvironmentHidingAtom)
      ? new Set(registry.get(environmentThreadShells.threadRefsAtom).map(threadKey))
      : null;
    const shouldClose = (key: string) => hidden.has(key) || (live !== null && !live.has(key));
    for (const [key, toastIds] of openToasts) {
      if (!shouldClose(key)) continue;
      for (const toastId of toastIds) toastManager.close(toastId);
      openToasts.delete(key);
    }
    const count = pending.size;
    for (const [tag, entry] of pending) {
      if (!shouldClose(threadKey(entry))) continue;
      entry.notification.close();
      pending.delete(tag);
    }
    if (count !== pending.size) setNotificationBadge(pending.size);
  };
  const clearPending = () => {
    for (const { notification } of pending.values()) notification.close();
    pending.clear();
    setNotificationBadge(0);
  };

  const present = (
    environmentId: EnvironmentId,
    state: NotificationState,
    kind: ThreadNotificationKind,
  ) => {
    const { thread, status } = state;
    if (
      registry
        .get(environmentThreadShells.hiddenThreadKeysAtom)
        .has(threadKey({ environmentId, threadId: thread.id }))
    )
      return;
    const effectivePreferences = () => {
      const route = resolvePluginNotificationRoute(
        registry.get(pluginCatalogsAtom).find((entry) => entry.environmentId === environmentId)
          ?.catalog ?? null,
        {
          kind:
            kind === "completion"
              ? "completion"
              : status === "approval"
                ? "approval"
                : status === "limited"
                  ? "usage-limit"
                  : status === "failed"
                    ? "failure"
                    : status === "request"
                      ? "guest-request"
                      : "input",
          projectId: state.raw.projectId,
          provider: state.raw.providerInstanceId,
        },
      );
      return route
        ? {
            notificationMode:
              route.mode === "inherit" ? getClientSettings().notificationMode : route.mode,
            inAppNotificationsEnabled: route.inApp,
          }
        : getClientSettings();
    };
    const { notificationMode: mode, inAppNotificationsEnabled } = effectivePreferences();
    const active = (router.state.matches.at(-1)?.params ?? {}) as {
      environmentId?: string;
      threadId?: string;
    };
    const title =
      kind === "completion"
        ? "Thread completed"
        : status === "approval"
          ? "Approval needed"
          : status === "limited"
            ? "Usage limit reached"
            : status === "failed"
              ? "Thread failed"
              : status === "request"
                ? "Guest request"
                : "Input needed";
    if (hasNotificationSound(mode)) {
      void playNotificationSound(kind, () =>
        hasNotificationSound(effectivePreferences().notificationMode),
      );
    }
    if (
      inAppNotificationsEnabled &&
      document.visibilityState === "visible" &&
      document.hasFocus() &&
      (active.environmentId !== environmentId || active.threadId !== thread.id)
    ) {
      const toastKey = threadKey({ environmentId, threadId: thread.id });
      const toastId: ToastId = toastManager.add({
        onRemove: (): void => forgetToast(toastKey, toastId),
        type: kind === "completion" ? "success" : status === "failed" ? "error" : "warning",
        title,
        description: thread.title,
        data: {
          notificationOrigin: "thread",
          hideCopyButton: true,
          leadingIcon:
            kind === "completion" ? (
              <CircleCheckIcon aria-hidden className="size-4 text-success-foreground" />
            ) : status === "approval" ? (
              <ShieldQuestionIcon aria-hidden className="size-4 text-warning-foreground" />
            ) : status === "limited" ? (
              <CircleAlertIcon aria-hidden className="size-4 text-warning-foreground" />
            ) : status === "failed" ? (
              <CircleAlertIcon aria-hidden className="size-4 text-destructive-foreground" />
            ) : (
              <MessageCircleQuestionIcon aria-hidden className="size-4 text-info-foreground" />
            ),
        },
        actionProps: {
          children: "Open thread",
          onClick: () => {
            toastManager.close(toastId);
            void router.navigate({
              to: "/$environmentId/$threadId",
              params: { environmentId, threadId: thread.id },
            });
          },
        },
      });
      openToasts.set(toastKey, [...(openToasts.get(toastKey) ?? []), toastId]);
      return;
    }
    if (
      !hasDesktopNotifications(mode) ||
      (document.visibilityState === "visible" && document.hasFocus()) ||
      typeof Notification === "undefined" ||
      Notification.permission !== "granted"
    )
      return;
    try {
      const notification = new Notification(title, {
        body: thread.title,
        tag: threadNotificationTag(environmentId, thread.id),
        silent: true,
        // Windows drops clicks after a toast moves into Notification Center.
        requireInteraction: kind === "completion" && isWindowsPlatform(navigator.platform),
      });
      trackNotification(environmentId, thread.id, notification);
      notification.addEventListener("click", () => {
        notification.close();
        window.focus();
        void window.desktopBridge?.revealWindow().catch(() => undefined);
        void router.navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId: thread.id },
        });
      });
    } catch {
      // Some browsers expose Notification but reject desktop presentation.
    }
  };

  const observeThreads = (
    environmentId: EnvironmentId,
    entry: WatchedEnvironment,
    threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  ) => {
    const previous = entry.previous;
    const next = new Map<ThreadId, NotificationState>();
    // A parent here also hears of what its tasks on linked environments ask.
    const subagentRequests = registry.get(
      environmentThreadShells.pendingSubagentRequestsAtom(environmentId),
    );
    const delegatedUnderParent = registry.get(environmentThreadShells.delegatedUnderParentAtom);
    const changed: Array<[NotificationState | undefined, NotificationState]> = [];
    for (const rawThread of threads) {
      if (
        isShownUnderParent(
          { environmentId, threadId: rawThread.id },
          rawThread.lineage,
          delegatedUnderParent,
        )
      ) {
        continue;
      }
      const prior = previous.get(rawThread.id);
      const subagentRequest = subagentRequests.get(rawThread.id) ?? null;
      if (
        !entry.reconnecting &&
        prior?.raw === rawThread &&
        prior.subagentRequest === subagentRequest
      ) {
        next.set(rawThread.id, prior);
        continue;
      }
      const thread = presentThreadShell(environmentId, rawThread, subagentRequest);
      let status = resolveSidebarThreadStatus(thread);
      if (status === "ready" && thread.latestRun?.status === "failed") status = "failed";
      const needsAttention =
        status === "input" ||
        status === "request" ||
        status === "approval" ||
        status === "failed" ||
        status === "limited";
      const requestId = needsAttention ? resolveBackgroundThreadRequest(thread).requestId : null;
      const attention = needsAttention
        ? `${thread.latestRun?.runId ?? ""}:${status}:${requestId ?? ""}`
        : null;
      const completed = status === "ready" && thread.latestRun?.status === "completed";
      const settled = completed && !monitorHoldsWakeCompletion(rawThread);
      const parsedCompletedAt = Date.parse(thread.latestRun?.completedAt ?? "");
      const completedAt = Number.isFinite(parsedCompletedAt) ? parsedCompletedAt : null;
      const state = {
        raw: rawThread,
        subagentRequest,
        thread,
        status,
        attention,
        requestId,
        settled,
        completedAt: settled ? completedAt : null,
        backgroundWake: rawThread.latestRunBackgroundWake === true,
      };
      next.set(thread.id, state);
      changed.push([prior, state]);
    }
    entry.reconnecting = false;
    entry.previous = next;
    entry.gate.retain(new Set(next.keys()));
    for (const [prior, state] of changed) {
      entry.gate.observe(state.thread.id, prior, state, {
        archived: state.thread.archivedAt !== null,
        quiet: state.raw.latestRunStopRequested === true,
      });
    }
  };

  const watchEnvironment = (environmentId: EnvironmentId): WatchedEnvironment => {
    const entry: WatchedEnvironment = {
      previous: new Map(),
      reconnecting: false,
      unsubscribe: () => {},
      gate: createThreadNotificationGate<ThreadId>((threadId, kind) => {
        const state = entry.previous.get(threadId);
        if (state) present(environmentId, state, kind);
      }),
    };
    let threads: ReadonlyArray<OrchestrationV2ThreadShell> | null = null;
    const unsubscribeShell = registry.subscribe(
      environmentShell.stateValueAtom(environmentId),
      (shell) => {
        threads =
          shell.status === "live" && Option.isSome(shell.snapshot)
            ? shell.snapshot.value.threads
            : null;
        if (threads !== null) {
          observeThreads(environmentId, entry, threads);
          return;
        }
        entry.reconnecting = true;
        entry.gate.pause();
      },
      { immediate: true },
    );
    const reobserve = () => {
      if (threads !== null) observeThreads(environmentId, entry, threads);
    };
    const unsubscribeRequests = registry.subscribe(
      environmentThreadShells.pendingSubagentRequestsAtom(environmentId),
      reobserve,
    );
    const unsubscribeDelegated = registry.subscribe(
      environmentThreadShells.delegatedUnderParentAtom,
      reobserve,
    );
    entry.unsubscribe = () => {
      unsubscribeShell();
      unsubscribeRequests();
      unsubscribeDelegated();
      entry.gate.clear();
    };
    return entry;
  };

  const syncEnvironments = () => {
    const { notificationMode, inAppNotificationsEnabled } = getClientSettings();
    const catalogs = registry.get(pluginCatalogsAtom);
    const enabled = notificationMode !== "off" || inAppNotificationsEnabled;
    const environmentIds = registry
      .get(environmentSummaries.environmentIdsAtom)
      .filter(
        (environmentId) =>
          enabled ||
          catalogs
            .find((entry) => entry.environmentId === environmentId)
            ?.catalog?.plugins.some(
              (plugin) =>
                plugin.status === "active" &&
                plugin.notificationRoutes?.some(
                  (route) =>
                    (route.inApp || route.mode !== "off") &&
                    route.events.some((kind) =>
                      [
                        "completion",
                        "input",
                        "approval",
                        "failure",
                        "usage-limit",
                        "guest-request",
                      ].includes(kind),
                    ),
                ),
            ),
      );
    const activeIds = new Set(environmentIds);
    for (const [environmentId, entry] of watched) {
      if (activeIds.has(environmentId)) continue;
      entry.unsubscribe();
      watched.delete(environmentId);
    }
    for (const environmentId of environmentIds) {
      if (!watched.has(environmentId)) watched.set(environmentId, watchEnvironment(environmentId));
    }
  };

  const pruneRemovedEnvironments = () => {
    const activeIds = new Set(registry.get(environmentSummaries.environmentIdsAtom));
    const count = pending.size;
    for (const [tag, entry] of pending) {
      if (activeIds.has(entry.environmentId)) continue;
      entry.notification.close();
      pending.delete(tag);
    }
    if (count !== pending.size) setNotificationBadge(pending.size);
  };

  let appliedMode: string | null = null;
  let nativeListening = false;
  let soundListening = false;
  let stopNativeListeners = () => {};
  let stopSoundListeners = () => {};
  const stopModeListeners = () => {
    stopNativeListeners();
    stopSoundListeners();
  };
  const applyMode = () => {
    const nextMode = getClientSettings().notificationMode;
    const routes = registry
      .get(pluginCatalogsAtom)
      .flatMap((entry) =>
        (entry.catalog?.plugins ?? []).flatMap((plugin) =>
          plugin.status === "active" ? (plugin.notificationRoutes ?? []) : [],
        ),
      );
    if (nextMode !== appliedMode) {
      appliedMode = nextMode;
      clearPending();
    }
    const native =
      hasDesktopNotifications(nextMode) ||
      routes.some((route) => route.mode !== "inherit" && hasDesktopNotifications(route.mode));
    const sound =
      hasNotificationSound(nextMode) ||
      routes.some((route) => route.mode !== "inherit" && hasNotificationSound(route.mode));
    if (native !== nativeListening) {
      nativeListening = native;
      stopNativeListeners();
      stopNativeListeners = () => {};
      if (native) {
        const unsubscribe = window.desktopBridge?.onNotificationBadgeClear(clearPending);
        window.addEventListener("focus", clearPending);
        stopNativeListeners = () => {
          unsubscribe?.();
          window.removeEventListener("focus", clearPending);
          clearPending();
        };
      }
    }
    if (sound !== soundListening) {
      soundListening = sound;
      stopSoundListeners();
      stopSoundListeners = () => {};
      if (sound) {
        document.addEventListener("pointerdown", unlockNotificationAudio);
        document.addEventListener("keydown", unlockNotificationAudio);
        stopSoundListeners = () => {
          document.removeEventListener("pointerdown", unlockNotificationAudio);
          document.removeEventListener("keydown", unlockNotificationAudio);
        };
      }
    }
  };

  const onSettings = () => {
    applyMode();
    syncEnvironments();
  };
  setToastNotificationRouter((options) => {
    if (options.data?.notificationOrigin) return undefined;
    const ref = options.data?.threadRef;
    const source = ref ? registry.get(environmentThreadShells.quietThreadShellAtom(ref)) : null;
    const sourceEnvironmentId = options.data?.notificationEnvironmentId ?? ref?.environmentId;
    const sourceProjectId = options.data?.notificationProjectId ?? source?.projectId;
    const sourceProvider = source?.runtime?.providerInstanceId ?? source?.modelSelection.instanceId;
    const event = {
      kind: options.data?.notificationKind ?? "notice",
      ...(sourceEnvironmentId ? { environmentId: sourceEnvironmentId } : {}),
      ...(sourceProjectId ? { projectId: sourceProjectId } : {}),
      ...(sourceProvider ? { provider: sourceProvider } : {}),
    };
    const routing = resolveClientNoticeRoute(registry.get(pluginCatalogsAtom), event);
    if (!routing) return undefined;
    const mode =
      routing.route.mode === "inherit" ? getClientSettings().notificationMode : routing.route.mode;
    const title = typeof options.title === "string" ? options.title : "T3 Code notice";
    const description = typeof options.description === "string" ? options.description : undefined;
    const interactive =
      options.actionProps ||
      options.onRemove ||
      options.data?.onClose ||
      options.data?.additionalActions?.length ||
      options.data?.secondaryActionProps ||
      options.data?.expandableContent ||
      options.type === "loading" ||
      typeof options.title !== "string" ||
      (options.description != null && typeof options.description !== "string");
    const id = clientNotificationRevisionId(
      options.id ?? randomUUID(),
      `${options.type}:${title}:${description ?? ""}`,
    );
    if (deliveredNotices.has(id)) return routing.route.inApp || Boolean(interactive);
    deliveredNotices.add(id);
    if (deliveredNotices.size > 1000)
      deliveredNotices.delete(deliveredNotices.values().next().value!);
    if (routing.command) {
      const environmentId = EnvironmentId.make(routing.environmentId);
      const input = {
        pluginId: routing.pluginId,
        commandId: routing.command.id,
        permission: routing.command.permission,
        input: {
          id,
          kind: options.data?.notificationKind ?? "notice",
          title: title.slice(0, 200),
          ...(routing.route.includeDescription && description
            ? { description: description.slice(0, 16384) }
            : {}),
          path: options.data?.notificationPath ?? window.location.pathname,
          ...(sourceProjectId ? { projectId: sourceProjectId } : {}),
          ...(sourceProvider ? { provider: sourceProvider } : {}),
        },
      };
      if (registry.get(serverEnvironment.executePluginCommand.permissionAtom(environmentId, input)))
        void runAtomCommand(
          registry,
          serverEnvironment.executePluginCommand,
          { environmentId, input },
          { reportFailure: false, reportDefect: false },
        );
    }
    if (hasNotificationSound(mode))
      void playNotificationSound(options.type === "success" ? "completion" : "input", () => {
        const current = resolveClientNoticeRoute(registry.get(pluginCatalogsAtom), event);
        return (
          current !== undefined &&
          hasNotificationSound(
            current.route.mode === "inherit"
              ? getClientSettings().notificationMode
              : current.route.mode,
          )
        );
      });
    if (
      hasDesktopNotifications(mode) &&
      typeof Notification !== "undefined" &&
      Notification.permission === "granted" &&
      !(document.visibilityState === "visible" && document.hasFocus())
    ) {
      try {
        const notification = new Notification(title, {
          ...((options.data?.notificationNativeDescription ?? description) === undefined
            ? {}
            : { body: options.data?.notificationNativeDescription ?? description! }),
          tag: id,
          silent: true,
        });
        notification.addEventListener("click", () => {
          notification.close();
          window.focus();
          void window.desktopBridge?.revealWindow().catch(() => undefined);
          options.data?.notificationAction?.();
        });
      } catch {
        return true;
      }
    }
    return routing.route.inApp || Boolean(interactive);
  });
  const unsubscribeSettings = subscribeClientSettings(onSettings);
  const unsubscribeRouting = registry.subscribe(pluginCatalogsAtom, onSettings);
  const unsubscribeEnvironmentIds = registry.subscribe(
    environmentSummaries.environmentIdsAtom,
    () => {
      pruneRemovedEnvironments();
      syncEnvironments();
    },
  );
  const unsubscribeHidden = [
    registry.subscribe(environmentThreadShells.hiddenThreadKeysAtom, closeHiddenPending),
    registry.subscribe(environmentThreadShells.anyEnvironmentHidingAtom, closeHiddenPending),
    registry.subscribe(environmentThreadShells.threadRefsAtom, closeHiddenPending),
  ];
  onSettings();

  return () => {
    setToastNotificationRouter(undefined);
    unsubscribeSettings();
    unsubscribeRouting();
    unsubscribeEnvironmentIds();
    for (const unsubscribe of unsubscribeHidden) unsubscribe();
    for (const entry of watched.values()) entry.unsubscribe();
    watched.clear();
    stopModeListeners();
  };
}
