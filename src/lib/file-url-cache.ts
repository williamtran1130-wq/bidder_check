import type { FileUrlData, FileUrlOutcome } from "./read-types";
type BatchResult = { data?: FileUrlOutcome[]; error?: string };
type FileResult = { data?: FileUrlData; error?: string };
type Pending = {
  scope: string;
  id: string;
  generation: number;
  version: number;
  resolve: (value: FileResult) => void;
  promise: Promise<FileResult>;
};
/** Browser-only owner creates this queue; scope is mandatory for cache reuse. */
export class FileUrlQueue {
  private cache = new Map<string, FileUrlData>();
  private pending = new Map<string, Pending>();
  private queued: Pending[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private versions = new Map<string, number>();
  constructor(private load: (ids: string[]) => Promise<BatchResult>) {}
  private key(scope: string, id: string) {
    return JSON.stringify([scope, id]);
  }
  invalidate(scope: string, id: string) {
    const key = this.key(scope, id);
    this.cache.delete(key);
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
    this.pending.delete(key);
  }
  reset() {
    this.generation++;
    this.cache.clear();
    this.versions.clear();
    this.pending.clear();
  }
  get(scope: string, id: string): Promise<FileResult> {
    const key = this.key(scope, id),
      cached = this.cache.get(key);
    if (scope && cached && Date.parse(cached.expiresAt) > Date.now() + 15_000)
      return Promise.resolve({ data: cached });
    const old = this.pending.get(key);
    if (old) return old.promise;
    let resolve!: (value: FileResult) => void;
    const promise = new Promise<FileResult>((r) => (resolve = r));
    const item = {
      scope,
      id,
      generation: this.generation,
      version: this.versions.get(key) ?? 0,
      resolve,
      promise,
    };
    this.pending.set(key, item);
    this.queued.push(item);
    if (!this.timer)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, 16);
    return promise;
  }
  private async flush() {
    const queued = this.queued.splice(0);
    // Each batch contains one scope, at most100 IDs, and only requested assets.
    const groups = new Map<string, Pending[]>();
    for (const item of queued) {
      const group = groups.get(item.scope) ?? [];
      group.push(item);
      groups.set(item.scope, group);
    }
    await Promise.all(
      [...groups.values()].flatMap((group) => {
        const batches: Pending[][] = [];
        for (let start = 0; start < group.length; start += 100)
          batches.push(group.slice(start, start + 100));
        return batches.map(async (batch) => {
          let result: BatchResult;
          try {
            result = await this.load(batch.map((item) => item.id));
          } catch {
            result = { error: "Preview unavailable. Please retry." };
          }
          for (const item of batch) {
            const key = this.key(item.scope, item.id);
            const current =
              item.generation === this.generation &&
              item.version === (this.versions.get(key) ?? 0);
            const outcome: FileResult = current
              ? (result.data?.find((file) => file.id === item.id) ?? {
                  error: result.error ?? "File is unavailable.",
                })
              : { error: "Preview changed. Please retry." };
            if (current && outcome.data && item.scope)
              this.cache.set(key, outcome.data);
            if (this.pending.get(key) === item) this.pending.delete(key);
            item.resolve(outcome);
          }
        });
      }),
    );
  }
}
