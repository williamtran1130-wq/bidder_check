"use client";
import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import { formatInTimeZone } from "date-fns-tz";
import { toast } from "sonner";
import type { BidTarget } from "@/lib/bulk-types";
import {
  deleteBids,
  retryPurgeCleanup,
  reviewBidsAction,
  manualApplyBidsAction,
} from "@/app/(workspace)/actions";
import { canRetryPurge, purgeMessage } from "@/lib/purge-status";
import { usePurgeOperations } from "./use-purge-operations";
import { Button } from "./ui/button";
import { Field } from "./common";
import { Textarea } from "./ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";

export function BulkBidToolbar({
  targets,
  manager,
  disabled,
  loading,
  clear,
  onDone,
  onBusy,
}: {
  targets: BidTarget[];
  trash: boolean;
  manager: boolean;
  bidderId?: string;
  disabled: boolean;
  loading: boolean;
  clear: () => void;
  onDone: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const [busy, setBusy] = useState(false),
    [deleting, setDeleting] = useState<BidTarget[] | null>(null),
    [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [manualTime, setManualTime] = useState(() =>
    formatInTimeZone(new Date(), "America/Chicago", "yyyy-MM-dd'T'HH:mm"),
  );
  const [manualReason, setManualReason] = useState("");
  const [manualRequestId, setManualRequestId] = useState<string | null>(null);
  const [ownCleanup, setOwnCleanup] = useState(false);
  const { operations, finished, pollError, serverNow, begin, remember } =
    usePurgeOperations(manager || ownCleanup);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      await action();
    } catch (reason) {
      const message =
        reason instanceof Error ? reason.message : "Please retry.";
      setError(message);
      toast.error(message);
    } finally {
      setBusy(false);
      onBusy(false);
    }
  }
  return (
    <>
      <div
        className="flex min-h-14 flex-wrap items-center gap-2 border-y bg-muted/20 px-5 py-2"
        aria-label="Bulk application actions"
      >
        <span
          className="inline-flex size-5 shrink-0 items-center justify-center"
          role="status"
          aria-label={loading ? "Refreshing bids" : "Bids up to date"}
        >
          <LoaderCircle
            size={14}
            aria-hidden="true"
            className={loading ? "animate-spin" : "invisible"}
          />
        </span>
        <span className="min-w-20 text-xs tabular-nums">
          {targets.length} selected
        </span>
        <Button
          size="sm"
          variant="ghost"
          disabled={!targets.length || disabled || busy}
          onClick={clear}
        >
          Clear selection
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!targets.length || disabled || busy || loading}
          onClick={() => {
            setDeleting(targets.map((t) => ({ ...t })));
            setConfirmation("");
            setError("");
          }}
        >
          Delete selected permanently
        </Button>
        {manager && (
          <>
            <Button
              size="sm"
              variant="outline"
              disabled={!targets.length || disabled || busy || loading}
              onClick={() => {
                setError("");
                setManualOpen(true);
              }}
            >
              Mark selected as applied
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!targets.length || disabled || busy || loading}
              onClick={() =>
                void run(async () => {
                  const result = await reviewBidsAction(
                    targets,
                    "approved",
                    "",
                  );
                  if (result.error) throw new Error(result.error);
                  toast.success(
                    `${result.data ?? targets.length} applications approved`,
                  );
                  onDone();
                })
              }
            >
              Approve selected
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!targets.length || disabled || busy || loading}
              onClick={() => {
                const reason = window.prompt(
                  "Reason for rejecting the selected applications (required)",
                );
                if (!reason?.trim()) return;
                void run(async () => {
                  const result = await reviewBidsAction(
                    targets,
                    "rejected",
                    reason,
                  );
                  if (result.error) throw new Error(result.error);
                  toast.success(
                    `${result.data ?? targets.length} applications returned for correction`,
                  );
                  onDone();
                });
              }}
            >
              Reject selected
            </Button>
          </>
        )}
      </div>
      {pollError && (
        <p role="alert" className="border-b px-5 py-2 text-xs text-destructive">
          File cleanup status could not be refreshed. Retrying…
        </p>
      )}
      {operations.map((op) => (
        <div
          key={op.id}
          role="status"
          className="flex flex-wrap items-center gap-2 border-b px-5 py-2 text-xs"
        >
          <span>
            {op.deletedCount} applications deleted.{" "}
            {purgeMessage(op, serverNow)}.
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || disabled || !canRetryPurge(op, serverNow)}
            onClick={() =>
              void run(async () => {
                const token = begin();
                const result = await retryPurgeCleanup(op.id);
                if (result.error || !result.data) throw new Error(result.error);
                remember(result.data.status, token);
              })
            }
          >
            Retry cleanup
          </Button>
        </div>
      ))}
      {finished.map((op) => (
        <p key={op.id} role="status" className="border-b px-5 py-2 text-xs">
          {op.deletedCount} applications deleted. Cleanup complete.
        </p>
      ))}
      <Dialog
        open={manualOpen}
        onOpenChange={(open) => {
          if (!busy) setManualOpen(open);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark selected bids as applied?</DialogTitle>
            <DialogDescription>
              This records applications without screenshots, approves the
              selected bids, and includes them in earnings at their configured
              rates.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <p className="rounded-md bg-muted p-3 text-sm">
              {targets.length - targets.filter((t) => t.applied).length} will be
              marked applied; {targets.filter((t) => t.applied).length} already
              applied will remain unchanged.
            </p>
            <Field
              label="Applied date and time (CT)"
              type="datetime-local"
              value={manualTime}
              onChange={(event) => {
                setManualTime(event.target.value);
                setManualRequestId(null);
              }}
            />
            <label className="block space-y-1 text-xs font-medium">
              Reason (required)
              <Textarea
                value={manualReason}
                maxLength={1000}
                onChange={(event) => {
                  setManualReason(event.target.value);
                  setManualRequestId(null);
                }}
                placeholder="Add context for the application record"
              />
            </label>
            <p className="text-xs text-muted-foreground">
              The chosen time affects activity reports and the profile’s
              retention period.
            </p>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setManualOpen(false)}
            >
              Cancel
            </Button>
            <Button
              disabled={
                busy || !manualTime || !manualReason.trim() || !targets.length
              }
              onClick={() =>
                void run(async () => {
                  const requestId = manualRequestId ?? crypto.randomUUID();
                  setManualRequestId(requestId);
                  const result = await manualApplyBidsAction({
                    targets,
                    localTime: manualTime,
                    reason: manualReason,
                    requestId,
                  });
                  if (result.error || !result.data)
                    throw new Error(
                      result.error ??
                        "Application update could not be confirmed.",
                    );
                  toast.success(
                    `${result.data.applied} applications marked applied; ${result.data.unchanged} unchanged`,
                  );
                  setManualOpen(false);
                  setManualRequestId(null);
                  onDone();
                })
              }
            >
              {busy ? "Applying…" : "Confirm application"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!deleting}
        onOpenChange={(open) => {
          if (!busy && !open) setDeleting(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Permanently delete {deleting?.length} bids?
            </DialogTitle>
            <DialogDescription>
              These application records, activity history and screenshots will
              be deleted. This cannot be undone. File removal will retry
              automatically if Storage is unavailable.
            </DialogDescription>
          </DialogHeader>
          <Field
            label="Type DELETE to confirm"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            disabled={busy}
            autoComplete="off"
          />
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => setDeleting(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={confirmation !== "DELETE" || busy}
              onClick={() =>
                void run(async () => {
                  if (!deleting) return;
                  const token = begin();
                  const result = await deleteBids(deleting);
                  if (result.error || !result.data)
                    throw new Error(
                      result.error ??
                        "Deletion could not be confirmed. Refresh to check before retrying.",
                    );
                  remember(result.data.status, token);
                  if (result.data.status.pendingFiles) setOwnCleanup(true);
                  toast.success(
                    `${result.data.deletedCount} bids deleted. ${result.data.status.pendingFiles ? "File cleanup pending; retry is automatic." : "File cleanup complete."}`,
                  );
                  setDeleting(null);
                  onDone();
                })
              }
            >
              {busy ? "Deleting…" : "Permanently delete"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
