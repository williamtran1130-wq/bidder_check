import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ScreenshotCell } from "@/components/screenshot-cell";
import { usePurgeOperations } from "@/components/use-purge-operations";
import { ReadScope } from "@/lib/read-scope";
import { fixture } from "./sample-data";
import { useNotificationResource } from "@/lib/use-notifications";

async function unread() {
  document.documentElement.dataset.egressUnread = String(Number(document.documentElement.dataset.egressUnread ?? 0) + 1);
  return { data: 1 };
}

function Harness() {
  const [scope, setScope] = useState("egress-actor-a");
  const [version, setVersion] = useState(0);
  const [mounted, setMounted] = useState(true);
  const [offscreen, setOffscreen] = useState(false);
  const purges = usePurgeOperations(true);
  useNotificationResource("egress:unread", unread, { data: 0 });
  const count = Number(new URLSearchParams(location.search).get("count") ?? 2);
  return <>
    <button onClick={() => setScope("egress-actor-b")}>Change actor</button>
    <button onClick={() => setVersion((n) => n + 1)}>Replace evidence</button>
    <button onClick={() => setMounted(false)}>Unmount evidence</button>
    <button onClick={() => setOffscreen((value) => !value)}>Toggle offscreen</button>
    <p data-testid="purge-error">{String(purges.pollError)}</p>
    <p data-testid="purge-active">{purges.operations.length}</p>
    <p data-testid="purge-finished">{purges.finished.length}</p>
    <div style={{ marginTop: offscreen ? 10000 : 0, display: "grid", gridTemplateColumns: "repeat(5, 180px)" }}>
      <ReadScope scope={scope}>{mounted && Array.from({ length: count }, (_, i) =>
        <ScreenshotCell key={i} role={new URLSearchParams(location.search).get("role") ?? "bidder"} bid={{ ...fixture.bids[0], company: `Evidence ${i + 1}`, evidence_file_id: `egress-${version}-${i}` }} />
      )}</ReadScope>
    </div>
  </>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><Harness /></React.StrictMode>);
