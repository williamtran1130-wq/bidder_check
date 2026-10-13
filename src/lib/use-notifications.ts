"use client";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  notificationResource,
  discardNotificationScope,
} from "./notification-store";
import type { NotificationResult } from "./notification-types";
export function useNotificationScope(scope: string) {
  const previous = useRef(scope);
  const [seed, setSeed] = useState({ scope, allowed: true });
  // Adjust the boundary before children render so old initial props cannot seed
  // the new scope, including when an account later returns to an earlier role.
  if (seed.scope !== scope) setSeed({ scope, allowed: false });
  useEffect(() => {
    if (previous.current !== scope) {
      discardNotificationScope(previous.current);
      previous.current = scope;
    }
  }, [scope]);
  return seed.scope === scope && seed.allowed;
}
export function useNotificationResource<T>(
  key: string,
  load: () => Promise<NotificationResult<T>>,
  initial: NotificationResult<T> = {},
) {
  const resource = notificationResource(key, load, initial);
  // A seed identifies this subscription; the store, not later SSR props,
  // decides whether the snapshot needs a new generation of reconciliation.
  const visit = useMemo(
    () => ({
      resource,
      consumer: {},
      seed: { data: initial.data, error: initial.error },
    }),
    [resource, initial.data, initial.error],
  );
  const result = useSyncExternalStore(
    resource.subscribe,
    resource.snapshot,
    () => initial,
  );
  useEffect(() => {
    void resource.mount(visit.consumer, visit.seed);
  }, [resource, visit]);
  return { ...result, retry: resource.refresh };
}
