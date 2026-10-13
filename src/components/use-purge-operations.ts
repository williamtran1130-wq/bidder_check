"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PurgeStatus } from "@/lib/bulk-types";
import { recentBidPurges } from "@/lib/read-client";

const ACTIVE_POLL_MS = 10_000;
const IDLE_POLL_MS = 30_000;
const COMPLETE_VISIBLE_MS = 6_000;

/**
 * Tracks unfinished screenshot cleanups. Polling is read-only; responses are ordered so a
 * slow older response never overwrites a newer one, and finished operations stay visible
 * briefly as "complete" before disappearing.
 */
export function usePurgeOperations(manager: boolean) {
  const [operations, setOperations] = useState<PurgeStatus[]>([]),
    [finished, setFinished] = useState<PurgeStatus[]>([]),
    [pollError, setPollError] = useState(false),
    [offset, setOffset] = useState(0),
    [tick, setTick] = useState(() => Date.now());
  const current = useRef<PurgeStatus[]>([]),
    sequence = useRef(0),
    applied = useRef(0),
    timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  const complete = useCallback((status: PurgeStatus) => {
    const done: PurgeStatus = {
      ...status,
      pendingFiles: 0,
      awaitingRemovalFiles: 0,
      verifyingFiles: 0,
      processingFiles: 0,
      failedFiles: 0,
      nextAttemptAt: null,
    };
    setFinished((list) => [done, ...list.filter((o) => o.id !== done.id)]);
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setFinished((list) => list.filter((o) => o.id !== done.id));
    }, COMPLETE_VISIBLE_MS);
    timers.current.add(timer);
  }, []);
  const commit = useCallback(
    (next: PurgeStatus[]) => {
      const done = current.current.filter(
        (o) => !next.some((n) => n.id === o.id),
      );
      current.current = next;
      setOperations(next);
      done.forEach(complete);
    },
    [complete],
  );
  /** Call before starting a request whose result will be passed to `remember`. */
  const begin = useCallback(() => ++sequence.current, []);
  const remember = useCallback(
    (status: PurgeStatus, token: number) => {
      if (token < applied.current) return;
      applied.current = token;
      setOffset(Date.parse(status.serverTime) - Date.now());
      const others = current.current.filter((o) => o.id !== status.id);
      commit(status.pendingFiles ? [status, ...others] : others);
    },
    [commit],
  );

  useEffect(() => {
    if (!manager) return;
    let cancelled = false,
      timer: ReturnType<typeof setTimeout>;
    async function load() {
      const token = ++sequence.current;
      try {
        const result = await recentBidPurges();
        if (cancelled) return;
        if (result.error || !result.data) setPollError(true);
        else if (token >= applied.current) {
          applied.current = token;
          setPollError(false);
          if (result.data[0])
            setOffset(Date.parse(result.data[0].serverTime) - Date.now());
          commit(result.data);
        }
      } catch {
        if (!cancelled) setPollError(true);
      }
      if (!cancelled)
        timer = setTimeout(
          () => void load(),
          current.current.length ? ACTIVE_POLL_MS : IDLE_POLL_MS,
        );
    }
    void load();
    const pending = timers.current;
    return () => {
      cancelled = true;
      clearTimeout(timer);
      pending.forEach(clearTimeout);
      pending.clear();
    };
  }, [manager, commit]);

  const active = operations.length > 0;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  return {
    operations,
    finished,
    pollError,
    serverNow: tick + offset,
    begin,
    remember,
  };
}
