import type {
  UploadContext,
  UploadContextOutcome,
} from "./upload-context-types";
type Result = { data?: UploadContext | null; error?: string };
type BatchResult = { data?: UploadContextOutcome[]; error?: string };
type Pending = {
  scope: string;
  id: string;
  generation: number;
  promise: Promise<Result>;
  resolve: (result: Result) => void;
};
const unavailable = () => ({
  error: "Upload details could not be loaded. Please retry.",
});
/** Coalesce mounted cells. Results are never cached after their request settles. */
export class UploadContextQueue {
  private pending = new Map<string, Pending>();
  private queued: Pending[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  constructor(private load: (ids: string[]) => Promise<BatchResult>) {}
  reset() {
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
    for (const item of this.pending.values()) item.resolve(unavailable());
    this.pending.clear();
    this.queued = [];
  }
  get(scope: string, id: string): Promise<Result> {
    const key = JSON.stringify([scope, id]);
    const existing = this.pending.get(key);
    if (existing) return existing.promise;
    let resolve!: Pending["resolve"];
    const promise = new Promise<Result>((r) => {
      resolve = r;
    });
    const item = { scope, id, generation: this.generation, promise, resolve };
    this.pending.set(key, item);
    this.queued.push(item);
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, 16);
    return promise;
  }
  private async flush() {
    const groups = new Map<string, Pending[]>();
    for (const item of this.queued.splice(0)) {
      const group = groups.get(item.scope) ?? [];
      group.push(item);
      groups.set(item.scope, group);
    }
    for (const group of groups.values()) {
      for (let start = 0; start < group.length; start += 100) {
        const batch = group
          .slice(start, start + 100)
          .filter((item) => item.generation === this.generation);
        if (!batch.length) continue;
        let result: BatchResult;
        try {
          result = await this.load(batch.map((item) => item.id));
        } catch {
          result = unavailable();
        }
        for (const item of batch) {
          const key = JSON.stringify([item.scope, item.id]);
          item.resolve(
            item.generation === this.generation
              ? (result.data?.find((value) => value.id === item.id) ?? {
                  error: result.error ?? unavailable().error,
                })
              : unavailable(),
          );
          if (this.pending.get(key) === item) this.pending.delete(key);
        }
      }
    }
  }
}
