"use client";
import { formatInTimeZone } from "date-fns-tz";
import type { ApplicationLocation } from "@/lib/upload-context-types";
import { AppliedIpLocationCell } from "./applied-ip-location-cell";

export function UploadDetails({
  applicationLocation,
  applied,
}: {
  applicationLocation: ApplicationLocation | null;
  applied: boolean;
}) {
  return (
    <section
      aria-label="Application location"
      className="min-w-0 space-y-2 rounded-lg border bg-muted/20 p-3"
    >
      <h3 className="text-sm font-semibold">Latest application location</h3>
      <AppliedIpLocationCell
        applicationLocation={applicationLocation}
        applied={applied}
      />
      {applicationLocation && (
        <p className="text-xs text-muted-foreground">
          Uploaded{" "}
          <time dateTime={applicationLocation.uploadedAt}>
            {formatInTimeZone(
              new Date(applicationLocation.uploadedAt),
              "America/Chicago",
              "MMM d, yyyy 'at' h:mm a 'CT'",
            )}
          </time>
        </p>
      )}
      <p className="text-[11px] text-muted-foreground">
        IP location is approximate. VPNs and proxies may affect the location.
      </p>
    </section>
  );
}
