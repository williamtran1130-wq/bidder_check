import type { NotificationResult } from "./notification-types";
type Resource<T> = {
  snapshot: () => NotificationResult<T>;
  subscribe: (listener: () => void) => () => void;
  refresh: () => Promise<void>;
  active: () => boolean;
  discard: () => void;
};
const resources = new Map<string, Resource<unknown>>();
let timer: ReturnType<typeof setInterval> | undefined;
function foreground() {
  return (
    typeof document === "undefined" || document.visibilityState === "visible"
  );
}
async function poll() {
  if (foreground()) await refreshNotificationScope("");
}
function startPolling() {
  if (timer || typeof window === "undefined") return;
  timer = setInterval(() => void poll(), 30000);
  window.addEventListener("focus", poll);
  document.addEventListener("visibilitychange", poll);
}
function stopPolling() {
  if ([...resources.values()].some((r) => r.active()) || !timer) return;
  clearInterval(timer);
  timer = undefined;
  window.removeEventListener("focus", poll);
  document.removeEventListener("visibilitychange", poll);
}
export function notificationResource<T>(
  key: string,
  load: () => Promise<NotificationResult<T>>,
  initial: NotificationResult<T> = {},
): Resource<T> {
  // Client Components also render on the server. Only a browser may retain
  // resources between renders; server requests must use their own initial data.
  const browser = typeof window !== "undefined";
  const existing = browser ? resources.get(key) : undefined;
  if (existing) return existing as Resource<T>;
  let value = initial;
  let pending: Promise<void> | undefined;
  let discarded = false;
  const listeners = new Set<() => void>();
  const resource: Resource<T> = {
    snapshot: () => value,
    active: () => listeners.size > 0,
    discard() {
      discarded = true;
      value = {};
      listeners.forEach((listener) => listener());
    },
    subscribe(listener) {
      listeners.add(listener);
      startPolling();
      return () => {
        listeners.delete(listener);
        stopPolling();
      };
    },
    refresh() {
      if (discarded) return Promise.resolve();
      if (pending) return pending;
      pending = load()
        .then(
          (result) => {
            if (discarded) return;
            value = result.error
              ? result.error === "Access denied" ||
                result.error === "Notification not found"
                ? { error: result.error }
                : { data: value.data, error: result.error }
              : result;
          },
          () => {
            if (discarded) return;
            value = {
              data: value.data,
              error: "Notifications are unavailable. Please retry.",
            };
          },
        )
        .finally(() => {
          pending = undefined;
          listeners.forEach((listener) => listener());
        });
      return pending;
    },
  };
  if (browser) resources.set(key, resource as Resource<unknown>);
  return resource;
}
export async function refreshNotificationScope(prefix: string) {
  await Promise.all(
    [...resources]
      .filter(([key, r]) => key.startsWith(prefix) && r.active())
      .map(([, r]) => r.refresh()),
  );
}
export function discardNotificationScope(prefix: string) {
  for (const [key, resource] of resources)
    if (key.startsWith(prefix)) {
      resources.delete(key);
      resource.discard();
    }
  stopPolling();
}
