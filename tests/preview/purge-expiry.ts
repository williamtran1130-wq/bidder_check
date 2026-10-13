import type { BidTarget, PurgeResult, PurgeSnapshot } from "@/lib/bulk-types";
import { fixture } from "./sample-data";

// Query-gated local boundary simulation. No network, production data or Storage.
const snapshots = new Map<
  string,
  { snapshot: PurgeSnapshot; targets: BidTarget[]; result?: PurgeResult }
>();
function observe(phase: string, snapshot: PurgeSnapshot) {
  window.dispatchEvent(
    new CustomEvent("fixture-purge-expiry", {
      detail: {
        phase,
        id: snapshot.id,
        expiresAt: snapshot.expiresAt,
        count: snapshot.count,
        at: Date.now(),
      },
    }),
  );
}
export async function prepare(mode: string, selected: BidTarget[]) {
  const targets =
    mode === "all"
      ? fixture.bids
          .filter((bid) => bid.deleted_at)
          .map(({ id, version }) => ({ id, version }))
      : selected.map(({ id, version }) => ({ id, version }));
  const snapshot: PurgeSnapshot = {
    id: crypto.randomUUID(),
    count: targets.length,
    scope: "Selected trashed bids",
    expiresAt: new Date(Date.now() + 600000).toISOString(),
  };
  snapshots.set(snapshot.id, { snapshot, targets });
  observe("prepared", snapshot);
  return { data: snapshot };
}
export async function confirm(
  id: string,
  confirmation: string,
): Promise<{ data?: PurgeResult; error?: string }> {
  const operation = snapshots.get(id);
  if (!operation) return { error: "Access denied" };
  const { snapshot, targets } = operation;
  observe("confirm", snapshot);
  if (confirmation !== "DELETE") return { error: "Type DELETE to confirm." };
  if (operation.result) return { data: operation.result };
  if (Date.parse(snapshot.expiresAt) <= Date.now()) {
    observe("expired", snapshot);
    return { error: "Confirmation expired. Prepare a new confirmation" };
  }
  if (
    targets.some(
      (target) =>
        !fixture.bids.some(
          (bid) =>
            bid.id === target.id &&
            bid.version === target.version &&
            bid.deleted_at,
        ),
    )
  )
    return { error: "Trash changed. Prepare a new confirmation" };
  const ids = new Set(targets.map(({ id }) => id));
  fixture.bids = fixture.bids.filter((bid) => !ids.has(bid.id));
  operation.result = {
    status: {
      id,
      scope: snapshot.scope,
      deletedCount: targets.length,
      pendingFiles: 0,
      awaitingRemovalFiles: 0,
      verifyingFiles: 0,
      processingFiles: 0,
      failedFiles: 0,
      nextAttemptAt: null,
      serverTime: new Date().toISOString(),
    },
    outcome: "processed",
  };
  observe("deleted", snapshot);
  return { data: operation.result };
}
