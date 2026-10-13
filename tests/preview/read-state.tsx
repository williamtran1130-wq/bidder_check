import React, { useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ReadScope } from "@/lib/read-scope";
import { useReport } from "@/components/use-report";
import type { ReportResult } from "@/lib/report-types";
function Harness() {
  const [key, setKey] = useState("A"),
    [count, setCount] = useState(0);
  const resolvers = useRef<((value: ReportResult<string>) => void)[]>([]);
  const timeout = useRef(false);
  const load = useCallback(async () => {
    setCount((n) => n + 1);
    if (timeout.current) {
      timeout.current = false;
      return {
        error: "Timeout. Please retry.",
        code: "temporarily_unavailable" as const,
      };
    }
    return new Promise<ReportResult<string>>((r) => resolvers.current.push(r));
  }, []);
  const report = useReport(key, load, { key: "A", result: { data: "seed" } });
  return (
    <>
      <p data-testid="report-data">{report.data ?? "empty"}</p>
      <p data-testid="request-count">{count}</p>
      {report.error && <p role="alert">{report.error}</p>}
      <button onClick={() => setKey("B")}>Query B</button>
      <button onClick={() => setKey("C")}>Query C</button>
      <button onClick={report.refresh}>Refresh mutation</button>
      <button onClick={() => resolvers.current.pop()?.({ data: "fresh" })}>
        Resolve newest
      </button>
      <button onClick={() => resolvers.current.shift()?.({ data: "stale" })}>
        Resolve oldest
      </button>
      <button
        onClick={() => {
          timeout.current = true;
          report.refresh();
        }}
      >
        Timeout
      </button>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <>
    <Harness />
    <ReadScope scope="actor-a">
      <p data-testid="private-scope">Private proof</p>
    </ReadScope>
    <button
      onClick={() =>
        window.dispatchEvent(new Event("workspace-access-revoked"))
      }
    >
      Revoke access
    </button>
  </>,
);
