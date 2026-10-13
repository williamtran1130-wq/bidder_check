// Local-only compatibility check: imports pure case construction, never the staging entry point.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildBenchmarkMatrix,
  P95_LIMIT_MS,
} from "./screenshot-size-benchmark-helpers.mjs";

export function currentBenchmarkManifest() {
  const actors = {
    owner: { id: "owner", role: "client" },
    admin: { id: "admin", role: "admin" },
    bidder1: { id: "bidder1", role: "bidder" },
    bidder2: { id: "bidder2", role: "bidder" },
  };
  const cases = buildBenchmarkMatrix({
    actors,
    ranges: [{ name: "all" }, { name: "recent" }],
    marker: "fixture",
  });
  return {
    version: 1,
    matrixKind: "full",
    fixtureBids: 25000,
    samplesPerCase: 25,
    concurrency: 5,
    p95LimitMs: P95_LIMIT_MS,
    cases: cases.map(
      (
        [
          actor,
          range,
          sort,
          scope,
          search,
          checkFeature,
          label = "main",
          mode = {},
        ],
        index,
      ) => ({
        caseNumber: index + 1,
        role: actor.role,
        range: range.name,
        scope: label,
        scopeBidder: scope ?? null,
        search: search === "fixture" ? "marker" : "main-prefix",
        sort: sort.id,
        descending: sort.desc,
        checkFeature,
        screenshotFilter: mode.repeated ? "Repeated sizes only" : "",
        status: mode.status ?? "all",
        arrangement: mode.arrangement ?? null,
      }),
    ),
  };
}

const args = process.argv.slice(2);
try {
  assert.ok(
    !args.length || (args.length === 2 && args[0] === "--manifest"),
    "Usage: node scripts/check-benchmark-manifest.mjs [--manifest path]",
  );
  const checked = JSON.parse(
    readFileSync(
      args[1] ??
        new URL("./screenshot-size-benchmark-manifest.json", import.meta.url),
      "utf8",
    ),
  );
  const current = currentBenchmarkManifest();
  assert.deepEqual(
    checked,
    current,
    "Benchmark manifest differs from the executable matrix",
  );
  assert.equal(
    current.cases.length,
    57,
    "Complete list acceptance requires all 57 cases",
  );
  console.log(
    JSON.stringify({
      cases: current.cases.length,
      requests: current.cases.length * current.samplesPerCase,
      concurrency: current.concurrency,
      p95LimitMs: current.p95LimitMs,
    }),
  );
} catch (error) {
  console.error(`Benchmark manifest check failed: ${error.message}`);
  process.exitCode = 1;
}
