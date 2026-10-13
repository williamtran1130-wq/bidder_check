"use client";

import { useEffect, useState } from "react";
import { Copy, LoaderCircle } from "lucide-react";
import { screenshotUploadContext } from "@/lib/upload-context-client";
import type { UploadContext } from "@/lib/upload-context-types";
import { Button } from "./ui/button";

export function AppliedIpLocationCell({
  fileId,
  actorScope,
  role,
  disabled,
}: {
  fileId: string | null;
  actorScope: string;
  role: string;
  disabled?: boolean;
}) {
  const [attempt, setAttempt] = useState(0);
  const [copyStatus, setCopyStatus] = useState("");
  const [loaded, setLoaded] = useState<{
    scope: string;
    data?: UploadContext | null;
    error?: string;
  }>();
  const manager = role === "client" || role === "admin";
  const scope = JSON.stringify([actorScope, role, fileId, attempt]);
  const result = loaded?.scope === scope ? loaded : undefined;

  useEffect(() => {
    if (!manager || !fileId) return;
    let cancelled = false;
    void screenshotUploadContext(actorScope, fileId).then((response) => {
      if (!cancelled) setLoaded({ scope, ...response });
    });
    return () => {
      cancelled = true;
    };
  }, [actorScope, fileId, manager, scope]);

  if (!manager) return null;
  if (!fileId)
    return (
      <span
        data-applied-ip-location
        data-state="empty"
        className="text-xs text-muted-foreground"
      >
        No screenshot
      </span>
    );

  const location = [
    result?.data?.city,
    result?.data?.region,
    result?.data?.country,
  ]
    .filter(Boolean)
    .join(", ");
  const state = !result
    ? "loading"
    : result.error
      ? "error"
      : !result.data
        ? "historical"
        : !result.data.ip && !location
          ? "unavailable"
          : "ready";

  async function copy() {
    if (!result?.data?.ip) return;
    try {
      await navigator.clipboard.writeText(result.data.ip);
      setCopyStatus("IP address copied");
    } catch {
      setCopyStatus("Could not copy. Select the IP address to copy it.");
    }
  }

  return (
    <div
      className="min-w-44 max-w-56 space-y-2 text-xs"
      data-grid-interactive
      data-applied-ip-location
      data-state={state}
      onCopy={(event) => event.stopPropagation()}
    >
      {!result ? (
        <p
          role="status"
          className="flex items-center gap-2 text-muted-foreground"
        >
          <LoaderCircle size={14} className="animate-spin" />
          Loading IP / location…
        </p>
      ) : result.error ? (
        <div className="space-y-2">
          <p role="alert" className="text-destructive">
            {result.error}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => {
              setCopyStatus("");
              setAttempt((value) => value + 1);
            }}
          >
            Retry IP / location
          </Button>
        </div>
      ) : result.data ? (
        <dl className="space-y-1.5">
          <div>
            <dt className="sr-only">IP address</dt>
            <dd className="flex min-w-0 items-center gap-1">
              <span className="min-w-0 select-text break-all font-mono">
                {result.data.ip || "Unavailable"}
              </span>
              {result.data.ip && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Copy IP address"
                  onClick={() => void copy()}
                >
                  <Copy size={14} />
                </Button>
              )}
            </dd>
          </div>
          <div title="IP location is approximate. VPNs and proxies may affect the location.">
            <dt className="text-muted-foreground">Approximate IP location</dt>
            <dd className="break-words">{location || "Unavailable"}</dd>
          </div>
        </dl>
      ) : (
        <p className="text-muted-foreground">
          Not recorded for this historical screenshot.
        </p>
      )}
      {copyStatus && (
        <p role="status" className="text-muted-foreground">
          {copyStatus}
        </p>
      )}
    </div>
  );
}
