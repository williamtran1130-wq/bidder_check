"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { BidRow } from "@/lib/workspace-types";
import { invalidateThumbnail, useReadScope } from "@/lib/read-scope";
import { useScreenshotPreview } from "./use-screenshot-preview";
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
import { SCREENSHOT_RETENTION_MS, screenshotStatus } from "@/lib/screenshot-retention";
import { ScreenshotSizeBadge } from "./screenshot-size-badge";
import { UploadDetails } from "./upload-details";

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
  const previewTrigger = useRef<HTMLButtonElement>(null);
  const [now, setNow] = useState(() => Date.now());
  const [uploadOpen, setUploadOpen] = useState(false);
  const [openFile, setOpenFile] = useState("");
  const [pasteProgress, setPasteProgress] = useState("");
  const [pasteError, setPasteError] = useState("");
  const [pasteBusy, setPasteBusy] = useState(false);
  const router = useRouter();
  const scope = useReadScope();
  const fileKey = JSON.stringify([scope, bid.evidence_file_id]);
  const open = openFile === fileKey;
  const status = screenshotStatus(bid, now);
  const manager = role === "client" || role === "admin";
  useEffect(() => {
    const expiry = Date.parse(bid.screenshot_uploaded_at ?? "") + SCREENSHOT_RETENTION_MS;
    if (!Number.isFinite(expiry) || expiry <= Date.now()) return;
    const timer = setTimeout(() => setNow(Date.now()), expiry - Date.now());
    return () => clearTimeout(timer);
  }, [bid.screenshot_uploaded_at]);
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
        if (bid.evidence_file_id) invalidateThumbnail(scope, bid.evidence_file_id);
        setOpenFile("");
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
  }, [bid.id, bid.evidence_file_id, bid.deleted_at, bid.review_status, scope, disabled, pasteBusy, router, onBusy, onUploaded]);
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
      <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs" role="status">{status === "expired" ? "Uploaded — expired" : status === "uploaded" ? "Uploaded" : "Not uploaded"}</span>
      {manager && status === "uploaded" && <Button ref={previewTrigger} variant="ghost" size="sm" onClick={() => setOpenFile(fileKey)} aria-label={`Open screenshot for ${bid.company}`}>Open screenshot</Button>}
      <ScreenshotSizeBadge bid={bid} role={role} />
      </div>
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
            if (bid.evidence_file_id) invalidateThumbnail(scope, bid.evidence_file_id);
            setOpenFile("");
            onUploaded?.();
            router.refresh();
          }}
        />
      )}
      <Dialog open={manager && open && status === "uploaded"} onOpenChange={(next) => setOpenFile(next ? fileKey : "")}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-4xl" onCloseAutoFocus={(event) => { event.preventDefault(); previewTrigger.current?.focus({ preventScroll: true }); }}>
          <DialogHeader>
            <DialogTitle>{bid.company} application proof</DialogTitle>
            <DialogDescription>
              {bid.applied
                ? "Current application screenshot"
                : "Current uploaded screenshot"}
            </DialogDescription>
          </DialogHeader>
          {manager && open && status === "uploaded" && bid.evidence_file_id && <EnlargedScreenshot key={fileKey} scope={scope} fileId={bid.evidence_file_id} company={bid.company} />}
          {open && (role === "client" || role === "admin") && bid.evidence_file_id && <UploadDetails key={bid.evidence_file_id} fileId={bid.evidence_file_id} role={role} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EnlargedScreenshot({ scope, fileId, company }: { scope: string; fileId: string; company: string }) {
  // Mounted on open: the table's already-loaded source may have expired.
  const preview = useScreenshotPreview(scope, fileId, true);
  return <>
    {preview.url && <img // eslint-disable-line @next/next/no-img-element
      src={preview.url}
      alt={`Enlarged application proof for ${company}`}
      className="max-h-[50dvh] w-full object-contain"
      style={{ visibility: preview.authorized ? undefined : "hidden" }}
      onError={preview.fail}
    />}
    {preview.error && <Button variant="ghost" size="sm" onClick={preview.retry}>Retry enlarged preview</Button>}
  </>;
}
