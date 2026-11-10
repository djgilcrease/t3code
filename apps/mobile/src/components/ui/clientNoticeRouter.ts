export interface ClientNotice {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly interactive: boolean;
}
let router:
  | {
      readonly inApp: (notice: ClientNotice) => boolean;
      readonly deliver: (notice: ClientNotice) => void;
    }
  | undefined;
export function installClientNoticeRouter(next: typeof router) {
  router = next;
  refreshClientNoticeRouting();
  return () => {
    if (router === next) {
      router = undefined;
      refreshClientNoticeRouting();
    }
  };
}
export function clientNoticeInApp(notice: ClientNotice) {
  try {
    return notice.interactive || (router?.inApp(notice) ?? true);
  } catch {
    return true;
  }
}
export function deliverClientNotice(notice: ClientNotice) {
  try {
    router?.deliver(notice);
  } catch {
    /* Keep the original presentation available. */
  }
}

let revision = 0;
const listeners = new Set<() => void>();
export function refreshClientNoticeRouting() {
  revision++;
  for (const listener of listeners) listener();
}
export function subscribeClientNoticeRouting(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function clientNoticeRoutingRevision() {
  return revision;
}
export function clientNoticeRevisionId(id: string, content: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < content.length; index++)
    hash = Math.imul(hash ^ content.charCodeAt(index), 0x01000193);
  return `${id}:${(hash >>> 0).toString(16)}`;
}

let noticeSequence = 0;
export function nextClientNoticeId() {
  return `notice-${++noticeSequence}`;
}
