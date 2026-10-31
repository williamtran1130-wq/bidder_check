import type { CollectionStatus } from "./report-bundle";
export type AcquiredCollection = { value: CollectionStatus; receivedAt: number };
/** Collection timestamps can move backwards after mailbox removal. */
export function latestCollection(fetched: AcquiredCollection | undefined, published: AcquiredCollection | undefined) {
  return published && (!fetched || published.receivedAt > fetched.receivedAt) ? published.value : fetched?.value;
}
