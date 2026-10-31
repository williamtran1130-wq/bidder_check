"use client";

import { useState } from "react";
import { CheckCircle2, Copy, TriangleAlert } from "lucide-react";
import type { ApplicationLocation } from "@/lib/upload-context-types";
import {
  applicationLocationState,
  countryLabel,
} from "@/lib/application-location";
import { Button } from "./ui/button";

export function AppliedIpLocationCell({
  applicationLocation,
  applied,
}: {
  applicationLocation: ApplicationLocation | null;
  applied: boolean;
}) {
  const [copyStatus, setCopyStatus] = useState("");
  const state = applicationLocationState(applied, applicationLocation);
  const location = [
    applicationLocation?.city,
    applicationLocation?.region,
    applicationLocation?.country
      ? countryLabel(applicationLocation.country)
      : null,
  ]
    .filter(Boolean)
    .join(", ");
  const assessment =
    state === "us"
      ? "Applied from United States"
      : state === "warning"
        ? applicationLocation?.country
          ? "Applied from outside United States"
          : "Applied country unknown"
        : "Not applied";
  async function copy() {
    if (!applicationLocation?.ip) return;
    try {
      await navigator.clipboard.writeText(applicationLocation.ip);
      setCopyStatus("IP address copied");
    } catch {
      setCopyStatus("Could not copy. Select the IP address to copy it.");
    }
  }
  return (
    <div
      className="min-w-44 max-w-60 space-y-1.5 text-xs"
      data-grid-interactive
      data-applied-ip-location
      data-state={state}
      onCopy={(event) => event.stopPropagation()}
    >
      <p
        className={`flex items-center gap-1.5 ${state === "us" ? "text-emerald-700 dark:text-emerald-400" : state === "warning" ? "text-amber-800 dark:text-amber-400" : "text-muted-foreground"}`}
      >
        {state === "us" ? (
          <CheckCircle2 size={15} aria-hidden="true" />
        ) : state === "warning" ? (
          <TriangleAlert size={15} aria-hidden="true" />
        ) : null}
        <span>{assessment}</span>
      </p>
      {applicationLocation ? (
        <dl className="space-y-1.5">
          <div>
            <dt className="sr-only">IP address</dt>
            <dd className="flex min-w-0 items-center gap-1">
              <span className="min-w-0 select-text break-all font-mono">
                {applicationLocation.ip || "IP unavailable"}
              </span>
              {applicationLocation.ip && (
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
            <dd className="break-words">
              {location || "Location unavailable"}
            </dd>
          </div>
        </dl>
      ) : (
        <p className="text-muted-foreground">Location not recorded</p>
      )}
      {copyStatus && (
        <p role="status" className="text-muted-foreground">
          {copyStatus}
        </p>
      )}
    </div>
  );
}
