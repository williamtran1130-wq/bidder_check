/** Bounds awaited work even when a provider ignores cancellation. */
export async function withinDeadline<T>(
  send: () => PromiseLike<T>,
  deadlineAt: number,
  signal?: AbortSignal,
  maximum = 15000,
): Promise<T> {
  const remaining = Math.min(maximum, deadlineAt - Date.now());
  if (remaining <= 0) throw new Error("Worker budget expired");
  signal?.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let aborted: (() => void) | undefined;
  try {
    return await Promise.race([
      send(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Worker request budget expired")),
          remaining,
        );
        if (signal) {
          aborted = () => reject(signal.reason);
          signal.addEventListener("abort", aborted, { once: true });
          if (signal.aborted) aborted();
        }
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && aborted) signal.removeEventListener("abort", aborted);
  }
}
