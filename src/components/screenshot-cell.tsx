"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { BidRow } from "@/lib/workspace-types";
import { getFileUrl } from "@/app/(workspace)/actions";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/dialog";
import { FileUpload, uploadVerifiedFile } from "./file-upload";
import { pastedImage } from "@/lib/clipboard-image";
import { LoaderCircle } from "lucide-react";
import { ScreenshotSizeBadge } from "./screenshot-size-badge";

export function ScreenshotCell({
  bid,
  disabled,
  onBusy,
  role,
  onUploaded,
}: {
  bid: BidRow;
  disabled?: boolean;
  onBusy?: (value: boolean) => void;
  role: string;
  onUploaded?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [uploadOpen, setUploadOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const [retry, setRetry] = useState(0);
  const [pasteProgress, setPasteProgress] = useState("");
  const [pasteError, setPasteError] = useState("");
  const [pasteBusy, setPasteBusy] = useState(false);
  const router = useRouter();
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) =>
      setVisible(entry.isIntersecting),
    );
    if (ref.current) observer.observe(ref.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || !bid.evidence_file_id) return;
    let cancelled = false;
    async function load() {
      const result = await getFileUrl(bid.evidence_file_id!);
      if (cancelled) return;
      if (result.data) {
        setUrl(result.data.url);
        setError("");
      } else {
        setUrl("");
        setError(result.error ?? "Preview unavailable");
      }
    }
    void load();
    const timer = setInterval(() => void load(), 45000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [visible, bid.evidence_file_id, retry]);
  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      const target = ref.current;
      const clipboard = event.clipboardData;
      if (!target || !clipboard || !target.contains(document.activeElement)) return;
      const includesImage = Array.from(clipboard.items).some((item) => item.kind === "file" && item.type.startsWith("image/")) || Array.from(clipboard.files).some((file) => file.type.startsWith("image/"));
      if (!includesImage) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (disabled || pasteBusy || bid.deleted_at || bid.review_status !== "approved") {
        setPasteError(bid.deleted_at ? "Restore this bid before uploading evidence." : bid.review_status !== "approved" ? "Client approval is required before screenshot upload." : "Screenshot upload is busy. Try again when it finishes.");
        return;
      }
      const image = pastedImage(clipboard.items, clipboard.files);
      if (!image) {
        setPasteError("Clipboard image type is unsupported. Use PNG, JPEG, or WebP.");
        return;
      }
      setPasteBusy(true);
      onBusy?.(true);
      setPasteError("");
      void uploadVerifiedFile("screenshot", bid.id, image, (phase, progress) => {
        setPasteProgress(`${phase} ${progress}%`);
      }).then(() => {
        onUploaded?.();
        router.refresh();
      }).catch((reason: unknown) => {
        setPasteError(reason instanceof Error ? reason.message : "Screenshot upload failed. Paste the image again to retry.");
      }).finally(() => {
        setPasteBusy(false);
        setPasteProgress("");
        onBusy?.(false);
      });
    };
    window.addEventListener("paste", handlePaste, true);
    return () => window.removeEventListener("paste", handlePaste, true);
  }, [bid.id, bid.deleted_at, bid.review_status, disabled, pasteBusy, router, onBusy, onUploaded]);
  return (
    <div
      ref={ref}
      tabIndex={0}
      data-grid-interactive
      aria-label={`Screenshot paste target for ${bid.company}. Focus and press Ctrl+V or Command+V.`}
      className="w-40 space-y-1 whitespace-normal rounded-sm focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2"
    >
      {pasteBusy && <span className="inline-flex items-center gap-1 text-[10px] text-primary" role="status"><LoaderCircle size={12} className="animate-spin" />{pasteProgress || "Uploading screenshot"}</span>}
      {pasteError && <p className="text-[10px] leading-4 text-destructive" role="alert">{pasteError}</p>}
      {!uploadOpen && !bid.deleted_at && bid.review_status === "approved" && <p className="text-[9px] leading-3 text-muted-foreground">Focus this cell and paste an image</p>}
      <div className="flex items-center gap-1.5">
      {url && (
        <button
          className="block min-w-0 flex-1 overflow-hidden rounded-md border focus-visible:outline-2 focus-visible:outline-primary"
          onClick={() => setOpen(true)}
          aria-label={`Preview screenshot for ${bid.company}`}
        >
          {/* Private, expiring URLs must bypass the public Next image optimization cache. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt={`Application proof for ${bid.company}`}
            className="h-9 w-full object-cover"
            loading="lazy"
            onError={() => setError("Preview expired. Retry to refresh.")}
          />
        </button>
      )}
      <ScreenshotSizeBadge bid={bid} role={role} />
      </div>
      {error && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setRetry((n) => n + 1)}
        >
          Retry preview
        </Button>
      )}
      {!bid.deleted_at && bid.review_status !== "approved" && (
        <p className="text-[10px] leading-4 text-muted-foreground">
          {bid.review_status === "pending" ? "Waiting for client review before proof upload." : "Correct this bid and resubmit it for review."}
        </p>
      )}
      {!bid.deleted_at && !uploadOpen && (
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={() => setUploadOpen(true)}
        >
          {bid.applied
            ? "Replace screenshot"
            : bid.evidence_file_id
              ? "Upload new proof"
              : "Upload screenshot"}
        </Button>
      )}
      {!bid.deleted_at && uploadOpen && (
        <FileUpload
          disabled={disabled}
          onBusy={onBusy}
          compact
          kind="screenshot"
          target={bid.id}
          label={
            bid.applied
              ? "Replace screenshot"
              : bid.evidence_file_id
                ? "Upload new proof"
                : "Upload screenshot"
          }
          onUploaded={() => {
            setUploadOpen(false);
            onUploaded?.();
            router.refresh();
          }}
        />
      )}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>{bid.company} application proof</DialogTitle>
            <DialogDescription>
              {bid.applied
                ? "Current application screenshot"
                : "Historical proof; upload new proof to apply again"}
            </DialogDescription>
          </DialogHeader>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt={`Enlarged application proof for ${bid.company}`}
            className="max-h-[75vh] w-full object-contain"
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
