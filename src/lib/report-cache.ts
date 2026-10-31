import type { ReportResult } from "./report-types";

export const REPORT_FRESH_MS = 270_000;
type Entry = { value: ReportResult<unknown>; at: number };
/** Browser-owned values; never prime during server rendering. */
export class ReportCache {
  private values = new Map<string, Entry>();
  private pending = new Map<string, Promise<ReportResult<unknown>>>();
  private generation = 0;
  constructor(private now = () => Date.now(), private maximum = 50) {}
  peek<T>(key: string): ReportResult<T> | undefined {
    const entry = this.values.get(key);
    if (!entry || this.now() - entry.at >= REPORT_FRESH_MS) return;
    this.values.delete(key); this.values.set(key, entry);
    return entry.value as ReportResult<T>;
  }
  seed<T>(key: string, value: ReportResult<T>, receivedAt = this.now()) {
    if (value.data === undefined || value.error) return;
    if ((this.values.get(key)?.at ?? -Infinity) > receivedAt) return;
    this.values.delete(key); this.values.set(key, { value, at: receivedAt });
    while (this.values.size > this.maximum) this.values.delete(this.values.keys().next().value!);
  }
  clear() { this.generation++; this.values.clear(); this.pending.clear(); }
  invalidate(key: string) { this.values.delete(key); }
  remaining(key: string) { return Math.max(0, REPORT_FRESH_MS - (this.now() - (this.values.get(key)?.at ?? -Infinity))); }
  timestamp(key: string) { return this.values.get(key)?.at; }
  load<T>(key: string, run: () => Promise<ReportResult<T>>, force = false): Promise<ReportResult<T>> {
    if (!force) { const cached = this.peek<T>(key); if (cached) return Promise.resolve(cached); }
    const pending = this.pending.get(key);
    if (pending && !force) return pending as Promise<ReportResult<T>>;
    const generation = this.generation;
    const request = Promise.resolve().then(run).then(value => {
      if (generation === this.generation && this.pending.get(key) === request) this.seed(key, value);
      return value;
    }).finally(() => { if (this.pending.get(key) === request) this.pending.delete(key); });
    this.pending.set(key, request);
    return request;
  }
}
export const browserReports = new ReportCache();
export function invalidateReports() {
  browserReports.clear();
  if (typeof window !== "undefined") window.dispatchEvent(new Event("workspace-data-changed"));
}
export function refreshWorkspace(router: { refresh(): void }) {
  invalidateReports();
  router.refresh();
}
