import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ReadScope } from "@/lib/read-scope";
import { ScreenshotCell } from "./screenshot-preview-probe";
import { fixture } from "./sample-data";
function Harness() {
  const [thumbnails, setThumbnails] = useState(true),
    [file, setFile] = useState("same-file"),
    [scope, setScope] = useState("thumbnail-fixture");
  return (
    <>
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
