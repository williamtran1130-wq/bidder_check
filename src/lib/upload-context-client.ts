"use client";
import { getScreenshotUploadContexts } from "@/lib/read-client";
import { UploadContextQueue } from "./upload-context-queue";

let queue: UploadContextQueue | undefined;
export function screenshotUploadContext(scope: string, fileId: string) {
  queue ??= new UploadContextQueue(getScreenshotUploadContexts);
  return queue.get(scope, fileId);
}
export function resetUploadContexts() {
  queue?.reset();
}
