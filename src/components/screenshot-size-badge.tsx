"use client";

import { Popover } from "radix-ui";
import type { BidRow } from "@/lib/workspace-types";
import { screenshotSizeSummary } from "@/lib/screenshot-size";

export function ScreenshotSizeBadge({ bid, role }: { bid: BidRow; role: string }) {
  const summary = screenshotSizeSummary(bid, role);
  if (!summary) return null;
  if (summary.bytes === null) {
    return <span className="text-[10px] text-muted-foreground">Size unavailable</span>;
  }
  const bytes = summary.bytes.toLocaleString("en-US");
  const matches = `${summary.count} screenshot${summary.count === 1 ? "" : "s"} with this exact size in current results`;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          data-grid-interactive
          aria-label={`Screenshot size: ${bytes} bytes; ${matches}`}
          className={`shrink-0 whitespace-nowrap rounded border px-1.5 py-0.5 text-[10px] font-medium tabular-nums focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2 ${summary.colorClass || "border-border bg-muted text-muted-foreground"}`}
        >
          {summary.badgeLabel}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content sideOffset={5} collisionPadding={8} className="z-50 w-64 space-y-2 rounded-md border bg-card p-3 text-xs text-foreground shadow-lg" aria-label="Screenshot file size details">
          <p className="font-medium tabular-nums">{bytes} bytes</p>
          <p>{matches} (including this screenshot).</p>
          <p className="text-muted-foreground">Matching file size is a review aid; it does not prove identical image content.</p>
          <Popover.Close className="text-xs text-primary">Close size details</Popover.Close>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
