"use client";
import { useEffect, useRef, useState } from "react";
import { UploadCloud, LoaderCircle, ImagePlus } from "lucide-react";
import { toast } from "sonner";
import { createClient } from "@/lib/client";
import { prepareUpload, finalizeUpload } from "@/app/(workspace)/actions";
import { validateUpload, uploadTypes } from "@/lib/domain";
import { pastedImage } from "@/lib/clipboard-image";
import { Button } from "./ui/button";
export async function uploadVerifiedFile(
  kind: "resume" | "screenshot",
  target: string,
  file: File,
  onProgress?: (phase: string, value: number) => void,
) {
  validateUpload(kind, file.type, file.size);
  onProgress?.("Preparing upload", 0);
  const prepared = await prepareUpload(kind, target, file.name, file.type, file.size);
  if (prepared.error || !prepared.data) throw new Error(prepared.error ?? "Could not prepare upload.");
  const supabase = createClient();
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) throw new Error("Please sign in again.");
  onProgress?.("Uploading", 0);
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/private-files/${prepared.data!.storage_path}`);
    xhr.setRequestHeader("Authorization", `Bearer ${session.access_token}`);
    xhr.setRequestHeader("apikey", process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!);
    xhr.setRequestHeader("Content-Type", file.type);
    xhr.timeout = 120000;
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        const progress = Math.round((event.loaded / event.total) * 100);
        onProgress?.("Uploading", progress);
      }
    };
    xhr.onload = () => xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error("Upload failed. Please choose the file again to retry."));
    xhr.onerror = () => reject(new Error("Connection lost. Please try again."));
    xhr.ontimeout = () => reject(new Error("Upload timed out. Please try again."));
    xhr.send(file);
  });
  onProgress?.("Verifying file", 100);
  const finalized = await finalizeUpload(prepared.data.id);
  if (finalized.error || !finalized.data) throw new Error(finalized.error ?? "Verification failed.");
  return finalized.data;
}
export function FileUpload({
  kind,
  target,
  onUploaded,
  compact = false,
  label,
  disabled = false,
  onBusy,
}: {
  kind: "resume" | "screenshot";
  target: string;
  onUploaded?: (id: string) => void;
  compact?: boolean;
  label?: string;
  disabled?: boolean;
  onBusy?: (value: boolean) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [phase, setPhase] = useState("");
  const [error, setError] = useState("");
  const retryFile = useRef<File | null>(null);
  const busy = useRef(false);
  useEffect(() => { surface.current?.focus({ preventScroll: true }); }, []);
  async function upload(file: File) {
    if (busy.current || disabled) return;
    busy.current = true;
    onBusy?.(true);
    retryFile.current = file;
    setError("");
    try {
      setProgress(0);
      const id = await uploadVerifiedFile(kind, target, file, (nextPhase, value) => { setPhase(nextPhase); setProgress(value); });
      toast.success(
        kind === "resume" ? "Resume file saved" : "Screenshot uploaded",
      );
      onUploaded?.(id);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Upload failed.";
      setError(message);
      toast.error(message);
    } finally {
      busy.current = false;
      onBusy?.(false);
      setProgress(null);
      if (input.current) input.current.value = "";
    }
  }
  return (
    <div
      ref={surface}
      tabIndex={0}
      aria-label={
        kind === "screenshot"
          ? "Upload or paste an application screenshot"
          : "Upload resume file"
      }
      className={`relative rounded-xl border border-dashed border-primary/30 bg-primary/[.025] text-center focus-visible:outline-2 focus-visible:outline-primary ${compact ? "w-52 whitespace-normal p-2" : "p-6"}`}
      data-grid-interactive
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files[0]) void upload(e.dataTransfer.files[0]);
      }}
      onPasteCapture={(e) => {
        if (kind !== "screenshot") return;
        const image = pastedImage(e.clipboardData.items, e.clipboardData.files);
        if (!image) {
          e.preventDefault();
          e.stopPropagation();
          setError("No supported image was found in the clipboard.");
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        void upload(image);
      }}
    >
      <input
        ref={input}
        type="file"
        className="sr-only"
        aria-label={
          kind === "resume" ? "Choose resume file" : "Choose screenshot"
        }
        accept={uploadTypes[kind].join(",")}
        disabled={disabled || progress !== null}
        onChange={(e) => {
          if (e.target.files?.[0]) void upload(e.target.files[0]);
        }}
      />
      {!compact &&
        (progress !== null ? (
          <LoaderCircle
            className="mx-auto mb-3 animate-spin text-primary"
            size={25}
          />
        ) : kind === "screenshot" ? (
          <ImagePlus className="mx-auto mb-3 text-primary" size={25} />
        ) : (
          <UploadCloud className="mx-auto mb-3 text-primary" size={25} />
        ))}
      <p className="text-sm font-medium">
        {progress !== null
          ? `${phase}… ${progress}%`
          : (label ??
            (kind === "screenshot"
              ? "Drop your screenshot here"
              : "Drop your resume here"))}
      </p>
      <p className="mb-4 mt-1 text-xs text-muted-foreground">
        {kind === "screenshot"
          ? "PNG, JPG or WebP · Paste with Ctrl+V"
          : "PDF document only"}{" "}
        · Up to 10 MB
      </p>
      {error && (
        <div role="alert" className="mb-2 text-xs text-destructive">
          {error}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => retryFile.current && void upload(retryFile.current)}
          >
            Retry upload
          </Button>
        </div>
      )}
      {progress !== null ? (
        <div
          role="progressbar"
          aria-valuenow={progress}
          aria-valuemin={0}
          aria-valuemax={100}
          className="h-1.5 rounded-full bg-secondary"
        >
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${progress}%` }}
          />
        </div>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => input.current?.click()}
        >
          Browse files
        </Button>
      )}
    </div>
  );
}
