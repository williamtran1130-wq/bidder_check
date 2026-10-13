"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
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
  const result = useSyncExternalStore(
    resource.subscribe,
    resource.snapshot,
    () => initial,
  );
  useEffect(() => {
    void resource.refresh();
  }, [resource]);
  return { ...result, retry: resource.refresh };
}
