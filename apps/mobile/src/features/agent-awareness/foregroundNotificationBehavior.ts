import type { Notification, NotificationBehavior } from "expo-notifications";

import { extractAgentNotificationDeepLink } from "./notificationPayload";

const SHOW: NotificationBehavior = {
  shouldShowBanner: true,
  shouldShowList: true,
  shouldPlaySound: true,
  shouldSetBadge: false,
};

const SUPPRESS: NotificationBehavior = {
  shouldShowBanner: false,
  shouldShowList: false,
  shouldPlaySound: false,
  shouldSetBadge: false,
};

export function foregroundNotificationBehavior(
  notification: Notification,
  deepLinkOnScreen: string | null,
): NotificationBehavior {
  const data = notification.request.content.data;
  if (data?.t3PluginNotice === true) {
    const mode = data.mode;
    return {
      shouldShowBanner: mode === "notifications" || mode === "notifications-and-sound",
      shouldShowList: mode === "notifications" || mode === "notifications-and-sound",
      shouldPlaySound: mode === "sound" || mode === "notifications-and-sound",
      shouldSetBadge: false,
    };
  }
  const target = extractAgentNotificationDeepLink({ notification });
  if (target !== null && target === deepLinkOnScreen) {
    return SUPPRESS;
  }
  return SHOW;
}
