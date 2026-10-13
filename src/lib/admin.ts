import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./database.types";
type RequestBudget = { deadlineAt: number; signal?: AbortSignal };
export function adminClient(bounded: boolean | RequestBudget = false) {
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!key)
    throw new Error(
      "Server setup is incomplete: add SUPABASE_SECRET_KEY to enable account creation and verified uploads.",
    );
  return createClient<Database>(process.env.NEXT_PUBLIC_SUPABASE_URL!, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    ...(bounded
      ? {
          global: {
            fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
              const remaining =
                typeof bounded === "boolean"
                  ? 15000
                  : Math.min(15000, bounded.deadlineAt - Date.now());
              if (remaining <= 0) throw new Error("Worker budget expired");
              const timeout = new AbortController();
              const timer = setTimeout(
                () => timeout.abort(new Error("Worker request budget expired")),
                remaining,
              );
              // fetch resolves at headers. Keep cancellation active through body
              // consumption; an unref timer cannot hold the worker open.
              timer.unref?.();
              const callerSignal =
                init?.signal ??
                (input instanceof Request ? input.signal : undefined);
              const signals = [
                timeout.signal,
                callerSignal,
                typeof bounded === "boolean" ? undefined : bounded.signal,
              ].filter((signal): signal is AbortSignal => !!signal);
              try {
                return await fetch(input, {
                  ...init,
                  signal: AbortSignal.any(signals),
                });
              } catch (error) {
                clearTimeout(timer);
                throw error;
              }
            },
          },
        }
      : {}),
  });
}
