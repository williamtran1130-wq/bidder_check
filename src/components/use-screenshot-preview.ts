"use client";
import { useEffect, useState } from "react";
import { invalidateThumbnail, thumbnailUrl } from "@/lib/read-scope";
import { useDocumentVisible } from "@/lib/use-document-visible";

type Preview = {
  key: string;
  url: string;
  expiresAt: number;
  error: string;
};

/** The displayed source is stable; expiring authorization is renewed separately. */
export function useScreenshotPreview(scope: string, fileId: string | null, enabled: boolean) {
  const foreground = useDocumentVisible();
  const [attempt, setAttempt] = useState(0);
  const [preview, setPreview] = useState<Preview>();
  const [expiredAt, expire] = useState(0);
  const key = JSON.stringify([scope, fileId, attempt]);
  const current = preview?.key === key ? preview : undefined;
  const error = current?.error ?? "";
  const active = foreground && enabled;

  useEffect(() => {
    if (!active || !fileId || error) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      const result = await thumbnailUrl(scope, fileId!);
      if (cancelled || document.visibilityState !== "visible") return;
      const expiresAt = Date.parse(result.data?.expiresAt ?? "");
      const remaining = expiresAt - Date.now();
      if (!result.data || !Number.isFinite(remaining) || remaining <= 0) {
        setPreview({ key, url: "", expiresAt: 0, error: result.error ?? "Preview expired. Retry to refresh." });
        return;
      }
      const url = result.data.url;
      setPreview((previous) => ({
        key,
        // A new signature is permission to keep showing the loaded image,
        // not a reason to download the same immutable file again.
        url: previous?.key === key && previous.url ? previous.url : url,
        expiresAt,
        error: "",
      }));
      timer = setTimeout(() => void load(), remaining > 15_000 ? remaining - 15_000 : Math.max(100, remaining / 2));
    }
    void load();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, fileId, scope, key, error]);

  const expiresAt = current?.expiresAt ?? 0;
  useEffect(() => {
    if (!expiresAt) return;
    // Hide an expired preview even if its renewal is slow or the tab was hidden.
    const timer = setTimeout(() => expire(expiresAt), Math.max(0, expiresAt - Date.now()));
    // A suspended browser may deliver visibilitychange before overdue timers.
    const resumed = () => {
      if (document.visibilityState === "visible" && Date.now() >= expiresAt)
        expire(expiresAt);
    };
    document.addEventListener("visibilitychange", resumed);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", resumed);
    };
  }, [expiresAt]);

  return {
    url: current?.url ?? "",
    authorized: expiresAt > 0 && expiredAt !== expiresAt,
    error,
    fail() {
      setPreview({ key, url: "", expiresAt: 0, error: "Preview expired. Retry to refresh." });
    },
    retry() {
      if (fileId) invalidateThumbnail(scope, fileId);
      setAttempt((n) => n + 1);
    },
  };
}
