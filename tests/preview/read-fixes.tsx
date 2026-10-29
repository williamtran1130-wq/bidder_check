import React, { useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { useNotificationResource } from "@/lib/use-notifications";
import { refreshNotificationScope } from "@/lib/notification-store";
import { ReadScope } from "@/lib/read-scope";
import { ScreenshotCell } from "./screenshot-preview-probe";
import { fixture } from "./sample-data";
import type { NotificationResult } from "@/lib/notification-types";
function Notices({
  seed,
  load,
}: {
  seed: number;
  load: () => Promise<NotificationResult<number>>;
}) {
  const result = useNotificationResource("fix-notices:page", load, {
    data: seed,
  });
  return (
    <p data-testid="notices">
      {result.data ?? "empty"} {result.error ?? ""}
    </p>
  );
}
function Harness() {
  const [shown, setShown] = useState(true),
    [seed, setSeed] = useState(1),
    [loads, setLoads] = useState(0),
    [thumbnails, setThumbnails] = useState(true),
    [file, setFile] = useState("same-file"),
    [scope, setScope] = useState("thumbnail-fixture");
  const pending = useRef<((result: NotificationResult<number>) => void)[]>([]);
  const load = useCallback(() => {
    setLoads((n) => n + 1);
    return new Promise<NotificationResult<number>>((resolve) =>
      pending.current.push(resolve),
    );
  }, []);
  return (
    <>
      <section>
        {shown && <Notices seed={seed} load={load} />}
        <p data-testid="notice-loads">{loads}</p>
        <button onClick={() => setShown(false)}>Leave notices</button>
        <button
          onClick={() => {
            setSeed(2);
            setShown(true);
          }}
        >
          Return notices
        </button>
        <button
          onClick={() => {
            setSeed(0);
            setShown(true);
          }}
        >
          Return older seed
        </button>
        <button onClick={() => void refreshNotificationScope("fix-notices:")}>
          Mutate notices
        </button>
        <button onClick={() => pending.current.shift()?.({ data: 2 })}>
          Resolve old notice
        </button>
        <button onClick={() => pending.current.pop()?.({ data: 3 })}>
          Resolve new notice
        </button>
      </section>
      <button onClick={() => setThumbnails(false)}>Hide thumbnails</button>
      <button onClick={() => setThumbnails(true)}>Show thumbnails</button>
      <button
        onClick={() => {
          document.documentElement.dataset.thumbnailError = "true";
        }}
      >
        Fail thumbnail reads
      </button>
      <button onClick={() => setFile("other-file")}>
        Change thumbnail file
      </button>
      <button onClick={() => setScope("thumbnail-next")}>
        Change thumbnail scope
      </button>
      <ReadScope scope={scope}>
        {thumbnails && (
          <div>
            <ScreenshotCell
              role="client"
              bid={{
                ...fixture.bids[0],
                company: "First",
                evidence_file_id: file,
              }}
            />
            <ScreenshotCell
              role="client"
              bid={{
                ...fixture.bids[0],
                company: "Second",
                evidence_file_id: file,
              }}
            />
          </div>
        )}
      </ReadScope>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Harness />
  </React.StrictMode>,
);
