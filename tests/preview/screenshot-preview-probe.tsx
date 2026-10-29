/* eslint-disable @next/next/no-img-element -- isolated private URL hook fixture */
// Test the reusable authorization-renewal hook independently of the status-only table UI.
import { useReadScope } from "@/lib/read-scope";
import { useScreenshotPreview } from "@/components/use-screenshot-preview";
import type { BidRow } from "@/lib/workspace-types";
export function ScreenshotCell({ bid }: { bid: BidRow; role: string }) {
  const scope = useReadScope();
  const preview = useScreenshotPreview(scope, bid.evidence_file_id, true);
  return (
    <>
      {preview.url && (
        <button
          aria-label={`Preview screenshot for ${bid.company}`}
          style={{ visibility: preview.authorized ? undefined : "hidden" }}
        >
          <img src={preview.url} alt={bid.company} onError={preview.fail} />
        </button>
      )}
      {preview.error && <button onClick={preview.retry}>Retry preview</button>}
    </>
  );
}
