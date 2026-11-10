import { clientNoticeInApp, deliverClientNotice, nextClientNoticeId } from "./clientNoticeRouter";
import { Alert } from "react-native";
import type { ConfirmDialogRequest, TextInputDialogRequest } from "./Dialog.types";

export type { ConfirmDialogRequest, TextInputDialogRequest } from "./Dialog.types";

export function alert(...args: Parameters<typeof Alert.alert>): void {
  const [title, message] = args;
  const notice = {
    id: nextClientNoticeId(),
    title: title ?? "T3 Code",
    ...(message ? { description: message } : {}),
    interactive: true,
  };
  deliverClientNotice(notice);
  if (clientNoticeInApp(notice)) Alert.alert(...args);
}

export function confirm(request: ConfirmDialogRequest): void {
  Alert.alert(request.title, request.message, [
    { text: request.cancelText ?? "Cancel", style: "cancel", onPress: request.onCancel },
    {
      text: request.confirmText,
      style: request.destructive ? "destructive" : "default",
      onPress: request.onConfirm,
    },
  ]);
}

export function prompt(request: TextInputDialogRequest): void {
  Alert.prompt(
    request.title,
    request.message,
    [
      { text: request.cancelText ?? "Cancel", style: "cancel", onPress: request.onCancel },
      { text: request.confirmText, onPress: (value) => request.onConfirm(value ?? "") },
    ],
    "plain-text",
    request.initialValue,
  );
}

export function Host() {
  return null;
}
