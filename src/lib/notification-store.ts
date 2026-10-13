import type { NotificationResult } from "./notification-types";
type Resource<T> = {
  snapshot: () => NotificationResult<T>;
  mount: (consumer: object, seed?: NotificationResult<T>) => Promise<void>;
  subscribe: (listener: () => void) => () => void;
  refresh: (invalidate?: boolean) => Promise<void>;
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
  if (foreground()) await refreshNotificationScope("", false);
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
  let generation = 0;
  const listeners = new Set<() => void>();
  const consumers = new WeakSet<object>();
  const acceptedSeed = initial.data !== undefined || !!initial.error;
  let hasMounted = false;
  let session = 0;
  let handledSession = 0;
  let wasInactive = false;
  const resource: Resource<T> = {
    snapshot: () => value,
    active: () => listeners.size > 0,
    mount(consumer, seed = initial) {
      if (discarded) return Promise.resolve();
      // A retained/offscreen consumer may return with the same hook identity.
      // A real inactive turn still needs reconciliation; immediate effect
      // cleanup/setup replays are distinguished by the subscription generation.
      if (wasInactive) {
        wasInactive = false;
        hasMounted = true;
        handledSession = session;
        consumers.add(consumer);
        return resource.refresh(true);
      }
      // Effect replays for one consumer are not a new visit. Multiple active
      // consumers share one session and never replace a mutation with SSR props.
      if (consumers.has(consumer)) {
        handledSession = session;
        return pending ?? Promise.resolve();
      }
      consumers.add(consumer);
      const first = !hasMounted;
      const returning = hasMounted && handledSession !== session;
      hasMounted = true;
      handledSession = session;
      if (
        first &&
        (!acceptedSeed ||
          seed.data !== initial.data ||
          seed.error !== initial.error)
      )
        return resource.refresh();
      // A reused inactive resource ignored the new SSR seed. Read once with a
      // new generation; old pending reads/older SSR props cannot win this visit.
      if (returning) return resource.refresh(true);
      return pending ?? Promise.resolve();
    },
    discard() {
      discarded = true;
      generation++;
      value = {};
      listeners.forEach((listener) => listener());
    },
    subscribe(listener) {
      if (!listeners.size) session++;
      listeners.add(listener);
      startPolling();
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          const inactiveSession = session;
          queueMicrotask(() => {
            if (!listeners.size && session === inactiveSession)
              wasInactive = true;
          });
        }
        stopPolling();
      };
    },
    refresh(invalidate = false) {
      if (discarded) return Promise.resolve();
      if (invalidate) {
        generation++;
        pending = undefined;
      }
      if (pending) return pending;
      const current = generation;
      pending = load()
        .then(
          (result) => {
            if (discarded || current !== generation) return;
            value = result.error
              ? result.error === "Access denied" ||
                result.error === "Notification not found"
                ? { error: result.error }
                : { data: value.data, error: result.error }
              : result;
          },
          () => {
            if (discarded || current !== generation) return;
            value = {
              data: value.data,
              error: "Notifications are unavailable. Please retry.",
            };
          },
        )
        .finally(() => {
          if (current !== generation) return;
          pending = undefined;
          listeners.forEach((listener) => listener());
        });
      return pending;
    },
  };
  if (browser) resources.set(key, resource as Resource<unknown>);
  return resource;
}
export async function refreshNotificationScope(
  prefix: string,
  invalidate = true,
) {
  await Promise.all(
    [...resources]
      .filter(([key, r]) => key.startsWith(prefix) && r.active())
      .map(([, r]) => r.refresh(invalidate)),
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
