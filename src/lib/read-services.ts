import "server-only";
import { getContext, type getActor } from "./auth";
import { AuthorizationError } from "./authorization-error";
import { z } from "zod";
import { unstable_rethrow } from "next/navigation";
import { actionErrorMessage } from "./action-errors";
import { chicagoDateRange } from "./domain";
import { isCalendarPeriod, resolveCalendarPeriod } from "./calendar-period";
import {
  BID_LIST_RPC,
  type BidListLoadResult,
  type BidListQuery,
  type BidListResult,
} from "./bid-list";
import { getManagerFinancialValues } from "./financial-data";
import type { Database } from "./database.types";
import type { PurgeStatus } from "./bulk-types";
import type { FileUrlOutcome } from "./read-types";
import type { UploadContext, UploadContextOutcome } from "./upload-context-types";
async function perform<T>(
  run: () => Promise<T>,
  _mutate = false,
): Promise<{ data?: T; error?: string }> {
  void _mutate;
  try {
    return { data: await run() };
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof AuthorizationError) throw error;
    return { error: actionErrorMessage(error) };
  }
}
/** Legacy/RSC calls redirect; the read handler supplies a typed-error context. */
export function createReadServices(
  getReadContext: typeof getActor = () => getContext({ actorOnly: true }),
) {
  async function rpc<N extends keyof Database["public"]["Functions"]>(
    name: N,
    args: Database["public"]["Functions"][N]["Args"],
  ) {
    const { supabase } = await getReadContext();
    const { data, error } = await supabase.rpc(name, args);
    if (error)
      throw Object.assign(new Error(error.message), { code: error.code });
    return data;
  }
  const purgeStatus = async (operation: string) =>
    (await rpc("bid_purge_status", { p_operation: operation })) as PurgeStatus;
  async function getInboxNotifications() {
    return perform(async () => {
      const { supabase, profile } = await getReadContext();
      if (profile.role === "client") throw new Error("Access denied");
      let query = supabase
        .from("inbox_notifications")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(100);
      query =
        profile.role === "admin"
          ? query.eq("kind", "client_signup")
          : query.eq("kind", "message");
      const { data, error } = await query;
      if (error) throw new Error(error.message);
      return data;
    }, false);
  }
  async function getUnreadNotificationCount() {
    return perform(async () => {
      const { supabase, profile } = await getReadContext();
      if (profile.role === "client") return 0;
      let query = supabase
        .from("inbox_notifications")
        .select("id", { count: "exact", head: true })
        .is("read_at", null)
        .is("resolved_at", null);
      query =
        profile.role === "admin"
          ? query.eq("kind", "client_signup")
          : query.eq("kind", "message");
      const { count, error } = await query;
      if (error) throw new Error(error.message);
      return count ?? 0;
    }, false);
  }
  async function getClientMessages() {
    return perform(async () => {
      const { supabase, profile } = await getReadContext();
      if (profile.role === "bidder") throw new Error("Access denied");
      const { data, error } = await supabase
        .from("client_messages")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(200);
      if (error) throw new Error(error.message);
      return data;
    }, false);
  }
  async function getFileUrl(fileId: string) {
    const parsed = z.uuid().safeParse(fileId);
    if (!parsed.success) return { error: actionErrorMessage(parsed.error) };
    const result = await getFileUrls([fileId]);
    const item = result.data?.[0];
    return item?.data
      ? {
          data: {
            url: item.data.url,
            name: item.data.name,
            mime: item.data.mime,
          },
        }
      : { error: item?.error ?? result.error ?? "File is unavailable." };
  }
  async function getFileUrls(
    input: string[],
  ): Promise<{ data?: FileUrlOutcome[]; error?: string }> {
    return perform(async () => {
      const ids = z.array(z.string()).max(100).parse(input);
      const { supabase } = await getReadContext();
      const valid = [
        ...new Set(ids.filter((id) => z.uuid().safeParse(id).success)),
      ];
      const { data: files, error } = valid.length
        ? await supabase
            .from("files")
            .select("id,storage_path,filename,mime")
            .in("id", valid)
            .eq("finalized", true)
        : { data: [], error: null };
      if (error) throw error;
      const outcomes = new Map<string, FileUrlOutcome>();
      await Promise.all(
        (files ?? []).map(async (file) => {
          try {
            const expiresAt = new Date(Date.now() + 60_000).toISOString();
            const signed = await supabase.storage
              .from("private-files")
              .createSignedUrl(file.storage_path, 60);
            outcomes.set(
              file.id,
              signed.error
                ? { id: file.id, error: "File is unavailable." }
                : {
                    id: file.id,
                    data: {
                      url: signed.data.signedUrl,
                      name: file.filename,
                      mime: file.mime,
                      expiresAt,
                    },
                  },
            );
          } catch {
            outcomes.set(file.id, {
              id: file.id,
              error: "File is unavailable.",
            });
          }
        }),
      );
      return ids.map(
        (id) =>
          outcomes.get(id) ?? {
            id,
            error: z.uuid().safeParse(id).success
              ? "File is unavailable."
              : "Invalid file ID.",
          },
      );
    });
  }
  async function getBidHistory(bidId: string) {
    return perform(async () => {
      z.uuid().parse(bidId);
      const { supabase } = await getReadContext();
      const { data, error } = await supabase
        .from("bid_events")
        .select("id,bid_id,actor_id,event,reason,file_id,created_at")
        .eq("bid_id", bidId)
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return data;
    }, false);
  }

  async function getScreenshotUploadContexts(
    input: string[],
  ): Promise<{ data?: UploadContextOutcome[]; error?: string }> {
    return perform(async () => {
      const ids = [...new Set(z.array(z.uuid()).max(100).parse(input))];
      const { supabase, profile } = await getReadContext();
      if (
        !["admin", "client"].includes(profile.role) ||
        profile.archived ||
        profile.approval_status !== "approved"
      )
        throw new Error("Access denied");

      const outcomes: UploadContextOutcome[] = new Array(ids.length);
      let next = 0;
      // Share one live actor check without fanning a page out into 100 RPCs at once.
      // Each caller-JWT RPC still enforces the existing per-file manager boundary.
      await Promise.all(
        Array.from({ length: Math.min(4, ids.length) }, async () => {
          while (next < ids.length) {
            const index = next++;
            const id = ids[index];
            try {
              const { data, error } = await supabase.rpc(
                "manager_screenshot_upload_context",
                { p_file: id },
              );
              outcomes[index] = error
                ? { id, error: "Upload details could not be loaded. Please retry." }
                : { id, data: data as UploadContext | null };
            } catch (error) {
              unstable_rethrow(error);
              if (error instanceof AuthorizationError) throw error;
              outcomes[index] = {
                id,
                error: "Upload details could not be loaded. Please retry.",
              };
            }
          }
        }),
      );
      return outcomes;
    });
  }

  async function getBidRows(
    mode: string,
    from: string,
    to: string,
    trash: boolean,
    bidderId: string | undefined,
    query: BidListQuery,
  ): Promise<BidListLoadResult> {
    // Reads deliberately do not invalidate the route (thumbnail reads must not loop).
    const startedAt = performance.now();
    let diagnostic:
      | {
          dateMode: string;
          trash: boolean;
          pageIndex: number;
          pageSize: number;
          filterCount: number;
          sortId: string;
        }
      | undefined;
    try {
      const { supabase, profile } = await getReadContext();
      const bounds = chicagoDateRange(mode, from, to);
      const filters = Object.fromEntries(
        query.columnFilters.map((filter) => {
          if (
            (filter.id === "found_at" || filter.id === "applied_at") &&
            filter.value &&
            typeof filter.value === "object" &&
            "preset" in filter.value
          ) {
            const value = filter.value as {
              preset: string;
              from?: string;
              to?: string;
              presence?: string;
            };
            if (!isCalendarPeriod(value.preset))
              throw new Error("Invalid period");
            return [
              filter.id,
              {
                ...resolveCalendarPeriod({
                  preset: value.preset,
                  from: value.from,
                  to: value.to,
                }),
                presence: value.presence,
              },
            ];
          }
          return [filter.id, filter.value];
        }),
      );
      diagnostic = {
        dateMode: isCalendarPeriod(mode) ? mode : "other",
        trash,
        pageIndex: query.pageIndex,
        pageSize: query.pageSize,
        filterCount: query.columnFilters.length,
        sortId: [
          "found_at",
          "resume_id",
          "company",
          "role_name",
          "url",
          "bidder_id",
          "source",
          "applied",
          "applied_at",
          "arrangement",
          "job_status",
          "review_status",
          "interview_scheduled",
          "screenshot",
          "screenshot_size_bytes",
        ].includes(query.sorting[0]?.id ?? "found_at")
          ? (query.sorting[0]?.id ?? "found_at")
          : "other",
      };
      const { data, error } = await supabase.rpc(BID_LIST_RPC, {
        p_query: {
          search: z.string().max(500).parse(query.search),
          status: z
            .enum(["all", "applied", "unapplied", "pending_review"])
            .parse(query.status),
          arrangement: z.string().max(20).parse(query.arrangement),
          resume: z
            .union([z.literal(""), z.literal("all"), z.uuid()])
            .parse(query.resume),
          bidder: z
            .union([z.literal(""), z.literal("all"), z.uuid()])
            .parse(query.bidder),
          source: z.string().max(200).parse(query.source),
          job: z.string().max(20).parse(query.job),
          columnFilters: filters,
          sorting: query.sorting.slice(0, 1),
          pageIndex: z.number().int().min(0).max(100000).parse(query.pageIndex),
          pageSize: z.number().int().min(1).max(100).parse(query.pageSize),
          rangeFrom: bounds.from ?? null,
          rangeTo: bounds.to ?? null,
          trash,
          scopeBidderId: bidderId ? z.uuid().parse(bidderId) : null,
        },
      });
      if (error) {
        const timedOut = error.code === "57014";
        console.info("Bid list query", {
          ...diagnostic,
          durationMs: Math.round(performance.now() - startedAt),
          outcome: timedOut ? "statement_timeout" : "database_error",
          errorCode: error.code ?? "unknown",
        });
        return {
          error: timedOut
            ? "This date range is taking too long to load. Your current results are still shown; please retry."
            : "Could not load bids. Your current results are still shown; please retry.",
          ...(timedOut ? { code: "statement_timeout" as const } : {}),
        };
      }
      const result = data as unknown as BidListResult;
      if (profile.role !== "bidder" && result.rows.length) {
        const financial = await getManagerFinancialValues(supabase, {
          bidIds: result.rows.map((row) => row.id),
        });
        result.rows = result.rows.map((row) => ({
          ...row,
          rate_cents: financial.bids[row.id] ?? null,
        }));
      }
      console.info("Bid list query", {
        ...diagnostic,
        durationMs: Math.round(performance.now() - startedAt),
        outcome: "success",
      });
      return { data: result };
    } catch (error) {
      unstable_rethrow(error);
      if (error instanceof AuthorizationError) throw error;
      console.info("Bid list query", {
        ...diagnostic,
        durationMs: Math.round(performance.now() - startedAt),
        outcome: "request_error",
        errorCode: "unknown",
      });
      return {
        error:
          "Could not load bids. Your current results are still shown; please retry.",
      };
    }
  }

  async function getPurgeStatus(operation: string) {
    return perform(async () => purgeStatus(z.uuid().parse(operation)), false);
  }
  async function recentBidPurges() {
    return perform(
      async () => (await rpc("recent_bid_purges", {})) as PurgeStatus[],
      false,
    );
  }
  return {
    getInboxNotifications,
    getUnreadNotificationCount,
    getClientMessages,
    getFileUrl,
    getFileUrls,
    getScreenshotUploadContexts,
    getBidHistory,
    getBidRows,
    getPurgeStatus,
    recentBidPurges,
  };
}
export const {
  getInboxNotifications,
  getUnreadNotificationCount,
  getClientMessages,
  getFileUrl,
  getFileUrls,
  getScreenshotUploadContexts,
  getBidHistory,
  getBidRows,
  getPurgeStatus,
  recentBidPurges,
} = createReadServices();
